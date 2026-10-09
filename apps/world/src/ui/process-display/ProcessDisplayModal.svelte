<script lang="ts">
  import { untrack } from 'svelte'
  import { ClipboardList, Play, X, Zap } from 'lucide-svelte'
  import { embeddedViewFragment, embeddedViewPath, type EmbeddedViewEnvelope } from '@leitbild/contracts'
  import type { SimulationRunId, OperationalObject } from '../../core/model/index.ts'
  import { processPlantActionInvokeCommandKind } from '../../packs/process-plant/command-kinds.ts'
  import { statusToneColor } from '../status-presentation.ts'
  import { invokeSimulationRunCapability } from '../simulation-run-client.ts'
  import ProcedureRunBadges from '../procedures/ProcedureRunBadges.svelte'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../procedures/procedure-run-selectors.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import {
    readProcessPlantCatalog,
    readUnitOverviewView,
    processPlantIdForObject,
    type ProcessPlantActionCatalogEntry,
  } from './process-display-client.ts'
  import {
    readProcessDisplayWindowBounds,
    storeProcessDisplayWindowBounds,
    type ProcessDisplayWindowBounds,
  } from './process-display-layout.ts'
  import {
    floatingWindowBoundsForDrag,
    normalizeFloatingWindowBounds,
    type FloatingWindowDragMode,
  } from '../window-bounds.ts'

  // A Plant's process display window: the unit overview World generates from
  // the Plant model, shown by the same embedded view that shows displays
  // below an agent's answer, so both draw with OpenBridge and one renderer.
  // The window around it moves and resizes; what it draws is not moved.

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly object: OperationalObject
    readonly procedureSummaries?: ProcedureRunSummaryGroup
    readonly windowOffsetIndex?: number
    readonly openProcedureSystemAt: (summary?: ProcedureRunSummary) => void
    readonly close: () => void
  }

  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], completed: [] }

  let {
    simulationRunId,
    object,
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
  let overview = $state<EmbeddedViewEnvelope | null>(null)
  let transientModalOpen = $state(false)
  let transientRunningId = $state<string | null>(null)
  let availableActions = $state<ReadonlyArray<ProcessPlantActionCatalogEntry> | null>(null)
  let actionsLoading = $state(false)
  let actionsError = $state<string | null>(null)
  let transientInputs = $state<Record<string, Record<string, number>>>({})
  let windowBounds = $state<ProcessDisplayWindowBounds>({ x: 72, y: 72, width: 1120, height: 720 })
  let windowDragState = $state<WindowDragState | null>(null)
  let disposed = false

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

  const overviewSource = $derived(overview === null ? null : `${embeddedViewPath(overview)}${embeddedViewFragment(overview)}`)

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

  // The overview samples the Plant every second, so an action shows there without a reload.
  const runDemoTransient = async (transient: ProcessPlantActionCatalogEntry): Promise<void> => {
    if (transientRunningId !== null) return
    transientModalOpen = false
    transientRunningId = transient.id
    error = null
    try {
      const response = await invokeSimulationRunCapability(simulationRunId, {
        capabilityId: processPlantActionInvokeCommandKind,
        input: {
          plantId: processDisplayPlantId,
          actionId: transient.id,
          parameters: transientInputs[transient.id] ?? {},
        },
      })
      if (response.kind !== 'command') throw new Error(`${processPlantActionInvokeCommandKind} is not a command`)
      if (!response.result.ok) {
        throw new Error(response.result.reason ?? `process plant rejected ${transient.id}`)
      }
    } catch (err) {
      if (!disposed) error = `${transient.title} failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      if (!disposed) transientRunningId = null
    }
  }

  const commitWindowBounds = (bounds: ProcessDisplayWindowBounds): void => {
    storeProcessDisplayWindowBounds({ simulationRunId: processDisplayRunId, plantId: processDisplayPlantId, bounds })
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
    if (target instanceof Element && target.closest('button')) return
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

  const loadOverview = async (): Promise<void> => {
    loading = true
    error = null
    try {
      const view = await readUnitOverviewView(processDisplayRunId, processDisplayPlantId)
      if (disposed) return
      windowBounds = clampWindowBounds(readProcessDisplayWindowBounds({ simulationRunId: processDisplayRunId, plantId: processDisplayPlantId }) ?? windowBounds)
      overview = view
    } catch (err) {
      if (!disposed) error = err instanceof Error ? err.message : String(err)
    } finally {
      if (!disposed) loading = false
    }
  }

  runOnMount(() => {
    windowBounds = clampWindowBounds(defaultWindowBounds())
    void loadOverview()
    return () => {
      disposed = true
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
        <button
          type="button"
          class="process-display-icon-button"
          aria-label="Open Plant actions"
          title="Plant actions"
          onclick={() => {
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
      {#if overviewSource !== null}
        <!-- Its own page, so OpenBridge's styles stay with the drawing; it samples the Plant itself. -->
        <iframe class="process-display-view" src={overviewSource} title="{object.label} unit overview"></iframe>
        {#if error}
          <div class="process-display-notice" role="status">
            {error}
            <button type="button" aria-label="Dismiss display error" onclick={() => { error = null }}><X size={16} /></button>
          </div>
        {/if}
      {:else}
        <div class="process-display-error" role="alert">
          <span>{error ?? 'Process display did not load.'}</span>
          <button type="button" onclick={() => { void loadOverview() }}>Retry</button>
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

<style>
  .process-display-view { display: block; width: 100%; height: 100%; border: 0; }
</style>
