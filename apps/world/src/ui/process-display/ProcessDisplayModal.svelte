<script lang="ts">
  import { untrack } from 'svelte'
  import { ClipboardList, Eye, Play, X, Zap } from 'lucide-svelte'
  import type { SimulationRunId, OperationalObject } from '../../core/model/index.ts'
  import type { PackObjectStatusPresentation } from '../../core/packs/protocol.ts'
  import { processPlantActionInvokeCommandKind } from '../../packs/process-plant/command-kinds.ts'
  import type { CompiledProcessDisplay, ProcessDisplayValue } from '../../packs/process-plant/displays/index.ts'
  import { statusToneColor } from '../status-presentation.ts'
  import { invokeSimulationRunCapability } from '../simulation-run-client.ts'
  import ProcedureRunBadges from '../procedures/ProcedureRunBadges.svelte'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../procedures/procedure-run-selectors.ts'
  import ProcessDisplayRenderer from './ProcessDisplayRenderer.svelte'
  import {
    emptyProcessDisplayAlarmSnapshot,
    listProcessDisplays,
    readProcessPlantCatalog,
    readProcessDisplay,
    readProcessDisplayProjection,
    readProcessDisplaySnapshot,
    processPlantIdForObject,
    type ProcessDisplayProjection,
    type ProcessDisplayLensOption,
    type ProcessPlantActionCatalogEntry,
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
    readonly unitStatus?: PackObjectStatusPresentation
    readonly procedureSummaries?: ProcedureRunSummaryGroup
    readonly windowOffsetIndex?: number
    readonly openProcedureSystemAt: (summary?: ProcedureRunSummary) => void
    readonly close: () => void
  }

  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], completed: [] }

  let {
    simulationRunId,
    object,
    unitStatus = undefined,
    procedureSummaries = emptyProcedureRunSummaries,
    windowOffsetIndex = 0,
    openProcedureSystemAt,
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
  let display = $state<CompiledProcessDisplay | null>(null)
  let values = $state<ReadonlyMap<string, ProcessDisplayValue>>(new Map())
  let alarms = $state<ProcessDisplayAlarmSnapshot>(emptyProcessDisplayAlarmSnapshot)
  let projection = $state<ProcessDisplayProjection | null>(null)
  let activeLensId = $state<string>('all')
  let lensMenuOpen = $state(false)
  let transientModalOpen = $state(false)
  let transientRunningId = $state<string | null>(null)
  let availableActions = $state<ReadonlyArray<ProcessPlantActionCatalogEntry>>([])
  let transientInputs = $state<Record<string, Record<string, number>>>({})
  let widgetPositions = $state<ProcessDisplayLayout>({})
  let loadedPlantId = $state<string | null>(null)
  let windowBounds = $state<ProcessDisplayWindowBounds>({ x: 72, y: 72, width: 1120, height: 720 })
  let windowDragState = $state<WindowDragState | null>(null)
  let boundsInitialized = false

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

  const refreshSnapshot = async (
    runId: SimulationRunId,
    plantId: string,
    displayId: string,
  ): Promise<void> => {
    const snapshot = await readProcessDisplaySnapshot(runId, plantId, displayId)
    values = new Map(snapshot.values.map(value => [value.path, value]))
    alarms = snapshot.alarms
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
    const currentDisplay = display
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
      if (currentDisplay) await refreshSnapshot(simulationRunId, plantId, currentDisplay.id)
    } catch (err) {
      error = `${transient.title} failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      transientRunningId = null
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
    activeLensId = lens.id
    if (lens.lens === undefined) {
      projection = null
      return
    }
    projection = await readProcessDisplayProjection(simulationRunId, plantId, displayId, lens.lens)
  }

  const startSnapshotRefresh = (config: {
    readonly runId: SimulationRunId
    readonly plantId: string
    readonly displayId: string
    readonly isCancelled: () => boolean
  }): (() => void) => {
    const refreshSafely = async (): Promise<void> => {
      try {
        await refreshSnapshot(config.runId, config.plantId, config.displayId)
      } catch (err) {
        if (!config.isCancelled()) error = err instanceof Error ? err.message : String(err)
      }
    }
    const interval = setInterval(() => {
      void refreshSafely()
    }, 1_000)
    return () => {
      clearInterval(interval)
    }
  }

  $effect(() => {
    const selectedPlantId = processDisplayPlantId
    const selectedSimulationRunId = simulationRunId
    let cancelled = false
    let stopRefresh: (() => void) | null = null

    if (!boundsInitialized) {
      windowBounds = clampWindowBounds(defaultWindowBounds())
      boundsInitialized = true
    }

    const load = async (): Promise<void> => {
      try {
        loading = true
        error = null
        values = new Map()
        availableActions = []
        alarms = emptyProcessDisplayAlarmSnapshot
        const displays = await listProcessDisplays(selectedSimulationRunId, selectedPlantId)
        const catalog = await readProcessPlantCatalog(selectedSimulationRunId)
        const first = displays[0]
        if (!first) throw new Error(`no process displays are available for ${selectedPlantId}`)
        const nextDisplay = await readProcessDisplay(selectedSimulationRunId, selectedPlantId, first.id)
        if (cancelled) return
        loadedPlantId = selectedPlantId
        display = nextDisplay
        availableActions = catalog.actions
        transientInputs = Object.fromEntries(catalog.actions.map(action => [
          action.id,
          Object.fromEntries(action.parameters.map(parameter => [parameter.id, parameter.defaultValue])),
        ]))
        projection = null
        activeLensId = nextDisplay.lenses[0]?.id ?? 'all'
        widgetPositions = readProcessDisplayLayout({
          simulationRunId: selectedSimulationRunId,
          plantId: selectedPlantId,
          displayId: nextDisplay.id,
        })
        const currentWindowBounds = untrack(() => windowBounds)
        windowBounds = clampWindowBounds(readProcessDisplayWindowBounds({
          simulationRunId: selectedSimulationRunId,
          plantId: selectedPlantId,
          displayId: nextDisplay.id,
        }) ?? currentWindowBounds)
        await refreshSnapshot(selectedSimulationRunId, selectedPlantId, first.id)
        if (cancelled) return
        stopRefresh = startSnapshotRefresh({
          runId: selectedSimulationRunId,
          plantId: selectedPlantId,
          displayId: first.id,
          isCancelled: () => cancelled,
        })
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) loading = false
      }
    }

    void load()

    return () => {
      cancelled = true
      stopRefresh?.()
    }
  })
</script>

<div class="process-display-window-layer">
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
          aria-label="Open Plant actions"
          title="Plant actions"
          onclick={() => {
            lensMenuOpen = false
            transientModalOpen = true
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
      {#if loading}
        <div class="process-display-message">Loading process display...</div>
      {:else if error}
        <div class="process-display-error">{error}</div>
      {:else if display}
        <ProcessDisplayRenderer
          {display}
          {values}
          {alarms}
          {widgetPositions}
          {visibleWidgetIds}
          {visiblePathIds}
          onWidgetPositionChange={updateWidgetPosition}
        />
      {:else}
        <div class="process-display-error">Process display did not load.</div>
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
          {#each availableActions as transient (transient.id)}
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
