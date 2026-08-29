<script lang="ts">
  import type { Component } from 'svelte'
  import { untrack } from 'svelte'
  import { ClipboardList, Eye, Play, X, Zap } from 'lucide-svelte'
  import type { SimulationRunId, ObjectId, OperationalObject } from '../../core/model/index.ts'
  import type { PackObjectStatusPresentation } from '../../core/packs/protocol.ts'
  import { processPlantControlWriteCommandKind } from '../../packs/process-plant/command-kinds.ts'
  import {
    defaultProcessPlantDemoTransientInputs,
    processPlantDemoTransientCommands,
    processPlantDemoTransients,
    type ProcessPlantDemoTransient,
    type ProcessPlantDemoTransientContext,
  } from '../../packs/process-plant/demo-transients.ts'
  import type { CompiledProcessSurface, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'
  import { statusToneColor } from '../status-presentation.ts'
  import { sendSimulationRunCommand } from '../simulation-run-client.ts'
  import ProcedureRunBadges from '../procedures/ProcedureRunBadges.svelte'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../procedures/procedure-run-selectors.ts'
  import ProcessSurfaceRenderer from './ProcessSurfaceRenderer.svelte'
  import {
    emptyProcessSurfaceAlarmSnapshot,
    listProcessPlantVariablePaths,
    listProcessSurfaces,
    readProcessSurface,
    readProcessSurfaceProjection,
    readProcessSurfaceSnapshot,
    type ProcessSurfaceProjection,
    type ProcessSurfaceLensOption,
  } from './process-surface-client.ts'
  import type { ProcessSurfaceAlarmSnapshot } from '../../packs/process-plant/surfaces/index.ts'
  import {
    readProcessSurfaceLayout,
    readProcessSurfaceWindowBounds,
    storeProcessSurfaceLayout,
    storeProcessSurfaceWindowBounds,
    type ProcessSurfaceLayout,
    type ProcessSurfaceWindowBounds,
    type ProcessSurfaceWidgetPosition,
  } from './process-surface-layout.ts'
  import {
    floatingWindowBoundsForDrag,
    normalizeFloatingWindowBounds,
    type FloatingWindowDragMode,
  } from '../window-bounds.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly object: OperationalObject
    readonly unitStatus?: PackObjectStatusPresentation
    readonly unitContexts?: ReadonlyArray<{
      readonly systemId: string
      readonly targetObjectId?: ObjectId
      readonly label: string
      readonly status?: PackObjectStatusPresentation
    }>
    readonly procedureSummaries?: ProcedureRunSummaryGroup
    readonly procedureRevision: number
    readonly windowOffsetIndex?: number
    readonly openProcedureSystemAt?: (summary?: ProcedureRunSummary) => void
    readonly close: () => void
  }

  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], completed: [] }

  let {
    simulationRunId,
    object,
    unitStatus = undefined,
    unitContexts = [],
    procedureSummaries = emptyProcedureRunSummaries,
    procedureRevision,
    windowOffsetIndex = 0,
    openProcedureSystemAt = undefined,
    close,
  }: Props = $props()

  interface WindowDragState {
    readonly pointerId: number
    readonly mode: FloatingWindowDragMode
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: ProcessSurfaceWindowBounds
  }

  const minWindowWidth = 48
  const minWindowHeight = 32
  const viewportMargin = 12
  const windowOffsetStepPx = 28

  let loading = $state(true)
  let error = $state<string | null>(null)
  let surface = $state<CompiledProcessSurface | null>(null)
  let values = $state<ReadonlyMap<string, ProcessSurfaceValue>>(new Map())
  let systemVariablePaths = $state<ProcessPlantDemoTransientContext['variablePaths']>([])
  let alarms = $state<ProcessSurfaceAlarmSnapshot>(emptyProcessSurfaceAlarmSnapshot)
  let projection = $state<ProcessSurfaceProjection | null>(null)
  let activeLensId = $state<string>('all')
  let lensMenuOpen = $state(false)
  let transientModalOpen = $state(false)
  let transientRunningId = $state<string | null>(null)
  let transientInputs = $state<Record<string, Record<string, number>>>(
    Object.fromEntries(processPlantDemoTransients.map(transient => [
      transient.id,
      defaultProcessPlantDemoTransientInputs(transient),
    ])) as Record<string, Record<string, number>>,
  )
  let procedureModalOpen = $state(false)
  let procedureModalError = $state<string | null>(null)
  let ProcedureSystemModal = $state<Component | null>(null)
  let widgetPositions = $state<ProcessSurfaceLayout>({})
  let loadedSystemId = $state<string | null>(null)
  let windowBounds = $state<ProcessSurfaceWindowBounds>({ x: 72, y: 72, width: 1120, height: 720 })
  let windowDragState = $state<WindowDragState | null>(null)
  let boundsInitialized = false
  let procedureModalLoadPromise: Promise<Component> | null = null

  const defaultWindowBounds = (): ProcessSurfaceWindowBounds => {
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

  const clampWindowBounds = (bounds: ProcessSurfaceWindowBounds): ProcessSurfaceWindowBounds => {
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

  const systemIdFor = (candidate: OperationalObject): string => {
    const data = candidate.packData
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('process display object has no pack data')
    const systemId = (data as Record<string, unknown>).systemId
    if (typeof systemId !== 'string' || systemId.length === 0) throw new Error('process display object has no system id')
    return systemId
  }
  const processSurfaceSystemId = untrack(() => systemIdFor(object))

  const refreshSnapshot = async (
    runId: SimulationRunId,
    systemId: string,
    surfaceId: string,
  ): Promise<void> => {
    const snapshot = await readProcessSurfaceSnapshot(runId, systemId, surfaceId)
    values = new Map(snapshot.values.map(value => [value.path, value]))
    alarms = snapshot.alarms
  }

  const visibleWidgetIds = $derived(projection
    ? new Set<string>(projection.surfaceProjection.visibleWidgetIds)
    : null)

  const visiblePathIds = $derived(projection
    ? new Set<string>(projection.surfaceProjection.visiblePathIds)
    : null)

  const lensOptions = $derived<ReadonlyArray<ProcessSurfaceLensOption>>(surface?.lenses ?? [])

  const assetStatusColor = $derived(statusToneColor(
    object.operational.priority === 'critical'
      ? 'error'
      : object.operational.priority === 'high'
        ? 'working'
        : object.operational.status === 'normal'
          ? 'ready'
          : 'idle',
  ))

  const loadProcedureSystemModal = async (): Promise<void> => {
    if (ProcedureSystemModal) return
    procedureModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../procedures/ProcedureSystemModal.svelte')
      return module.default
    })()
    try {
      ProcedureSystemModal = await procedureModalLoadPromise
    } catch (err) {
      procedureModalLoadPromise = null
      throw err
    }
  }

  const openProcedureSystem = async (): Promise<void> => {
    procedureModalOpen = true
    procedureModalError = null
    try {
      await loadProcedureSystemModal()
    } catch (err) {
      procedureModalError = err instanceof Error ? err.message : String(err)
    }
  }

  const openProcedureSummary = (summary: ProcedureRunSummary): void => {
    if (openProcedureSystemAt) {
      openProcedureSystemAt(summary)
      return
    }
    void openProcedureSystem()
  }

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

  const currentDemoTransientContext = (): ProcessPlantDemoTransientContext => ({
    variablePaths: Array.from(new Set([
      ...systemVariablePaths,
      ...(surface?.bindingPaths ?? []),
      ...Array.from(values.values()).map(value => value.path),
    ])),
  })

  const runDemoTransient = async (transient: ProcessPlantDemoTransient): Promise<void> => {
    if (transientRunningId !== null) return
    const systemId = loadedSystemId ?? systemIdFor(object)
    const currentSurface = surface
    transientModalOpen = false
    transientRunningId = transient.id
    error = null
    try {
      const commands = processPlantDemoTransientCommands(
        transient,
        transientInputs[transient.id] ?? {},
        currentDemoTransientContext(),
      )
      for (const command of commands) {
        const response = await sendSimulationRunCommand(simulationRunId, {
          kind: processPlantControlWriteCommandKind,
          targetObjectIds: [object.id],
          payload: {
            systemId,
            path: command.path,
            value: command.value,
          },
        })
        if (!response.result.ok) {
          throw new Error(response.result.reason ?? `process plant rejected ${command.path}`)
        }
      }
      if (currentSurface) await refreshSnapshot(simulationRunId, systemId, currentSurface.id)
    } catch (err) {
      error = `${transient.label} failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      transientRunningId = null
    }
  }

  const commitWindowBounds = (bounds: ProcessSurfaceWindowBounds): void => {
    const currentSurface = surface
    const systemId = loadedSystemId
    if (!currentSurface || !systemId) return
    storeProcessSurfaceWindowBounds({
      simulationRunId,
      systemId,
      surfaceId: currentSurface.id,
      bounds,
    })
  }

  const nextBoundsForDrag = (
    drag: WindowDragState,
    event: PointerEvent,
  ): ProcessSurfaceWindowBounds => {
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
    if (target instanceof Element && target.closest('button, .process-surface-lens-menu')) return
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
    position: ProcessSurfaceWidgetPosition,
    commit: boolean,
  ): void => {
    const currentSurface = surface
    const systemId = loadedSystemId
    if (!currentSurface || !systemId) return
    const next = { ...widgetPositions, [widgetId]: position }
    widgetPositions = next
    if (commit) {
      storeProcessSurfaceLayout({
        simulationRunId,
        systemId,
        surfaceId: currentSurface.id,
        layout: next,
      })
    }
  }

  const applyLens = async (
    lens: ProcessSurfaceLensOption,
    systemId: string,
    surfaceId: string,
  ): Promise<void> => {
    activeLensId = lens.id
    if (lens.lens === undefined) {
      projection = null
      return
    }
    projection = await readProcessSurfaceProjection(simulationRunId, systemId, surfaceId, lens.lens)
  }

  const startSnapshotRefresh = (config: {
    readonly runId: SimulationRunId
    readonly systemId: string
    readonly surfaceId: string
    readonly isCancelled: () => boolean
  }): (() => void) => {
    const refreshSafely = async (): Promise<void> => {
      try {
        await refreshSnapshot(config.runId, config.systemId, config.surfaceId)
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
    const selectedSystemId = processSurfaceSystemId
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
        systemVariablePaths = []
        alarms = emptyProcessSurfaceAlarmSnapshot
        const surfaces = await listProcessSurfaces(selectedSimulationRunId, selectedSystemId)
        const first = surfaces[0]
        if (!first) throw new Error(`no process displays are available for ${selectedSystemId}`)
        const nextSurface = await readProcessSurface(selectedSimulationRunId, selectedSystemId, first.id)
        const nextVariablePaths = await listProcessPlantVariablePaths(selectedSimulationRunId, selectedSystemId)
        if (cancelled) return
        loadedSystemId = selectedSystemId
        surface = nextSurface
        systemVariablePaths = nextVariablePaths
        projection = null
        activeLensId = nextSurface.lenses[0]?.id ?? 'all'
        widgetPositions = readProcessSurfaceLayout({
          simulationRunId: selectedSimulationRunId,
          systemId: selectedSystemId,
          surfaceId: nextSurface.id,
        })
        const currentWindowBounds = untrack(() => windowBounds)
        windowBounds = clampWindowBounds(readProcessSurfaceWindowBounds({
          simulationRunId: selectedSimulationRunId,
          systemId: selectedSystemId,
          surfaceId: nextSurface.id,
        }) ?? currentWindowBounds)
        await refreshSnapshot(selectedSimulationRunId, selectedSystemId, first.id)
        if (cancelled) return
        stopRefresh = startSnapshotRefresh({
          runId: selectedSimulationRunId,
          systemId: selectedSystemId,
          surfaceId: first.id,
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

<div class="process-surface-window-layer">
  <section
    class="process-surface-window"
    style="left: {windowBounds.x}px; top: {windowBounds.y}px; width: {windowBounds.width}px; height: {windowBounds.height}px;"
    aria-label="{object.label} process display"
  >
    <header class="process-surface-statusbar" role="toolbar" aria-label="Process display window controls">
      <div
        class="process-surface-drag-handle"
        role="button"
        tabindex="0"
        aria-label="Move process display"
        onpointerdown={(event) => startWindowDrag(event, 'move')}
        onpointermove={updateWindowDrag}
        onpointerup={finishWindowDrag}
        onpointercancel={finishWindowDrag}
      >
        <strong><span class="process-surface-asset-dot" style:background={assetStatusColor}></span>{object.label}</strong>
        <ProcedureRunBadges
          summaries={procedureSummaries}
          onOpen={openProcedureSummary}
        />
      </div>
      <div class="process-surface-window-actions">
        <div class="process-surface-lens-control">
          <button
            type="button"
            class="process-surface-icon-button"
            aria-label="Choose process display layer"
            aria-expanded={lensMenuOpen}
            onclick={() => { lensMenuOpen = !lensMenuOpen }}
          >
            <Eye size={18} aria-hidden="true" />
          </button>
          {#if lensMenuOpen && surface && loadedSystemId}
            <div class="process-surface-lens-menu">
              {#each lensOptions as option (option.id)}
                <button
                  type="button"
                  class:active={activeLensId === option.id}
                  onclick={async () => {
                    lensMenuOpen = false
                    try {
                      const currentSurface = surface
                      const systemId = loadedSystemId
                      if (!currentSurface || !systemId) throw new Error('process display is not ready')
                      await applyLens(option, systemId, currentSurface.id)
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
          class="process-surface-icon-button"
          aria-label="Open demo transients"
          title="Demo transients"
          onclick={() => {
            lensMenuOpen = false
            transientModalOpen = true
          }}
        >
          <Zap size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="process-surface-icon-button"
          aria-label="Open computer-based procedures"
          title="Computer-based procedures"
          onclick={() => {
            if (openProcedureSystemAt) {
              openProcedureSystemAt()
              return
            }
            void openProcedureSystem()
          }}
        >
          <ClipboardList size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="process-surface-icon-button"
          aria-label="Close process display"
          title="Close process display"
          onclick={close}
        >
          <X size={19} aria-hidden="true" />
        </button>
      </div>
    </header>
    <div class="process-surface-window-body">
      {#if loading}
        <div class="process-surface-message">Loading process display...</div>
      {:else if error}
        <div class="process-surface-error">{error}</div>
      {:else if surface}
        <ProcessSurfaceRenderer
          {surface}
          {values}
          {alarms}
          {widgetPositions}
          {visibleWidgetIds}
          {visiblePathIds}
          onWidgetPositionChange={updateWidgetPosition}
        />
      {:else}
        <div class="process-surface-error">Process display did not load.</div>
      {/if}
    </div>
    <div
      class="process-surface-resize-handle east"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize process display horizontally"
      onpointerdown={(event) => startWindowDrag(event, 'resize-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-surface-resize-handle south"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize process display vertically"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-surface-resize-handle north"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize process display from top"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-surface-resize-handle west"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize process display from left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-surface-resize-handle corner"
      role="separator"
      aria-label="Resize process display"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-surface-resize-handle corner north-east"
      role="separator"
      aria-label="Resize process display from top right"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-surface-resize-handle corner north-west"
      role="separator"
      aria-label="Resize process display from top left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="process-surface-resize-handle corner south-west"
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
        aria-label="Demo transients"
        tabindex="-1"
        onmousedown={(event) => event.stopPropagation()}
      >
        <header class="process-transient-header">
          <div>
            <strong>Demo transients</strong>
            <span>Run real process-plant control writes on {object.label}.</span>
          </div>
          <button type="button" aria-label="Close demo transients" title="Close" onclick={() => { transientModalOpen = false }}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div class="process-transient-list">
          {#each processPlantDemoTransients as transient (transient.id)}
            <article class="process-transient-row">
              <div class="process-transient-copy">
                <strong>{transient.label}</strong>
                <span>{transient.description}</span>
              </div>
              {#if transient.fields.length > 0}
                <div class="process-transient-fields">
                  {#each transient.fields as field (field.id)}
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
                aria-label="Run {transient.label}"
                title="Run {transient.label}"
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
  {#if procedureModalOpen && loadedSystemId && ProcedureSystemModal}
    <ProcedureSystemModal
      {simulationRunId}
      systemId={loadedSystemId}
      unitName={object.label}
      {unitStatus}
      {unitContexts}
      realtimeRevision={procedureRevision}
      close={() => { procedureModalOpen = false }}
    />
  {:else if procedureModalOpen}
    <div class="procedure-backdrop" role="presentation" onmousedown={() => { procedureModalOpen = false }}>
      <div class="procedure-modal loading" role="dialog" aria-modal="true" aria-label="Computer-based procedure system loading" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
        <header class="procedure-header">
          <div>
            <strong>{object.label}</strong>
            <span>{procedureModalError ?? 'Loading procedure system...'}</span>
          </div>
          <button type="button" aria-label="Close procedures" title="Close procedures" onclick={() => { procedureModalOpen = false }}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
      </div>
    </div>
  {/if}
</div>
