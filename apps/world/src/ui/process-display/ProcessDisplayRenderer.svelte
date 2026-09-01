<script lang="ts">
  import type { CompiledProcessDisplay, CompiledProcessDisplayWidget, ProcessDisplayAlarmSnapshot, ProcessDisplayValue } from '../../packs/process-plant/displays/index.ts'
  import { emptyProcessDisplayAlarmSnapshot } from './process-display-client.ts'
  import ProcessDisplayWidget from './ProcessDisplayWidget.svelte'
  import type { ProcessDisplayLayout, ProcessDisplayWidgetPosition } from './process-display-layout.ts'
  import {
    pathDataFor,
    pathPointsFor,
    widgetGeometryFor,
    widgetPositionFor,
  } from './process-display-rendering.ts'

  interface Props {
    readonly display: CompiledProcessDisplay
    readonly values: ReadonlyMap<string, ProcessDisplayValue>
    readonly alarms?: ProcessDisplayAlarmSnapshot
    readonly widgetPositions?: ProcessDisplayLayout
    readonly visibleWidgetIds?: ReadonlySet<string> | null
    readonly visiblePathIds?: ReadonlySet<string> | null
    readonly onWidgetPositionChange?: (widgetId: string, position: ProcessDisplayWidgetPosition, commit: boolean) => void
  }

  let {
    display,
    values,
    alarms = emptyProcessDisplayAlarmSnapshot,
    widgetPositions = {},
    visibleWidgetIds = null,
    visiblePathIds = null,
    onWidgetPositionChange,
  }: Props = $props()

  interface DragState {
    readonly pointerId: number
    readonly widgetId: string
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: ProcessDisplayWidgetPosition
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
    ? display.widgets.filter(widget => visibleWidgetIds.has(widget.id))
    : display.widgets)

  const renderedPaths = $derived(visiblePathIds
    ? display.paths.filter(path => visiblePathIds.has(path.id))
    : display.paths)

  const serviceClass = (path: { readonly style: { readonly service?: string } }): string =>
    `process-flow ${path.style.service ?? 'support'}`

  const showUnitOverviewGuides = $derived(display.id === 'unit-overview')
  const overviewLoopCount = $derived(display.widgets.filter(widget => widget.role === 'steam-generator').length)
  const secondaryGuideX = $derived(display.designSize.width - 292)
  const heatTransferGuideWidth = $derived(secondaryGuideX - 438 + 22)
  const overviewLoopLabel = $derived(`HEAT TRANSFER / ${overviewLoopCount}-LOOP PWR`)

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
    maxX: (display.designSize.width - viewTransform.x) / viewTransform.scale,
    maxY: (display.designSize.height - viewTransform.y) / viewTransform.scale,
  })

  const clampPosition = (
    widget: CompiledProcessDisplayWidget,
    position: ProcessDisplayWidgetPosition,
  ): ProcessDisplayWidgetPosition => {
    const visible = visibleContentBounds()
    const minX = Math.min(0, visible.minX)
    const minY = Math.min(0, visible.minY)
    const maxX = Math.max(display.designSize.width - widget.geometry.width, visible.maxX - widget.geometry.width)
    const maxY = Math.max(display.designSize.height - widget.geometry.height, visible.maxY - widget.geometry.height)
    return {
      x: Math.max(minX, Math.min(maxX, position.x)),
      y: Math.max(minY, Math.min(maxY, position.y)),
    }
  }

  const startDrag = (event: PointerEvent, widget: CompiledProcessDisplayWidget): void => {
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
    const widget = display.widgets.find(candidate => candidate.id === currentDrag.widgetId)
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
    const widget = display.widgets.find(candidate => candidate.id === currentDrag.widgetId)
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

  const zoomDisplay = (event: WheelEvent): void => {
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

<div class="process-display-viewport">
  <svg
    bind:this={svgElement}
    class="process-display-svg {panState ? 'panning' : ''}"
    viewBox="0 0 {display.designSize.width} {display.designSize.height}"
    role="img"
    aria-label={display.title}
    onwheel={zoomDisplay}
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
        <g class="process-display-guide-layer" aria-hidden="true">
          <rect class="process-display-system-zone primary-zone" x="34" y="118" width="386" height="642" rx="2" />
          <rect class="process-display-system-zone heat-transfer-zone" x="438" y="118" width={heatTransferGuideWidth} height="642" rx="2" />
          <rect class="process-display-system-zone secondary-zone" x={secondaryGuideX} y="118" width="258" height="642" rx="2" />
          <rect class="process-display-header-lane steam-lane" x="438" y="124" width={heatTransferGuideWidth} height="104" rx="2" />
          <rect class="process-display-header-lane feedwater-lane" x="438" y="716" width={heatTransferGuideWidth} height="104" rx="2" />
          <text class="process-display-zone-label" x="54" y="138">PRIMARY SYSTEM</text>
          <text class="process-display-zone-label" x="458" y="138">{overviewLoopLabel}</text>
          <text class="process-display-zone-label" x={secondaryGuideX + 20} y="138">SECONDARY SYSTEM</text>
          <text class="process-display-lane-label" x="458" y="150">MAIN STEAM</text>
          <text class="process-display-lane-label" x="458" y="742">FEEDWATER</text>
        </g>
      {/if}

      {#each renderedPaths as path (path.id)}
        {@const points = pathPointsFor({ display, widgetPositions, path })}
        {@const data = pathDataFor(points)}
        <path class="process-flow-casing" d={data} />
        <path
          class={serviceClass(path)}
          d={data}
        />
      {/each}

      {#each renderedWidgets as widget (widget.id)}
        <ProcessDisplayWidget
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
