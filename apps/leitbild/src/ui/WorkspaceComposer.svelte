<script lang="ts">
  interface Props {
    readonly workspaceId: string
    readonly worldRunId: string | null
    readonly agentsRoomId: string | null
    readonly companionLoading: boolean
    readonly companionError: string | null
    readonly retryCompanion: () => Promise<void>
  }

  type CollapsedPane = 'world' | 'agents' | null

  const initialSplit = 56
  const collapseThreshold = 12
  const minimumOpenShare = 20

  let { workspaceId, worldRunId, agentsRoomId, companionLoading, companionError, retryCompanion }: Props = $props()
  let splitPercent = $state(initialSplit)
  let lastOpenSplit = $state(initialSplit)
  let collapsedPane = $state<CollapsedPane>(null)
  let dragging = $state(false)
  let dragLeft = 0
  let dragWidth = 1

  const gridColumns = $derived(
    collapsedPane === 'world'
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
  <section class="module-pane world-pane" class:collapsed={collapsedPane === 'world'} aria-label="World simulations">
    <iframe
      class="module-frame active"
      src={worldRunId === null
        ? `/workspaces/${encodeURIComponent(workspaceId)}/world`
        : `/workspaces/${encodeURIComponent(workspaceId)}/world/runs/${encodeURIComponent(worldRunId)}`}
      title="World simulations"
    ></iframe>
  </section>

  <button
    class="split-handle"
    class:hidden={collapsedPane !== null}
    type="button"
    aria-label="Resize World and Agents"
    onpointerdown={beginResize}
    onpointermove={resize}
    onpointerup={finishResize}
    onpointercancel={finishResize}
    onkeydown={resizeWithKeyboard}
  ><span></span></button>

  <section class="module-pane agents-pane" class:collapsed={collapsedPane === 'agents'} aria-label="Agents room">
    {#if companionLoading || companionError}
      <div class="companion-status" role="status">
        {#if companionLoading}
          <p>Opening your simulation conversation…</p>
        {:else}
          <p>{companionError}</p>
          <button onclick={retryCompanion}>Retry room setup</button>
          <a href={`/workspaces/${encodeURIComponent(workspaceId)}`}>Back to workspace</a>
        {/if}
      </div>
    {:else}
    <iframe
      class="module-frame active"
      src={agentsRoomId === null
        ? `/workspaces/${encodeURIComponent(workspaceId)}/agents`
        : `/workspaces/${encodeURIComponent(workspaceId)}/agents?room=${encodeURIComponent(agentsRoomId)}`}
      title="Agents room"
    ></iframe>
    {/if}
  </section>

  {#if collapsedPane === 'world'}
    <button class="reopen-handle left" type="button" aria-label="Reopen World" onclick={restoreSplit}>›</button>
  {:else if collapsedPane === 'agents'}
    <button class="reopen-handle right" type="button" aria-label="Reopen Agents" onclick={restoreSplit}>‹</button>
  {/if}
</section>

<style>
  .companion-status { height: 100%; display: flex; flex-direction: column; gap: 1rem; align-items: center; justify-content: center; padding: 2rem; text-align: center; }
</style>
