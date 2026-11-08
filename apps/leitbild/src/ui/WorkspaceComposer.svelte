<script lang="ts">
  import { onDestroy, untrack, tick } from 'svelte'
  import type { EmbeddedViewListing, WorkspaceResourceReference, WorkspaceSubjectReference } from '@leitbild/contracts'
  import { embeddedViewFragment, embeddedViewPath } from '@leitbild/contracts/embedded-view-route'
  import Modal from './Modal.svelte'
  import { closeEmbeddedViewOnEscape } from './embedded-view-keyboard.ts'
  import { createViewRelay, type WorldPane } from './view-relay.ts'
  import { createRunAssistantBridge } from './run-assistant-bridge.ts'
  import { createPresentationBridge } from './presentation-bridge.ts'
  import type { RunAssistantResolution } from './run-assistant-opening.ts'
  import { workspaceSubjectFocusMessage } from './workspace-focus.ts'
  import { isCurrentResourceCatalogChange } from './resource-catalog-message.ts'

  interface Props {
    readonly workspaceId: string
    readonly worldRunId: string | null
    readonly planningPath?: string | null
    readonly planningResource?: WorkspaceResourceReference | null
    readonly onResourceCatalogChange: () => void
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
    workspaceId, worldRunId, planningPath = null, planningResource = null, onResourceCatalogChange, focusedSubjects, agentsRoomId, agentsVisible, onShowAgents, runRefusal, onOpenRun,
    runAssistantAvailable, onOpenRunAssistant, onError, worldPane = $bindable(null),
  }: Props = $props()
  let splitPercent = $state(initialSplit)
  let lastOpenSplit = $state(initialSplit)
  let collapsedPane = $state<CollapsedPane>(null)
  let dragging = $state(false)
  let dragLeft = 0
  let dragWidth = 1
  let agentsFrame = $state<HTMLIFrameElement | null>(null)
  let worldFrame = $state<HTMLIFrameElement | null>(null)
  let planningFrame = $state<HTMLIFrameElement | null>(null)
  let ownedView = $state<EmbeddedViewListing | null>(null)
  let ownedViewOpen = $state(false)
  const primaryOpen = $derived(planningPath !== null || worldRunId !== null)
  // The process display window asked for the whole area and the chat was collapsed for it.
  let windowMaximised = $state(false)

  const publishResourceFocus = (): void => {
    agentsFrame?.contentWindow?.postMessage(
      workspaceSubjectFocusMessage(focusedSubjects),
      location.origin,
    )
  }

  $effect(() => {
    focusedSubjects
    publishResourceFocus()
  })

  const gridColumns = $derived(
    !primaryOpen
      ? 'minmax(0, 1fr)'
      : agentsRoomId === null || !agentsVisible
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
      if (planningPath !== null || worldRunId === null || agentsRoomId === null || !agentsVisible || collapsedPane !== null) return
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
    worldPane: (): WorldPane => planningPath !== null || worldRunId === null ? 'absent' : collapsedPane === 'world' ? 'collapsed' : 'shown',
    runRefusal: run => runRefusal(run),
    postToWorld: message => worldFrame?.contentWindow?.postMessage(message, location.origin),
    postToAgents: message => agentsFrame?.contentWindow?.postMessage(message, location.origin),
    showWorld: () => restoreSplit(),
    maximiseWorld,
    openRun: runId => onOpenRun(runId),
    openOwnedView: view => { ownedView = view; ownedViewOpen = view !== null },
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

  const roomReference = (): WorkspaceResourceReference | null => agentsRoomId === null ? null : { workspaceId, moduleId: 'agents', type: 'agents.room', id: agentsRoomId } as WorkspaceResourceReference
  const presentation = createPresentationBridge({
    subject: () => worldRunId === null ? null : { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: worldRunId } as WorkspaceResourceReference,
    room: roomReference,
    openAssistant: async (signal, assertDelivery) => {
      assertDelivery()
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

  // Only the active Module frames take part in the window's protocol.
  const receiveViewMessage = (event: MessageEvent): void => {
    if (event.origin !== location.origin || event.source === null) return
    if (planningPath !== null && isCurrentResourceCatalogChange(event, {
      origin: location.origin, source: planningFrame?.contentWindow ?? null, resource: planningResource,
    })) onResourceCatalogChange()
    if (event.source === agentsFrame?.contentWindow) { relay.fromAgents(event.data); presentation.fromAgents(event.data) }
    else if (event.source === worldFrame?.contentWindow) {
      if ((event.data as { readonly type?: unknown } | null)?.type === 'leitbild:view-window-ready') listeningWorldDocument = worldFrame?.contentDocument ?? null
      relay.fromWorld(event.data)
      assistantBridge.fromWorld(event.data)
      presentation.fromWorld(event.data)
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
  }

  // A new Run gives the World frame a new document (or none), which listens only
  // once it says so. World says so as its route mounts, which can be before the
  // frame's load event, so readiness is reset here rather than on load.
  $effect(() => {
    worldRunId
    untrack(() => {
      relay.worldFrameUnloaded()
      assistantBridge.worldFrameUnloaded()
    presentation.worldUnloaded()
    })
  })

  // Declared after the Run's effect, so a new Run's availability never reaches the previous Run's document.
  $effect(() => {
    runAssistantAvailable
    untrack(() => assistantBridge.availabilityChanged())
  })

  // Another Workspace, Room or a closed chat ends the Agents document that listed the displays.
  $effect(() => {
    workspaceId
    agentsRoomId
    untrack(() => { relay.agentsFrameUnloaded(); presentation.agentsUnloaded() })
  })

  const agentsFrameLoaded = (): void => {
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
  {#if primaryOpen}<section bind:this={worldPane} class="module-pane world-pane" class:collapsed={collapsedPane === 'world'} aria-label={planningPath !== null ? 'Planning Study' : 'World simulations'}>
    {#if planningPath !== null}
    <iframe bind:this={planningFrame} class="module-frame active" src={planningPath} title="Planning laboratory"></iframe>
    {:else if worldRunId !== null}
    <iframe
      bind:this={worldFrame}
      class="module-frame active"
      src={`/workspaces/${encodeURIComponent(workspaceId)}/world/runs/${encodeURIComponent(worldRunId)}`}
      title="World simulations"
      onload={worldFrameLoaded}
    ></iframe>
    {/if}
  </section>{/if}

  {#if primaryOpen && agentsRoomId !== null && agentsVisible}<button
    class="split-handle"
    class:hidden={collapsedPane !== null}
    type="button"
    aria-label={planningPath !== null ? 'Resize Planning and Agents' : 'Resize World and Agents'}
    onpointerdown={beginResize}
    onpointermove={resize}
    onpointerup={finishResize}
    onpointercancel={finishResize}
    onkeydown={resizeWithKeyboard}
  ><span></span></button>{/if}

  {#if agentsRoomId !== null}<section class="module-pane agents-pane" class:hidden-pane={!agentsVisible} class:collapsed={collapsedPane === 'agents'} aria-label="Agents room">
    <iframe
      bind:this={agentsFrame}
      class="module-frame active"
      src={`/workspaces/${encodeURIComponent(workspaceId)}/agents?room=${encodeURIComponent(agentsRoomId)}&view=focused`}
      title="Agents room"
      onload={agentsFrameLoaded}
    ></iframe>
  </section>{/if}

  {#if collapsedPane === 'world'}
    <button class="reopen-handle left" type="button" aria-label={planningPath !== null ? 'Reopen Planning' : 'Reopen World'} onclick={restoreSplit}>›</button>
  {:else if collapsedPane === 'agents'}
    <button class="reopen-handle right" type="button" aria-label="Reopen Agents" onclick={restoreSplit}>‹</button>
  {/if}
  {#if primaryOpen && agentsRoomId !== null && !agentsVisible}
    <button class="reopen-handle right" type="button" aria-label="Show Agents" onclick={onShowAgents}>‹</button>
  {/if}
</section>

<Modal bind:open={ownedViewOpen} title={ownedView?.envelope.title ?? 'Display'} eyebrow={ownedView?.caption ?? ''}
  width="1100px" height="820px" scrollBody={false} closeLabel="Close display"
  onclose={() => { ownedView = null }}>
  {#if ownedView}
    <iframe class="owned-view-frame" title={ownedView.envelope.title}
      use:closeEmbeddedViewOnEscape={() => { ownedViewOpen = false }}
      src={embeddedViewPath(ownedView.envelope) + embeddedViewFragment(ownedView.envelope)}
      allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
      referrerpolicy="same-origin"></iframe>
  {/if}
</Modal>

<style>
  .owned-view-frame { display: block; width: 100%; height: 100%; border: 0; }
</style>
