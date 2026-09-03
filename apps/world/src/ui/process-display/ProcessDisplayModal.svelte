<script lang="ts">
  import { untrack } from 'svelte'
  import { ClipboardList, Eye, Play, Timer, X, Zap } from 'lucide-svelte'
  import type { SimulationRunId, OperationalObject } from '../../core/model/index.ts'
  import { processPlantActionInvokeCommandKind } from '../../packs/process-plant/command-kinds.ts'
  import type { CompiledProcessDisplay, ProcessDisplayValue } from '../../packs/process-plant/displays/index.ts'
  import { statusToneColor } from '../status-presentation.ts'
  import { invokeSimulationRunCapability } from '../simulation-run-client.ts'
  import ProcedureRunBadges from '../procedures/ProcedureRunBadges.svelte'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../procedures/procedure-run-selectors.ts'
  import ProcessDisplayRenderer from './ProcessDisplayRenderer.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import { createProcessDisplaySession } from './process-display-session.ts'
  import {
    emptyProcessDisplayAlarmSnapshot,
    readProcessPlantCatalog,
    readProcessDisplayProjection,
    processPlantIdForObject,
    type ProcessDisplayProjection,
    type ProcessDisplayLensOption,
    type ProcessPlantActionCatalogEntry,
    type ProcessDisplaySnapshot,
  } from './process-display-client.ts'
  import type { ProcessDisplayAlarmSnapshot } from '../../packs/process-plant/displays/index.ts'
  import {
    readProcessDisplayLayout,
    readProcessDisplayWindowBounds,
    storeProcessDisplayLayout,
    storeProcessDisplayWindowBounds,
    type ProcessDisplayLayout,
    type ProcessDisplayWindowBounds,
    type ProcessDisplayWidgetPosition,
  } from './process-display-layout.ts'
  import {
    floatingWindowBoundsForDrag,
    normalizeFloatingWindowBounds,
    type FloatingWindowDragMode,
  } from '../window-bounds.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly object: OperationalObject
    readonly procedureSummaries?: ProcedureRunSummaryGroup
    readonly windowOffsetIndex?: number
    readonly openProcedureSystemAt: (summary?: ProcedureRunSummary) => void
    readonly openAcceleration: () => void
    readonly accelerationRunning?: boolean
    readonly close: () => void
  }

  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], completed: [] }

  let {
    simulationRunId,
    object,
    procedureSummaries = emptyProcedureRunSummaries,
    windowOffsetIndex = 0,
    openProcedureSystemAt,
    openAcceleration,
    accelerationRunning = false,
    close,
  }: Props = $props()

  interface WindowDragState {
    readonly pointerId: number
    readonly mode: FloatingWindowDragMode
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: ProcessDisplayWindowBounds
  }

  const minWindowWidth = 48
  const minWindowHeight = 32
  const viewportMargin = 12
  const windowOffsetStepPx = 28

  let loading = $state(true)
  let error = $state<string | null>(null)
  let refreshError = $state<string | null>(null)
  let display = $state<CompiledProcessDisplay | null>(null)
  let values = $state<ReadonlyMap<string, ProcessDisplayValue>>(new Map())
  let alarms = $state<ProcessDisplayAlarmSnapshot>(emptyProcessDisplayAlarmSnapshot)
  let projection = $state<ProcessDisplayProjection | null>(null)
  let activeLensId = $state<string>('all')
  let lensMenuOpen = $state(false)
  let transientModalOpen = $state(false)
  let transientRunningId = $state<string | null>(null)
  let availableActions = $state<ReadonlyArray<ProcessPlantActionCatalogEntry> | null>(null)
  let actionsLoading = $state(false)
  let actionsError = $state<string | null>(null)
  let transientInputs = $state<Record<string, Record<string, number>>>({})
  let widgetPositions = $state<ProcessDisplayLayout>({})
  let loadedPlantId = $state<string | null>(null)
  let windowBounds = $state<ProcessDisplayWindowBounds>({ x: 72, y: 72, width: 1120, height: 720 })
  let windowDragState = $state<WindowDragState | null>(null)
  let disposed = false
  let lensRequest = 0

  const defaultWindowBounds = (): ProcessDisplayWindowBounds => {
    if (typeof window === 'undefined') return windowBounds
    const width = Math.max(minWindowWidth, Math.min(1180, window.innerWidth - 2 * viewportMargin))
    const height = Math.max(minWindowHeight, Math.min(760, window.innerHeight - 2 * viewportMargin))
    const offset = windowOffsetIndex * windowOffsetStepPx
    return {
      x: Math.max(viewportMargin, Math.round((window.innerWidth - width) / 2) + offset),
      y: Math.max(viewportMargin, Math.round((window.innerHeight - height) / 2) + offset),
      width,
      height,
    }
  }

  const clampWindowBounds = (bounds: ProcessDisplayWindowBounds): ProcessDisplayWindowBounds => {
    if (typeof window === 'undefined') return bounds
    return normalizeFloatingWindowBounds(bounds, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, {
      minWidth: minWindowWidth,
      minHeight: minWindowHeight,
      margin: viewportMargin,
    })
  }

  const plantIdFor = (candidate: OperationalObject): string => {
    const plantId = processPlantIdForObject(candidate)
    if (plantId === null) throw new Error('process display requires a valid Process Plant object')
    return plantId
  }
  const processDisplayPlantId = untrack(() => plantIdFor(object))
  const processDisplayRunId = untrack(() => simulationRunId)

  const applySnapshot = (snapshot: ProcessDisplaySnapshot): void => {
    values = new Map(snapshot.values.map(value => [value.path, value]))
    alarms = snapshot.alarms
  }
  const session = createProcessDisplaySession({
    runId: processDisplayRunId,
    plantId: processDisplayPlantId,
    onSnapshot: applySnapshot,
    onRefreshError: (message) => { refreshError = message },
  })

  const loadActions = async (): Promise<void> => {
    if (disposed || actionsLoading || availableActions !== null) return
    actionsLoading = true
    actionsError = null
    try {
      const catalog = await readProcessPlantCatalog(processDisplayRunId)
      if (disposed) return
      availableActions = catalog.actions
      transientInputs = Object.fromEntries(catalog.actions.map(action => [
        action.id,
        Object.fromEntries(action.parameters.map(parameter => [parameter.id, parameter.defaultValue])),
      ]))
    } catch (err) {
      if (!disposed) actionsError = err instanceof Error ? err.message : String(err)
    } finally {
      if (!disposed) actionsLoading = false
    }
  }

  const visibleWidgetIds = $derived(projection
    ? new Set<string>(projection.displayProjection.visibleWidgetIds)
    : null)

  const visiblePathIds = $derived(projection
    ? new Set<string>(projection.displayProjection.visiblePathIds)
    : null)

  const lensOptions = $derived<ReadonlyArray<ProcessDisplayLensOption>>(display?.lenses ?? [])

  const assetStatusColor = $derived(statusToneColor(
    object.operational.priority === 'critical'
      ? 'error'
      : object.operational.priority === 'high'
        ? 'working'
        : object.operational.status === 'normal'
          ? 'ready'
          : 'idle',
  ))

  const openProcedureSummary = (summary: ProcedureRunSummary): void => openProcedureSystemAt(summary)

  const updateTransientInput = (config: {
    readonly transientId: string
    readonly fieldId: string
    readonly value: number
  }): void => {
    transientInputs = {
      ...transientInputs,
      [config.transientId]: {
        ...(transientInputs[config.transientId] ?? {}),
        [config.fieldId]: config.value,
      },
    }
  }

  const runDemoTransient = async (transient: ProcessPlantActionCatalogEntry): Promise<void> => {
    if (transientRunningId !== null) return
    const plantId = loadedPlantId ?? plantIdFor(object)
    transientModalOpen = false
    transientRunningId = transient.id
    error = null
    try {
      const response = await invokeSimulationRunCapability(simulationRunId, {
        capabilityId: processPlantActionInvokeCommandKind,
        input: {
          plantId,
          actionId: transient.id,
          parameters: transientInputs[transient.id] ?? {},
        },
      })
      if (response.kind !== 'command') throw new Error(`${processPlantActionInvokeCommandKind} is not a command`)
      if (!response.result.ok) {
        throw new Error(response.result.reason ?? `process plant rejected ${transient.id}`)
      }
      await session.refresh()
    } catch (err) {
      if (!disposed) error = `${transient.title} failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      if (!disposed) transientRunningId = null
    }
  }

  const commitWindowBounds = (bounds: ProcessDisplayWindowBounds): void => {
    const currentDisplay = display
    const plantId = loadedPlantId
    if (!currentDisplay || !plantId) return
    storeProcessDisplayWindowBounds({
      simulationRunId,
      plantId,
      displayId: currentDisplay.id,
      bounds,
    })
  }

  const nextBoundsForDrag = (
    drag: WindowDragState,
    event: PointerEvent,
  ): ProcessDisplayWindowBounds => {
    const dx = event.clientX - drag.pointerStart.x
    const dy = event.clientY - drag.pointerStart.y
    if (typeof window === 'undefined') return drag.origin
    return floatingWindowBoundsForDrag({
      mode: drag.mode,
      origin: drag.origin,
      dx,
      dy,
    }, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, {
      minWidth: minWindowWidth,
      minHeight: minWindowHeight,
      margin: viewportMargin,
    })
  }

  const startWindowDrag = (event: PointerEvent, mode: FloatingWindowDragMode): void => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('button, .process-display-lens-menu')) return
    event.preventDefault()
    const element = event.currentTarget as Element
    element.setPointerCapture(event.pointerId)
    windowDragState = {
      pointerId: event.pointerId,
      mode,
      pointerStart: { x: event.clientX, y: event.clientY },
      origin: windowBounds,
    }
  }

  const updateWindowDrag = (event: PointerEvent): void => {
    const drag = windowDragState
    if (!drag || drag.pointerId !== event.pointerId) return
    windowBounds = nextBoundsForDrag(drag, event)
  }

  const finishWindowDrag = (event: PointerEvent): void => {
    const drag = windowDragState
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = nextBoundsForDrag(drag, event)
    windowBounds = next
    windowDragState = null
    commitWindowBounds(next)
  }

  const updateWidgetPosition = (
    widgetId: string,
    position: ProcessDisplayWidgetPosition,
    commit: boolean,
  ): void => {
    const currentDisplay = display
    const plantId = loadedPlantId
    if (!currentDisplay || !plantId) return
    const next = { ...widgetPositions, [widgetId]: position }
    widgetPositions = next
    if (commit) {
      storeProcessDisplayLayout({
        simulationRunId,
        plantId,
        displayId: currentDisplay.id,
        layout: next,
      })
    }
  }

  const applyLens = async (
    lens: ProcessDisplayLensOption,
    plantId: string,
    displayId: string,
  ): Promise<void> => {
    const request = ++lensRequest
    error = null
    if (lens.lens === undefined) {
      activeLensId = lens.id
      projection = null
      return
    }
    try {
      const next = await readProcessDisplayProjection(processDisplayRunId, plantId, displayId, lens.lens)
      if (!disposed && request === lensRequest) {
        projection = next
        activeLensId = lens.id
      }
    } catch (err) {
      if (!disposed && request === lensRequest) error = err instanceof Error ? err.message : String(err)
    }
  }

  const loadDisplay = async (): Promise<void> => {
    loading = true
    error = null
    try {
      const loaded = await session.load()
      if (disposed || !loaded) return
      const address = {
        simulationRunId: processDisplayRunId,
        plantId: processDisplayPlantId,
        displayId: loaded.display.id,
      }
      const layout = readProcessDisplayLayout(address)
      const bounds = clampWindowBounds(readProcessDisplayWindowBounds(address) ?? windowBounds)
      const firstLens = loaded.display.lenses[0]
      if (firstLens) await applyLens(firstLens, processDisplayPlantId, loaded.display.id)
      if (disposed) return
      // Reveal the renderer only after its data and final geometry are ready.
      widgetPositions = layout
      windowBounds = bounds
      loadedPlantId = processDisplayPlantId
      display = loaded.display
      applySnapshot(loaded.snapshot)
      session.startRefreshing()
    } catch (err) {
      if (!disposed) error = err instanceof Error ? err.message : String(err)
    } finally {
      if (!disposed) loading = false
    }
  }

  runOnMount(() => {
    windowBounds = clampWindowBounds(defaultWindowBounds())
    void loadDisplay()
    return () => {
      disposed = true
      session.close()
    }
  })
</script>

<div class="process-display-window-layer">
  {#if loading}
    <div class="process-display-loading" style:top="{60 + windowOffsetIndex * 52}px">
      <span class="process-display-spinner" aria-hidden="true"></span>
      <span role="status">Opening {object.label}…</span>
      <button type="button" aria-label="Cancel opening process display" onclick={close}><X size={18} aria-hidden="true" /></button>
    </div>
  {:else}
  <section
    class="process-display-window"
    style="left: {windowBounds.x}px; top: {windowBounds.y}px; width: {windowBounds.width}px; height: {windowBounds.height}px;"
    aria-label="{object.label} process display"
  >
    <header class="process-display-statusbar" role="toolbar" aria-label="Process display window controls">
      <div
        class="process-display-drag-handle"
        role="button"
        tabindex="0"
        aria-label="Move process display"
        onpointerdown={(event) => startWindowDrag(event, 'move')}
        onpointermove={updateWindowDrag}
        onpointerup={finishWindowDrag}
        onpointercancel={finishWindowDrag}
      >
        <strong><span class="process-display-asset-dot" style:background={assetStatusColor}></span>{object.label}</strong>
        <ProcedureRunBadges
          summaries={procedureSummaries}
          onOpen={openProcedureSummary}
        />
      </div>
      <div class="process-display-window-actions">
        <div class="process-display-lens-control">
          <button
            type="button"
            class="process-display-icon-button"
            aria-label="Choose process display layer"
            aria-expanded={lensMenuOpen}
            onclick={() => { lensMenuOpen = !lensMenuOpen }}
          >
            <Eye size={18} aria-hidden="true" />
          </button>
          {#if lensMenuOpen && display && loadedPlantId}
            <div class="process-display-lens-menu">
              {#each lensOptions as option (option.id)}
                <button
                  type="button"
                  class:active={activeLensId === option.id}
                  onclick={async () => {
                    lensMenuOpen = false
                    try {
                      const currentDisplay = display
                      const plantId = loadedPlantId
                      if (!currentDisplay || !plantId) throw new Error('process display is not ready')
                      await applyLens(option, plantId, currentDisplay.id)
                    } catch (err) {
                      error = err instanceof Error ? err.message : String(err)
                    }
                  }}
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <button
          type="button"
          class="process-display-icon-button"
          class:active={accelerationRunning}
          aria-label="Open accelerated copy"
          aria-pressed={accelerationRunning}
          title={accelerationRunning ? 'Accelerated execution is running' : 'Create or continue an accelerated copy'}
          onclick={openAcceleration}
        >
          <Timer size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="process-display-icon-button"
          aria-label="Open Plant actions"
          title="Plant actions"
          onclick={() => {
            lensMenuOpen = false
            transientModalOpen = true
            void loadActions()
          }}
        >
          <Zap size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="process-display-icon-button"
          aria-label="Open computer-based procedures"
          title="Computer-based procedures"
          onclick={() => openProcedureSystemAt()}
        >
          <ClipboardList size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="process-display-icon-button"
          aria-label="Close process display"
          title="Close process display"
          onclick={close}
        >
          <X size={19} aria-hidden="true" />
        </button>
      </div>
    </header>
    <div class="process-display-window-body">
      {#if display}
        <ProcessDisplayRenderer
          {display}
          {values}
          {alarms}
          {widgetPositions}
          {visibleWidgetIds}
          {visiblePathIds}
          onWidgetPositionChange={updateWidgetPosition}
        />
        {#if error || refreshError}
          <div class="process-display-notice" role="status">
            {error ?? `Live refresh unavailable; showing last received values. ${refreshError}`}
            {#if error}<button type="button" aria-label="Dismiss display error" onclick={() => { error = null }}><X size={16} /></button>{/if}
          </div>
        {/if}
      {:else}
        <div class="process-display-error" role="alert">
          <span>{error ?? 'Process display did not load.'}</span>
          <button type="button" onclick={() => { void loadDisplay() }}>Retry</button>
        </div>
      {/if}
    </div>
    <div
      class="process-display-resize-handle east"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize process display horizontally"
      onpointerdown={(event) => startWindowDrag(event, 'resize-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-display-resize-handle south"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize process display vertically"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-display-resize-handle north"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize process display from top"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-display-resize-handle west"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize process display from left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-display-resize-handle corner"
      role="separator"
      aria-label="Resize process display"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-display-resize-handle corner north-east"
      role="separator"
      aria-label="Resize process display from top right"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-display-resize-handle corner north-west"
      role="separator"
      aria-label="Resize process display from top left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-display-resize-handle corner south-west"
      role="separator"
      aria-label="Resize process display from bottom left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
  </section>
  {/if}
  {#if transientModalOpen}
    <div class="process-transient-backdrop" role="presentation" onmousedown={() => { transientModalOpen = false }}>
      <div
        class="process-transient-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Plant actions"
        tabindex="-1"
        onmousedown={(event) => event.stopPropagation()}
      >
        <header class="process-transient-header">
          <div>
            <strong>Plant actions</strong>
            <span>Invoke validated, model-aware actions on {object.label}.</span>
          </div>
          <button type="button" aria-label="Close Plant actions" title="Close" onclick={() => { transientModalOpen = false }}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div class="process-transient-list">
          {#if actionsLoading}
            <p role="status">Loading plant actions…</p>
          {:else if actionsError}
            <p role="alert">{actionsError}</p>
            <button type="button" onclick={() => { void loadActions() }}>Retry</button>
          {:else if availableActions?.length === 0}
            <p>No actions are available for this plant.</p>
          {/if}
          {#each availableActions ?? [] as transient (transient.id)}
            <article class="process-transient-row">
              <div class="process-transient-copy">
                <strong>{transient.title}</strong>
                <span>{transient.description}</span>
              </div>
              {#if transient.parameters.length > 0}
                <div class="process-transient-fields">
                  {#each transient.parameters as field (field.id)}
                    <label>
                      <span>{field.label}</span>
                      <input
                        type="number"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={(transientInputs[transient.id]?.[field.id] ?? field.defaultValue).toFixed(field.digits)}
                        oninput={(event) => {
                          const target = event.currentTarget as HTMLInputElement
                          updateTransientInput({
                            transientId: transient.id,
                            fieldId: field.id,
                            value: Number.parseFloat(target.value),
                          })
                        }}
                      />
                      <small>{field.unit}</small>
                    </label>
                  {/each}
                </div>
              {/if}
              <button
                type="button"
                class="process-transient-play"
                aria-label="Run {transient.title}"
                title="Run {transient.title}"
                disabled={transientRunningId !== null}
                onclick={() => { void runDemoTransient(transient) }}
              >
                <Play size={18} fill="currentColor" aria-hidden="true" />
              </button>
            </article>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
