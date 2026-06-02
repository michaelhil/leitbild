<script lang="ts">
  import type { CompiledProcessSurface, CompiledProcessSurfaceWidget, ProcessSurfaceAlarmSnapshot, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'
  import { emptyProcessSurfaceAlarmSnapshot } from './process-surface-client.ts'
  import ProcessSurfaceWidget from './ProcessSurfaceWidget.svelte'
  import type { ProcessSurfaceLayout, ProcessSurfaceWidgetPosition } from './process-surface-layout.ts'
  import {
    pathDataFor,
    pathPointsFor,
    widgetGeometryFor,
    widgetPositionFor,
  } from './process-surface-rendering.ts'

  interface Props {
    readonly surface: CompiledProcessSurface
    readonly values: ReadonlyMap<string, ProcessSurfaceValue>
    readonly alarms?: ProcessSurfaceAlarmSnapshot
    readonly widgetPositions?: ProcessSurfaceLayout
    readonly visibleWidgetIds?: ReadonlySet<string> | null
    readonly visiblePathIds?: ReadonlySet<string> | null
    readonly onWidgetPositionChange?: (widgetId: string, position: ProcessSurfaceWidgetPosition, commit: boolean) => void
  }

  let {
    surface,
    values,
    alarms = emptyProcessSurfaceAlarmSnapshot,
    widgetPositions = {},
    visibleWidgetIds = null,
    visiblePathIds = null,
    onWidgetPositionChange,
  }: Props = $props()

  interface DragState {
    readonly pointerId: number
    readonly widgetId: string
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: ProcessSurfaceWidgetPosition
  }

  interface PanState {
    readonly pointerId: number
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: { readonly x: number; readonly y: number }
  }

  let svgElement: SVGSVGElement | null = $state(null)
  let dragState = $state<DragState | null>(null)
  let panState = $state<PanState | null>(null)
  let viewTransform = $state({ x: 0, y: 0, scale: 1 })

  const renderedWidgets = $derived(visibleWidgetIds
    ? surface.widgets.filter(widget => visibleWidgetIds.has(widget.id))
    : surface.widgets)

  const renderedPaths = $derived(visiblePathIds
    ? surface.paths.filter(path => visiblePathIds.has(path.id))
    : surface.paths)

  const serviceClass = (path: { readonly style: { readonly service?: string } }): string =>
    `process-flow ${path.style.service ?? 'support'}`

  const showUnitOverviewGuides = $derived(surface.id === 'unit-overview')

  const svgPointFor = (
    event: PointerEvent | WheelEvent,
  ): { readonly x: number; readonly y: number } | null => {
    const svg = svgElement
    const matrix = svg?.getScreenCTM()?.inverse()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const transformed = point.matrixTransform(matrix)
    return { x: transformed.x, y: transformed.y }
  }

  const contentPointFor = (event: PointerEvent): { readonly x: number; readonly y: number } | null => {
    const point = svgPointFor(event)
    if (!point) return null
    return {
      x: (point.x - viewTransform.x) / viewTransform.scale,
      y: (point.y - viewTransform.y) / viewTransform.scale,
    }
  }

  const visibleContentBounds = (): {
    readonly minX: number
    readonly minY: number
    readonly maxX: number
    readonly maxY: number
  } => ({
    minX: (0 - viewTransform.x) / viewTransform.scale,
    minY: (0 - viewTransform.y) / viewTransform.scale,
    maxX: (surface.designSize.width - viewTransform.x) / viewTransform.scale,
    maxY: (surface.designSize.height - viewTransform.y) / viewTransform.scale,
  })

  const clampPosition = (
    widget: CompiledProcessSurfaceWidget,
    position: ProcessSurfaceWidgetPosition,
  ): ProcessSurfaceWidgetPosition => {
    const visible = visibleContentBounds()
    const minX = Math.min(0, visible.minX)
    const minY = Math.min(0, visible.minY)
    const maxX = Math.max(surface.designSize.width - widget.geometry.width, visible.maxX - widget.geometry.width)
    const maxY = Math.max(surface.designSize.height - widget.geometry.height, visible.maxY - widget.geometry.height)
    return {
      x: Math.max(minX, Math.min(maxX, position.x)),
      y: Math.max(minY, Math.min(maxY, position.y)),
    }
  }

  const startDrag = (event: PointerEvent, widget: CompiledProcessSurfaceWidget): void => {
    if (!onWidgetPositionChange || event.button !== 0) return
    const point = contentPointFor(event)
    if (!point) return
    event.stopPropagation()
    const target = event.currentTarget as Element
    target.setPointerCapture(event.pointerId)
    dragState = {
      pointerId: event.pointerId,
      widgetId: widget.id,
      pointerStart: point,
      origin: widgetPositionFor(widget, widgetPositions),
    }
  }

  const updateDrag = (event: PointerEvent): void => {
    const currentDrag = dragState
    if (!currentDrag || currentDrag.pointerId !== event.pointerId || !onWidgetPositionChange) return
    const widget = surface.widgets.find(candidate => candidate.id === currentDrag.widgetId)
    const point = contentPointFor(event)
    if (!widget || !point) return
    event.stopPropagation()
    onWidgetPositionChange(widget.id, clampPosition(widget, {
      x: currentDrag.origin.x + point.x - currentDrag.pointerStart.x,
      y: currentDrag.origin.y + point.y - currentDrag.pointerStart.y,
    }), false)
  }

  const finishDrag = (event: PointerEvent): void => {
    const currentDrag = dragState
    if (!currentDrag || currentDrag.pointerId !== event.pointerId || !onWidgetPositionChange) return
    const widget = surface.widgets.find(candidate => candidate.id === currentDrag.widgetId)
    const point = contentPointFor(event)
    if (widget && point) {
      onWidgetPositionChange(widget.id, clampPosition(widget, {
        x: currentDrag.origin.x + point.x - currentDrag.pointerStart.x,
        y: currentDrag.origin.y + point.y - currentDrag.pointerStart.y,
      }), true)
    }
    dragState = null
  }

  const clampScale = (value: number): number =>
    Math.max(0.35, Math.min(3.5, value))

  const zoomSurface = (event: WheelEvent): void => {
    const point = svgPointFor(event)
    if (!point) return
    event.preventDefault()
    const nextScale = clampScale(viewTransform.scale * Math.exp(-event.deltaY * 0.0014))
    if (nextScale === viewTransform.scale) return
    const scaleRatio = nextScale / viewTransform.scale
    viewTransform = {
      x: point.x - (point.x - viewTransform.x) * scaleRatio,
      y: point.y - (point.y - viewTransform.y) * scaleRatio,
      scale: nextScale,
    }
  }

  const startPan = (event: PointerEvent): void => {
    if (event.button !== 0 || event.target !== svgElement) return
    const point = svgPointFor(event)
    if (!point) return
    event.preventDefault()
    const target = event.currentTarget as Element
    target.setPointerCapture(event.pointerId)
    panState = {
      pointerId: event.pointerId,
      pointerStart: point,
      origin: { x: viewTransform.x, y: viewTransform.y },
    }
  }

  const updatePan = (event: PointerEvent): void => {
    const currentPan = panState
    if (!currentPan || currentPan.pointerId !== event.pointerId) return
    const point = svgPointFor(event)
    if (!point) return
    event.preventDefault()
    viewTransform = {
      ...viewTransform,
      x: currentPan.origin.x + point.x - currentPan.pointerStart.x,
      y: currentPan.origin.y + point.y - currentPan.pointerStart.y,
    }
  }

  const finishPan = (event: PointerEvent): void => {
    const currentPan = panState
    if (!currentPan || currentPan.pointerId !== event.pointerId) return
    updatePan(event)
    panState = null
  }
</script>

<div class="process-surface-viewport">
  <svg
    bind:this={svgElement}
    class="process-surface-svg {panState ? 'panning' : ''}"
    viewBox="0 0 {surface.designSize.width} {surface.designSize.height}"
    role="img"
    aria-label={surface.title}
    onwheel={zoomSurface}
    onpointerdown={startPan}
    onpointermove={updatePan}
    onpointerup={finishPan}
    onpointercancel={finishPan}
  >
    <defs>
      <linearGradient id="process-vessel-fill" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.72" />
        <stop offset="100%" stop-color="#93c5fd" stop-opacity="0.38" />
      </linearGradient>
    </defs>

    <g transform="translate({viewTransform.x} {viewTransform.y}) scale({viewTransform.scale})">
      {#if showUnitOverviewGuides}
        <g class="process-surface-guide-layer" aria-hidden="true">
          <rect class="process-surface-system-zone primary-zone" x="34" y="118" width="386" height="642" rx="2" />
          <rect class="process-surface-system-zone heat-transfer-zone" x="438" y="118" width="892" height="642" rx="2" />
          <rect class="process-surface-system-zone secondary-zone" x="1308" y="118" width="258" height="642" rx="2" />
          <rect class="process-surface-header-lane steam-lane" x="438" y="124" width="892" height="104" rx="2" />
          <rect class="process-surface-header-lane feedwater-lane" x="438" y="716" width="892" height="104" rx="2" />
          <text class="process-surface-zone-label" x="54" y="138">PRIMARY SYSTEM</text>
          <text class="process-surface-zone-label" x="458" y="138">HEAT TRANSFER / FOUR-LOOP PWR</text>
          <text class="process-surface-zone-label" x="1328" y="138">SECONDARY SYSTEM</text>
          <text class="process-surface-lane-label" x="458" y="150">MAIN STEAM</text>
          <text class="process-surface-lane-label" x="458" y="742">FEEDWATER</text>
        </g>
      {/if}

      {#each renderedPaths as path (path.id)}
        {@const points = pathPointsFor({ surface, widgetPositions, path })}
        {@const data = pathDataFor(points)}
        <path class="process-flow-casing" d={data} />
        <path
          class={serviceClass(path)}
          d={data}
        />
      {/each}

      {#each renderedWidgets as widget (widget.id)}
        <ProcessSurfaceWidget
          {widget}
          geometry={widgetGeometryFor(widget, widgetPositions)}
          {values}
          {alarms}
          dragging={dragState?.widgetId === widget.id}
          renderScale={viewTransform.scale}
          onStartDrag={startDrag}
          onUpdateDrag={updateDrag}
          onFinishDrag={finishDrag}
        />
      {/each}
    </g>
  </svg>
</div>
