<script lang="ts">
  import { onDestroy, untrack, tick } from 'svelte'
  import type { ModuleResourceDescriptor, WorkspaceResourceReference, WorkspaceSubjectReference } from '@leitbild/contracts'
  import { createViewRelay, type WorldPane } from './view-relay.ts'
  import { createRunAssistantBridge } from './run-assistant-bridge.ts'
  import { createPresentationBridge } from './presentation-bridge.ts'
  import type { RunAssistantResolution } from './run-assistant-opening.ts'
  import { workspaceSubjectFocusMessage } from './workspace-focus.ts'
  import { createPerspectiveAssistantDelivery, type PerspectiveDeliveryScreen } from './perspective-assistant-delivery.ts'
  import { request, jsonRequest } from './api.ts'

  interface Props {
    readonly workspaceId: string
    readonly worldRunId: string | null
    readonly focusedSubjects: ReadonlyArray<WorkspaceSubjectReference>
    readonly agentsRoomId: string | null
    readonly agentsVisible: boolean
    readonly onShowAgents: () => void
    /** Why a chat display's Run may not be opened beside the chat, or null when it may. */
    readonly runRefusal: (run: WorkspaceResourceReference) => Promise<string | null>
    /** Opens a Run in a World pane beside the chat, as switching Runs does. */
    readonly onOpenRun: (runId: string) => void
    /** Whether the shown Run offers its Assistant, as the Host's own launcher does; its World page may then offer it too. */
    readonly runAssistantAvailable: boolean
    readonly restrictedRun: boolean
    readonly perspectiveAssistantAvailable: boolean
    readonly agentTemplates: ReadonlyArray<ModuleResourceDescriptor>
    /** Shows the shown Run's Assistant room, creating it where none serves the Run; it never hides the room. */
    readonly onOpenRunAssistant: (signal?: AbortSignal, assertDelivery?: () => void) => Promise<RunAssistantResolution>
    readonly onError: (message: string) => void
    /** The World pane, for overlays anchored to it (the people chat); null without a Run. */
    worldPane?: HTMLElement | null
  }

  type CollapsedPane = 'world' | 'agents' | null

  const initialSplit = 56
  const collapseThreshold = 12
  const minimumOpenShare = 20

  let {
    workspaceId, worldRunId, focusedSubjects, agentsRoomId, agentsVisible, onShowAgents, runRefusal, onOpenRun,
    runAssistantAvailable, restrictedRun, perspectiveAssistantAvailable, agentTemplates, onOpenRunAssistant, onError, worldPane = $bindable(null),
  }: Props = $props()
  let splitPercent = $state(initialSplit)
  let lastOpenSplit = $state(initialSplit)
  let collapsedPane = $state<CollapsedPane>(null)
  let dragging = $state(false)
  let dragLeft = 0
  let dragWidth = 1
  let agentsFrame = $state<HTMLIFrameElement | null>(null)
  let worldFrame = $state<HTMLIFrameElement | null>(null)
  let privateScreen = $state<PerspectiveDeliveryScreen>({ offer: null, choosing: false, busy: false, lease: null, frameUrl: null, ready: false, problem: null })
  let selectedTemplate = $state('')
  let perspectiveRunId = $state<string | null>(null)
  // A disabled pilot leaves the established shell unchanged. Once this Run
  // enters scoped mode, transient discovery failure cannot expose its old public chat.
  const perspectiveMode = $derived(restrictedRun && (perspectiveAssistantAvailable || worldRunId !== null && perspectiveRunId === worldRunId))
  const shownRoomId = $derived(perspectiveMode ? privateScreen.lease?.room.id ?? null : agentsRoomId)
  const shownAgents = $derived(perspectiveMode ? privateScreen.lease !== null : agentsVisible)
  const agentsUrl = $derived(perspectiveMode ? privateScreen.frameUrl : agentsRoomId === null ? null : `/workspaces/${encodeURIComponent(workspaceId)}/agents?room=${encodeURIComponent(agentsRoomId)}&view=focused`)
  const agentsDocumentKey = $derived(perspectiveMode ? privateScreen.lease?.documentId ?? null : null)
  // The process display window asked for the whole area and the chat was collapsed for it.
  let windowMaximised = $state(false)

  const publishResourceFocus = (): void => {
    agentsFrame?.contentWindow?.postMessage(
      workspaceSubjectFocusMessage(perspectiveMode ? privateScreen.lease ? [privateScreen.lease.perspective] : [] : focusedSubjects),
      location.origin,
    )
  }

  $effect(() => {
    focusedSubjects
    privateScreen.lease
    perspectiveMode
    publishResourceFocus()
  })

  const gridColumns = $derived(
    worldRunId === null
      ? 'minmax(0, 1fr)'
      : shownRoomId === null || !shownAgents
        ? 'minmax(0, 1fr)'
    : collapsedPane === 'world'
      ? '0 0 minmax(0, 1fr)'
      : collapsedPane === 'agents'
        ? 'minmax(0, 1fr) 0 0'
        : `minmax(0, ${splitPercent}fr) 10px minmax(0, ${100 - splitPercent}fr)`,
  )

  const beginResize = (event: PointerEvent): void => {
    if (!(event.currentTarget instanceof HTMLElement)) return
    const composer = event.currentTarget.parentElement
    if (!(composer instanceof HTMLElement)) return
    const rect = composer.getBoundingClientRect()
    dragLeft = rect.left
    dragWidth = rect.width
    dragging = true
    collapsedPane = null
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const resize = (event: PointerEvent): void => {
    if (!dragging) return
    splitPercent = Math.max(0, Math.min(100, ((event.clientX - dragLeft) / dragWidth) * 100))
  }

  const finishResize = (event: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (splitPercent <= collapseThreshold) {
      collapsedPane = 'world'
      return
    }
    if (splitPercent >= 100 - collapseThreshold) {
      collapsedPane = 'agents'
      return
    }
    splitPercent = Math.max(minimumOpenShare, Math.min(100 - minimumOpenShare, splitPercent))
    lastOpenSplit = splitPercent
  }

  const restoreSplit = (): void => {
    collapsedPane = null
    splitPercent = lastOpenSplit
    windowMaximised = false
  }

  // Only a chat shown beside the World pane is collapsed for the window, and
  // restoring undoes only that collapse.
  const maximiseWorld = (maximised: boolean): void => {
    if (maximised) {
      if (worldRunId === null || shownRoomId === null || !shownAgents || collapsedPane !== null) return
      collapsedPane = 'agents'
      windowMaximised = true
      return
    }
    if (!windowMaximised) return
    windowMaximised = false
    if (collapsedPane === 'agents') restoreSplit()
  }

  // Relay state stays in the relay's plain closure, never in $state: a Svelte
  // proxy cannot be posted to a frame (see workspace-focus.ts).
  const relay = createViewRelay({
    workspaceId: () => workspaceId,
    worldPane: (): WorldPane => worldRunId === null ? 'absent' : collapsedPane === 'world' ? 'collapsed' : 'shown',
    runRefusal: run => runRefusal(run),
    postToWorld: message => worldFrame?.contentWindow?.postMessage(message, location.origin),
    postToAgents: message => agentsFrame?.contentWindow?.postMessage(message, location.origin),
    showWorld: () => restoreSplit(),
    maximiseWorld,
    openRun: runId => onOpenRun(runId),
    reportError: message => onError(message),
    startTimer: (ms, expire) => {
      const timer = setTimeout(expire, ms)
      return () => clearTimeout(timer)
    },
  })
  onDestroy(() => relay.dispose())

  // The World page asks for the Run's Assistant room; like the relay, the
  // bridge keeps its state in a plain closure.
  const assistantBridge = createRunAssistantBridge({
    workspaceId: () => workspaceId,
    worldRunId: () => worldRunId,
    available: () => runAssistantAvailable,
    postToWorld: message => worldFrame?.contentWindow?.postMessage(message, location.origin),
    openAssistant: async () => { await onOpenRunAssistant() },
    showAgents: () => { if (collapsedPane === 'agents') restoreSplit() },
    reportError: message => onError(message),
  })

  const privateDelivery = createPerspectiveAssistantDelivery({
    workspaceId: () => workspaceId, available: () => perspectiveAssistantAvailable,
    uuid: () => crypto.randomUUID(), now: () => Date.now(),
    timer: (ms, action) => { const timer = setTimeout(action, ms); return () => clearTimeout(timer) },
    request: (path, body, signal) => request(path, { ...jsonRequest('POST', body), signal }),
    postWorld: message => worldFrame?.contentWindow?.postMessage(message, location.origin),
    postAgents: message => agentsFrame?.contentWindow?.postMessage(message, location.origin),
    changed: screen => {
      privateScreen = screen
      if (perspectiveMode) presentation.fromWorld({ type: 'leitbild:presentation-offer', recipient: screen.offer?.recipient ?? null })
    },
  })
  export const requestPerspectiveAssistant = (): void => privateDelivery.request()
  onDestroy(() => privateDelivery.dispose())

  const roomReference = (): WorkspaceResourceReference | null => perspectiveMode ? privateScreen.lease?.room ?? null : agentsRoomId === null ? null : { workspaceId, moduleId: 'agents', type: 'agents.room', id: agentsRoomId } as WorkspaceResourceReference
  const presentation = createPresentationBridge({
    subject: () => perspectiveMode ? privateScreen.offer?.recipient?.subject ?? null : worldRunId === null ? null : { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: worldRunId } as WorkspaceResourceReference,
    room: roomReference,
    openAssistant: async (signal, assertDelivery) => {
      assertDelivery()
      if (perspectiveMode) {
        const room = privateScreen.lease?.room
        if (!room) throw new Error('The current scoped Assistant view is unavailable')
        if (collapsedPane === 'agents') restoreSplit()
        return room
      }
      if (!runAssistantAvailable) throw new Error('This Run offers no Assistant')
      const expectedRun = worldRunId, expectedWorkspace = workspaceId
      const resolved = await onOpenRunAssistant(signal, assertDelivery)
      await tick()
      signal.throwIfAborted()
      assertDelivery()
      if (workspaceId !== expectedWorkspace || worldRunId !== expectedRun || resolved.run.workspaceId !== expectedWorkspace || resolved.run.moduleId !== 'world' || resolved.run.type !== 'world.simulation-run' || resolved.run.id !== expectedRun) throw new Error('The Run changed while its Assistant was opening')
      const room = resolved.room
      if (room.workspaceId !== expectedWorkspace || room.moduleId !== 'agents' || room.type !== 'agents.room' || agentsRoomId !== room.id) throw new Error('The resolved Run Assistant Room is no longer the one shown')
      onShowAgents()
      if (collapsedPane === 'agents') restoreSplit()
      return room
    },
    postToWorld: message => worldFrame?.contentWindow?.postMessage(message, location.origin),
    postToAgents: message => agentsFrame?.contentWindow?.postMessage(message, location.origin),
    error: message => onError(message),
    timer: (ms, action) => { const timer = setTimeout(action, ms); return () => clearTimeout(timer) },
  })
  onDestroy(() => presentation.dispose())

  // The World document that last said it listens; a frame that loads another
  // document (a reload, or the World start page) no longer listens.
  let listeningWorldDocument: Document | null = null
  let loadedAgentsDocument: Document | null = null
  const acceptAgentsDocument = (): boolean => {
    const document = agentsFrame?.contentDocument ?? null
    if (document === null) return false
    if (document === loadedAgentsDocument) return true
    const replaced = loadedAgentsDocument !== null
    loadedAgentsDocument = document
    privateDelivery.agentsLoaded(replaced)
    presentation.agentsLoaded()
    return !replaced
  }

  // Only the two frames' own documents take part in the window's protocol.
  const receiveViewMessage = (event: MessageEvent): void => {
    if (event.origin !== location.origin || event.source === null) return
    if (event.source === agentsFrame?.contentWindow) {
      if (perspectiveMode) {
        if (!acceptAgentsDocument()) return
        if (privateDelivery.fromAgents(event.data)) {
          publishResourceFocus()
          presentation.fromAgents({ type: 'leitbild:presentation-ready', room: privateScreen.lease?.room })
        } else if (privateScreen.ready) presentation.fromAgents(event.data)
      } else { relay.fromAgents(event.data); presentation.fromAgents(event.data) }
    }
    else if (event.source === worldFrame?.contentWindow) {
      if ((event.data as { readonly type?: unknown } | null)?.type === 'leitbild:view-window-ready') listeningWorldDocument = worldFrame?.contentDocument ?? null
      relay.fromWorld(event.data)
      assistantBridge.fromWorld(event.data)
      if ((event.data as { readonly type?: unknown } | null)?.type === 'leitbild:view-window-ready') privateDelivery.availabilityChanged()
      privateDelivery.fromWorld(event.data)
      // The canonical human Guide receiver coexists with the private receiver.
      // Private offers are delivered above; canonical offers cannot replace them.
      if (!perspectiveMode || (event.data as { readonly type?: unknown } | null)?.type !== 'leitbild:presentation-offer') presentation.fromWorld(event.data)
    }
  }

  // World says it listens as its route mounts, which can be before or after the
  // frame's load event: only a load of a document other than the listening one ends it.
  const worldFrameLoaded = (): void => {
    if (worldFrame?.contentDocument === listeningWorldDocument) return
    listeningWorldDocument = null
    relay.worldFrameUnloaded()
    assistantBridge.worldFrameUnloaded()
    presentation.worldUnloaded()
    privateDelivery.worldUnloaded()
  }

  // A new Run gives the World frame a new document (or none), which listens only
  // once it says so. World says so as its route mounts, which can be before the
  // frame's load event, so readiness is reset here rather than on load.
  $effect(() => {
    worldRunId
    untrack(() => {
      perspectiveRunId = perspectiveAssistantAvailable ? worldRunId : null
      relay.worldFrameUnloaded()
      assistantBridge.worldFrameUnloaded()
    presentation.worldUnloaded()
      privateDelivery.worldUnloaded()
    })
  })

  // Declared after the Run's effect, so a new Run's availability never reaches the previous Run's document.
  $effect(() => {
    runAssistantAvailable
    untrack(() => assistantBridge.availabilityChanged())
  })
  $effect(() => {
    perspectiveAssistantAvailable
    untrack(() => {
      if (perspectiveAssistantAvailable) perspectiveRunId = worldRunId
      privateDelivery.availabilityChanged()
    })
  })

  // Another Room or a closed chat ends the Agents document that listed the displays.
  $effect(() => {
    shownRoomId
    agentsDocumentKey
    untrack(() => { loadedAgentsDocument = null; relay.agentsFrameUnloaded(); presentation.agentsUnloaded() })
  })

  const agentsFrameLoaded = (): void => {
    if (perspectiveMode) {
      acceptAgentsDocument()
      return
    }
    publishResourceFocus()
    relay.agentsFrameLoaded()
    presentation.agentsLoaded()
  }

  const resizeWithKeyboard = (event: KeyboardEvent): void => {
    if (event.key === 'Home') {
      collapsedPane = 'world'
      event.preventDefault()
      return
    }
    if (event.key === 'End') {
      collapsedPane = 'agents'
      event.preventDefault()
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    collapsedPane = null
    splitPercent = Math.max(
      minimumOpenShare,
      Math.min(100 - minimumOpenShare, splitPercent + (event.key === 'ArrowLeft' ? -5 : 5)),
    )
    lastOpenSplit = splitPercent
    event.preventDefault()
  }
</script>

<svelte:window onmessage={receiveViewMessage} />

<section
  class="workspace-composer"
  class:dragging
  class:window-maximised={windowMaximised}
  style={`grid-template-columns: ${gridColumns}`}
>
  {#if worldRunId !== null}<section bind:this={worldPane} class="module-pane world-pane" class:collapsed={collapsedPane === 'world'} aria-label="World simulations">
    <iframe
      bind:this={worldFrame}
      class="module-frame active"
      src={`/workspaces/${encodeURIComponent(workspaceId)}/world/runs/${encodeURIComponent(worldRunId)}`}
      title="World simulations"
      onload={worldFrameLoaded}
    ></iframe>
  </section>{/if}

  {#if worldRunId !== null && shownRoomId !== null && shownAgents}<button
    class="split-handle"
    class:hidden={collapsedPane !== null}
    type="button"
    aria-label="Resize World and Agents"
    onpointerdown={beginResize}
    onpointermove={resize}
    onpointerup={finishResize}
    onpointercancel={finishResize}
    onkeydown={resizeWithKeyboard}
  ><span></span></button>{/if}

  {#if shownRoomId !== null && agentsUrl !== null}<section class="module-pane agents-pane" class:hidden-pane={!shownAgents} class:collapsed={collapsedPane === 'agents'} aria-label={perspectiveMode ? 'Scoped Assistant conversation' : 'Agents room'}>
    <iframe
      bind:this={agentsFrame}
      class="module-frame active"
      src={agentsUrl}
      title={perspectiveMode ? 'Scoped Assistant conversation' : 'Agents room'}
      onload={agentsFrameLoaded}
    ></iframe>
  </section>{/if}

  {#if collapsedPane === 'world'}
    <button class="reopen-handle left" type="button" aria-label="Reopen World" onclick={restoreSplit}>›</button>
  {:else if collapsedPane === 'agents'}
    <button class="reopen-handle right" type="button" aria-label="Reopen Agents" onclick={restoreSplit}>‹</button>
  {/if}
  {#if worldRunId !== null && shownRoomId !== null && !shownAgents}
    <button class="reopen-handle right" type="button" aria-label="Show Agents" onclick={onShowAgents}>‹</button>
  {/if}
  {#if perspectiveAssistantAvailable && (privateScreen.choosing || privateScreen.problem)}
    <aside class="perspective-setup" aria-label="Set up scoped Assistant">
      <strong>Assistant for {privateScreen.offer?.roleLabels.join(' + ') || 'these roles'}</strong>
      {#if privateScreen.choosing}
        <p>Choose a template for a fresh, private conversation. Its configuration is captured for this scope.</p>
        {#if agentTemplates.length > 0}
          <label>Agent template <select bind:value={selectedTemplate} disabled={privateScreen.busy}>
            <option value="" disabled>Choose a template…</option>
            {#each agentTemplates as template (template.ref.id)}<option value={template.ref.id}>{template.title}</option>{/each}
          </select></label>
          <button disabled={!selectedTemplate || privateScreen.busy} onclick={() => void privateDelivery.choose(selectedTemplate)}>{privateScreen.busy ? 'Connecting…' : 'Use template'}</button>
        {:else}<p>Create an Agent profile in Agents, then return here to choose it.</p>{/if}
      {/if}
      {#if privateScreen.problem}<p role="alert">{privateScreen.problem}</p>
        {#if !privateScreen.choosing}<button onclick={() => privateDelivery.retryView()}>Retry current view</button>{/if}
      {/if}
    </aside>
  {/if}
</section>

<style>
  .perspective-setup { position: absolute; z-index: 8; inset: auto 1rem 1rem auto; max-width: 28rem; padding: 1rem; border: 1px solid #566273; border-radius: .6rem; color: #f1f5f9; background: #182330f5; box-shadow: 0 5px 24px #0005; }
  .perspective-setup p { margin: .5rem 0; }
  .perspective-setup label { display: grid; gap: .35rem; margin: .75rem 0; }
  .perspective-setup select, .perspective-setup button { padding: .45rem .65rem; }
</style>
