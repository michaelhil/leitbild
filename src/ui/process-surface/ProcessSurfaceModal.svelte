<script lang="ts">
  import type { Component } from 'svelte'
  import { ClipboardList, Eye, FileText, GitBranch, X } from 'lucide-svelte'
  import type { ControlInstanceId, OperationalObject } from '../../core/model/index.ts'
  import type { PackObjectStatusPresentation } from '../../core/packs/protocol.ts'
  import type { CompiledProcessSurface, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'
  import { statusToneColor } from '../status-presentation.ts'
  import ProcessPlantArtifactModal from './ProcessPlantArtifactModal.svelte'
  import ProcessSurfaceRenderer from './ProcessSurfaceRenderer.svelte'
  import {
    listProcessSurfaces,
    readProcessSurface,
    readProcessSurfaceProjection,
    readProcessSurfaceSnapshot,
    type ProcessPlantArtifactKind,
    type ProcessSurfaceProjection,
    type ProcessSurfaceLensOption,
  } from './process-surface-client.ts'
  import {
    readProcessSurfaceLayout,
    readProcessSurfaceWindowBounds,
    storeProcessSurfaceLayout,
    storeProcessSurfaceWindowBounds,
    type ProcessSurfaceLayout,
    type ProcessSurfaceWindowBounds,
    type ProcessSurfaceWidgetPosition,
  } from './process-surface-layout.ts'

  interface Props {
    readonly controlInstanceId: ControlInstanceId
    readonly object: OperationalObject
    readonly unitStatus?: PackObjectStatusPresentation
    readonly procedureRevision: number
    readonly close: () => void
  }

  let { controlInstanceId, object, unitStatus = undefined, procedureRevision, close }: Props = $props()

  type WindowDragMode = 'move' | 'resize-east' | 'resize-south' | 'resize-corner'

  interface WindowDragState {
    readonly pointerId: number
    readonly mode: WindowDragMode
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: ProcessSurfaceWindowBounds
  }

  const minWindowWidth = 620
  const minWindowHeight = 420
  const viewportMargin = 12

  let loading = $state(true)
  let error = $state<string | null>(null)
  let surface = $state<CompiledProcessSurface | null>(null)
  let values = $state<ReadonlyMap<string, ProcessSurfaceValue>>(new Map())
  let projection = $state<ProcessSurfaceProjection | null>(null)
  let activeLensId = $state<string>('all')
  let lensMenuOpen = $state(false)
  let artifactModal = $state<ProcessPlantArtifactKind | null>(null)
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
    return {
      x: Math.max(viewportMargin, Math.round((window.innerWidth - Math.min(1180, window.innerWidth - 2 * viewportMargin)) / 2)),
      y: Math.max(viewportMargin, Math.round((window.innerHeight - Math.min(760, window.innerHeight - 2 * viewportMargin)) / 2)),
      width: Math.max(minWindowWidth, Math.min(1180, window.innerWidth - 2 * viewportMargin)),
      height: Math.max(minWindowHeight, Math.min(760, window.innerHeight - 2 * viewportMargin)),
    }
  }

  const clampWindowBounds = (bounds: ProcessSurfaceWindowBounds): ProcessSurfaceWindowBounds => {
    if (typeof window === 'undefined') return bounds
    const maxWidth = Math.max(minWindowWidth, window.innerWidth - 2 * viewportMargin)
    const maxHeight = Math.max(minWindowHeight, window.innerHeight - 2 * viewportMargin)
    const width = Math.max(minWindowWidth, Math.min(maxWidth, bounds.width))
    const height = Math.max(minWindowHeight, Math.min(maxHeight, bounds.height))
    return {
      x: Math.max(viewportMargin, Math.min(window.innerWidth - width - viewportMargin, bounds.x)),
      y: Math.max(viewportMargin, Math.min(window.innerHeight - height - viewportMargin, bounds.y)),
      width,
      height,
    }
  }

  const systemIdFor = (candidate: OperationalObject): string => {
    const data = candidate.packData
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('process display object has no pack data')
    const systemId = (data as Record<string, unknown>).systemId
    if (typeof systemId !== 'string' || systemId.length === 0) throw new Error('process display object has no system id')
    return systemId
  }

  const refreshSnapshot = async (
    instanceId: ControlInstanceId,
    systemId: string,
    surfaceId: string,
  ): Promise<void> => {
    const snapshot = await readProcessSurfaceSnapshot(instanceId, systemId, surfaceId)
    values = new Map(snapshot.values.map(value => [value.path, value]))
  }

  const statusValue = (path: string): string =>
    values.get(path)?.formatted ?? 'pending'

  const statusItems = $derived([
    { label: 'MWt', value: statusValue('core.totalThermalPowerMw') },
    { label: 'MWe', value: statusValue('turbine.electricMw') },
  ])

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

  const openArtifact = (artifact: ProcessPlantArtifactKind): void => {
    artifactModal = artifact
  }

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

  const commitWindowBounds = (bounds: ProcessSurfaceWindowBounds): void => {
    const currentSurface = surface
    const systemId = loadedSystemId
    if (!currentSurface || !systemId) return
    storeProcessSurfaceWindowBounds({
      controlInstanceId,
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
    if (drag.mode === 'move') {
      return clampWindowBounds({
        ...drag.origin,
        x: drag.origin.x + dx,
        y: drag.origin.y + dy,
      })
    }
    if (drag.mode === 'resize-east') {
      return clampWindowBounds({ ...drag.origin, width: drag.origin.width + dx })
    }
    if (drag.mode === 'resize-south') {
      return clampWindowBounds({ ...drag.origin, height: drag.origin.height + dy })
    }
    return clampWindowBounds({
      ...drag.origin,
      width: drag.origin.width + dx,
      height: drag.origin.height + dy,
    })
  }

  const startWindowDrag = (event: PointerEvent, mode: WindowDragMode): void => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof HTMLElement && target.closest('button, .process-surface-lens-menu')) return
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
        controlInstanceId,
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
    projection = await readProcessSurfaceProjection(controlInstanceId, systemId, surfaceId, lens.lens)
  }

  const startSnapshotRefresh = (config: {
    readonly instanceId: ControlInstanceId
    readonly systemId: string
    readonly surfaceId: string
    readonly isCancelled: () => boolean
  }): (() => void) => {
    const refreshSafely = async (): Promise<void> => {
      try {
        await refreshSnapshot(config.instanceId, config.systemId, config.surfaceId)
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
    const selectedObject = object
    const selectedControlInstanceId = controlInstanceId
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
        const systemId = systemIdFor(selectedObject)
        const surfaces = await listProcessSurfaces(selectedControlInstanceId, systemId)
        const first = surfaces[0]
        if (!first) throw new Error(`no process displays are available for ${systemId}`)
        const nextSurface = await readProcessSurface(selectedControlInstanceId, systemId, first.id)
        if (cancelled) return
        loadedSystemId = systemId
        surface = nextSurface
        projection = null
        activeLensId = nextSurface.lenses[0]?.id ?? 'all'
        widgetPositions = readProcessSurfaceLayout({
          controlInstanceId: selectedControlInstanceId,
          systemId,
          surfaceId: nextSurface.id,
        })
        windowBounds = clampWindowBounds(readProcessSurfaceWindowBounds({
          controlInstanceId: selectedControlInstanceId,
          systemId,
          surfaceId: nextSurface.id,
        }) ?? windowBounds)
        await refreshSnapshot(selectedControlInstanceId, systemId, first.id)
        if (cancelled) return
        stopRefresh = startSnapshotRefresh({
          instanceId: selectedControlInstanceId,
          systemId,
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
        <div class="process-surface-status-items">
          {#each statusItems as item (item.label)}
            <span><b>{item.label}</b> {item.value}</span>
          {/each}
        </div>
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
          aria-label="Open plant specification source"
          title="Plant specification source"
          onclick={() => openArtifact('authored-spec')}
        >
          <FileText size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="process-surface-icon-button"
          aria-label="Open full Mermaid component graph"
          title="Full Mermaid component graph"
          onclick={() => openArtifact('compiled-graph-mermaid')}
        >
          <GitBranch size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="process-surface-icon-button"
          aria-label="Open computer-based procedures"
          title="Computer-based procedures"
          onclick={() => void openProcedureSystem()}
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
      class="process-surface-resize-handle corner"
      role="separator"
      aria-label="Resize process display"
      onpointerdown={(event) => startWindowDrag(event, 'resize-corner')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
  </section>
  {#if artifactModal && loadedSystemId}
    <ProcessPlantArtifactModal
      {controlInstanceId}
      systemId={loadedSystemId}
      artifact={artifactModal}
      close={() => { artifactModal = null }}
    />
  {/if}
  {#if procedureModalOpen && loadedSystemId && ProcedureSystemModal}
    <ProcedureSystemModal
      {controlInstanceId}
      systemId={loadedSystemId}
      unitName={object.label}
      {unitStatus}
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
