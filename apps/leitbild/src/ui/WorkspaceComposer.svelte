<script lang="ts">
  import type { ModuleResourceDescriptor, WorkspaceResourceCatalog } from '@leitbild/contracts'

  interface Props {
    readonly workspaceId: string
    readonly openSettings: () => void
  }

  type CollapsedPane = 'world' | 'agents' | null

  const initialSplit = 56
  const collapseThreshold = 12
  const minimumOpenShare = 20

  let { workspaceId, openSettings }: Props = $props()
  let resources = $state<ReadonlyArray<ModuleResourceDescriptor>>([])
  let openRuns = $state<ReadonlyArray<ModuleResourceDescriptor>>([])
  let activeRunId = $state<string | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  let splitPercent = $state(initialSplit)
  let lastOpenSplit = $state(initialSplit)
  let collapsedPane = $state<CollapsedPane>(null)
  let dragging = $state(false)
  let dragLeft = 0
  let dragWidth = 1

  const simulationRuns = $derived(resources.filter(resource => resource.ref.type === 'world.simulation-run'))
  const activeRun = $derived(openRuns.find(resource => resource.ref.id === activeRunId) ?? null)
  const gridColumns = $derived(
    collapsedPane === 'world'
      ? '0 0 minmax(0, 1fr)'
      : collapsedPane === 'agents'
        ? 'minmax(0, 1fr) 0 0'
        : `minmax(0, ${splitPercent}fr) 10px minmax(0, ${100 - splitPercent}fr)`,
  )

  const loadResources = async (): Promise<void> => {
    loading = true
    error = null
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/resources`, { cache: 'no-store' })
      const body = await response.json() as WorkspaceResourceCatalog & { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message ?? `Resource discovery failed: ${response.status}`)
      resources = body.resources
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  const openSimulationRun = (resource: ModuleResourceDescriptor): void => {
    if (!openRuns.some(candidate => candidate.ref.id === resource.ref.id)) {
      openRuns = [...openRuns, resource]
    }
    activeRunId = resource.ref.id
    if (collapsedPane === 'world') restoreSplit()
  }

  const closeSimulationRun = (id: string): void => {
    const index = openRuns.findIndex(candidate => candidate.ref.id === id)
    openRuns = openRuns.filter(candidate => candidate.ref.id !== id)
    if (activeRunId !== id) return
    activeRunId = openRuns[Math.min(index, openRuns.length - 1)]?.ref.id ?? null
  }

  const showRunList = (): void => {
    activeRunId = null
    if (collapsedPane === 'world') restoreSplit()
  }

  const simulationRunPath = (id: string): string =>
    `/workspaces/${encodeURIComponent(workspaceId)}/world/runs/${encodeURIComponent(id)}`

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

  void loadResources()
</script>

<section
  class="workspace-composer"
  class:dragging
  style={`grid-template-columns: ${gridColumns}`}
>
  <section class="module-pane world-pane" class:collapsed={collapsedPane === 'world'} aria-label="World simulations">
    <nav class="simulation-tabs" aria-label="Open simulations">
      <button class:active={activeRunId === null} type="button" onclick={showRunList}>Simulations</button>
      {#each openRuns as simulationRun (simulationRun.ref.id)}
        <div class="simulation-tab" class:active={activeRunId === simulationRun.ref.id}>
          <button type="button" onclick={() => { activeRunId = simulationRun.ref.id }}>{simulationRun.title}</button>
          <button
            class="tab-close"
            type="button"
            aria-label={`Close ${simulationRun.title}`}
            onclick={() => closeSimulationRun(simulationRun.ref.id)}
          >×</button>
        </div>
      {/each}
    </nav>

    <div class="world-content">
      {#if activeRun === null}
        <section class="simulation-browser">
          <header>
            <div><p class="eyebrow">World</p><h1>Simulation Runs</h1></div>
            <button disabled={loading} onclick={() => void loadResources()}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          </header>
          {#if error}
            <p class="inline-error">{error}</p>
          {:else if loading}
            <p class="empty-state">Loading Simulation Runs…</p>
          {:else if simulationRuns.length === 0}
            <div class="empty-state">
              <p>No Simulation Runs yet.</p>
              <button type="button" onclick={openSettings}>Open World settings</button>
            </div>
          {:else}
            <div class="simulation-list">
              {#each simulationRuns as simulationRun (simulationRun.ref.id)}
                <button type="button" onclick={() => openSimulationRun(simulationRun)}>
                  <span>{simulationRun.title}</span>
                  <small>{simulationRun.ref.id}</small>
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {:else}
        {#key activeRun.ref.id}
          <iframe
            class="module-frame active"
            src={simulationRunPath(activeRun.ref.id)}
            title={`World — ${activeRun.title}`}
          ></iframe>
        {/key}
      {/if}
    </div>
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
    <iframe
      class="module-frame active"
      src={`/workspaces/${encodeURIComponent(workspaceId)}/agents`}
      title="Agents room"
    ></iframe>
  </section>

  {#if collapsedPane === 'world'}
    <button class="reopen-handle left" type="button" aria-label="Reopen World" onclick={restoreSplit}>›</button>
  {:else if collapsedPane === 'agents'}
    <button class="reopen-handle right" type="button" aria-label="Reopen Agents" onclick={restoreSplit}>‹</button>
  {/if}
</section>
