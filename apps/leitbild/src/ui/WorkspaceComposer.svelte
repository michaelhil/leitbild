<script lang="ts">
  import type { WorkspaceSubjectReference } from '@leitbild/contracts'
  import { workspaceSubjectFocusMessage } from './workspace-focus.ts'

  interface Props {
    readonly workspaceId: string
    readonly worldRunId: string | null
    readonly focusedSubjects: ReadonlyArray<WorkspaceSubjectReference>
    readonly agentsRoomId: string | null
    readonly agentsVisible: boolean
    readonly onShowAgents: () => void
  }

  type CollapsedPane = 'world' | 'agents' | null

  const initialSplit = 56
  const collapseThreshold = 12
  const minimumOpenShare = 20

  let { workspaceId, worldRunId, focusedSubjects, agentsRoomId, agentsVisible, onShowAgents }: Props = $props()
  let splitPercent = $state(initialSplit)
  let lastOpenSplit = $state(initialSplit)
  let collapsedPane = $state<CollapsedPane>(null)
  let dragging = $state(false)
  let dragLeft = 0
  let dragWidth = 1
  let agentsFrame = $state<HTMLIFrameElement | null>(null)

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
    worldRunId === null
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

<section
  class="workspace-composer"
  class:dragging
  style={`grid-template-columns: ${gridColumns}`}
>
  {#if worldRunId !== null}<section class="module-pane world-pane" class:collapsed={collapsedPane === 'world'} aria-label="World simulations">
    <iframe
      class="module-frame active"
      src={`/workspaces/${encodeURIComponent(workspaceId)}/world/runs/${encodeURIComponent(worldRunId)}`}
      title="World simulations"
    ></iframe>
  </section>{/if}

  {#if worldRunId !== null && agentsRoomId !== null && agentsVisible}<button
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

  {#if agentsRoomId !== null}<section class="module-pane agents-pane" class:hidden-pane={!agentsVisible} class:collapsed={collapsedPane === 'agents'} aria-label="Agents room">
    <iframe
      bind:this={agentsFrame}
      class="module-frame active"
      src={`/workspaces/${encodeURIComponent(workspaceId)}/agents?room=${encodeURIComponent(agentsRoomId)}&view=focused`}
      title="Agents room"
      onload={publishResourceFocus}
    ></iframe>
  </section>{/if}

  {#if collapsedPane === 'world'}
    <button class="reopen-handle left" type="button" aria-label="Reopen World" onclick={restoreSplit}>›</button>
  {:else if collapsedPane === 'agents'}
    <button class="reopen-handle right" type="button" aria-label="Reopen Agents" onclick={restoreSplit}>‹</button>
  {/if}
  {#if worldRunId !== null && agentsRoomId !== null && !agentsVisible}
    <button class="reopen-handle right" type="button" aria-label="Show Agents" onclick={onShowAgents}>‹</button>
  {/if}
</section>
