<script lang="ts">
  import type { CompiledProcessSurface, CompiledProcessSurfacePath, CompiledProcessSurfaceWidget, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'
  import type { ProcessSurfaceLayout, ProcessSurfaceWidgetPosition } from './process-surface-layout.ts'

  interface Props {
    readonly surface: CompiledProcessSurface
    readonly values: ReadonlyMap<string, ProcessSurfaceValue>
    readonly widgetPositions?: ProcessSurfaceLayout
    readonly onWidgetPositionChange?: (widgetId: string, position: ProcessSurfaceWidgetPosition, commit: boolean) => void
  }

  let {
    surface,
    values,
    widgetPositions = {},
    onWidgetPositionChange,
  }: Props = $props()

  interface DragState {
    readonly pointerId: number
    readonly widgetId: string
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: ProcessSurfaceWidgetPosition
  }

  let svgElement: SVGSVGElement | null = $state(null)
  let dragState = $state<DragState | null>(null)

  const valueFor = (path: string): ProcessSurfaceValue | undefined =>
    values.get(path)

  const numericValueFor = (path: string): number | null => {
    const value = valueFor(path)?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  const bindingRows = (widget: CompiledProcessSurfaceWidget): ReadonlyArray<ProcessSurfaceValue> =>
    Object.values(widget.binds).map(binding => valueFor(binding.path)).filter(value => value !== undefined)

  const widgetPositionFor = (widget: CompiledProcessSurfaceWidget): ProcessSurfaceWidgetPosition =>
    widgetPositions[widget.id] ?? { x: widget.geometry.x, y: widget.geometry.y }

  const widgetGeometryFor = (
    widget: CompiledProcessSurfaceWidget,
  ): CompiledProcessSurfaceWidget['geometry'] => ({
    ...widget.geometry,
    ...widgetPositionFor(widget),
  })

  const levelFractionFor = (widget: CompiledProcessSurfaceWidget): number => {
    const levelBinding = widget.binds.level
    if (!levelBinding) return 0.5
    const value = numericValueFor(levelBinding.path)
    if (value === null) return 0.5
    return Math.max(0, Math.min(1, value > 1 ? value / 100 : value))
  }

  const portPointFor = (
    widgetId: string,
    portName: string,
  ): { readonly x: number; readonly y: number } | null => {
    const widget = surface.widgets.find(candidate => candidate.id === widgetId)
    const original = widget?.ports[portName]
    if (!widget || !original) return null
    const position = widgetPositionFor(widget)
    return {
      x: original.x + position.x - widget.geometry.x,
      y: original.y + position.y - widget.geometry.y,
    }
  }

  const pathPoints = (path: CompiledProcessSurfacePath): ReadonlyArray<{ readonly x: number; readonly y: number }> => {
    const from = portPointFor(path.from.widgetId, path.from.portName)
    const to = portPointFor(path.to.widgetId, path.to.portName)
    if (!from || !to) return path.points
    const midX = (from.x + to.x) / 2
    return [
      from,
      { x: midX, y: from.y },
      { x: midX, y: to.y },
      to,
    ]
  }

  const pathData = (path: CompiledProcessSurfacePath): string =>
    pathPoints(path).map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')

  const pathFlowFraction = (path: CompiledProcessSurfacePath): number => {
    const binding = path.binds.flow ?? Object.values(path.binds)[0]
    if (!binding) return 0
    const value = numericValueFor(binding.path)
    if (value === null) return 0
    return Math.max(0.15, Math.min(1, Math.abs(value) / 5_000))
  }

  const serviceClass = (path: CompiledProcessSurfacePath): string =>
    `process-flow ${path.style.service ?? 'support'}`

  const widgetClass = (widget: CompiledProcessSurfaceWidget): string =>
    `process-widget ${widget.type} ${widget.style.tone ?? 'primary'}`

  const svgPointFor = (event: PointerEvent): { readonly x: number; readonly y: number } | null => {
    const svg = svgElement
    const matrix = svg?.getScreenCTM()?.inverse()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const transformed = point.matrixTransform(matrix)
    return { x: transformed.x, y: transformed.y }
  }

  const clampPosition = (
    widget: CompiledProcessSurfaceWidget,
    position: ProcessSurfaceWidgetPosition,
  ): ProcessSurfaceWidgetPosition => ({
    x: Math.max(0, Math.min(surface.designSize.width - widget.geometry.width, position.x)),
    y: Math.max(0, Math.min(surface.designSize.height - widget.geometry.height, position.y)),
  })

  const startDrag = (event: PointerEvent, widget: CompiledProcessSurfaceWidget): void => {
    if (!onWidgetPositionChange || event.button !== 0) return
    const point = svgPointFor(event)
    if (!point) return
    event.stopPropagation()
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    dragState = {
      pointerId: event.pointerId,
      widgetId: widget.id,
      pointerStart: point,
      origin: widgetPositionFor(widget),
    }
  }

  const updateDrag = (event: PointerEvent): void => {
    const currentDrag = dragState
    if (!currentDrag || currentDrag.pointerId !== event.pointerId || !onWidgetPositionChange) return
    const widget = surface.widgets.find(candidate => candidate.id === currentDrag.widgetId)
    const point = svgPointFor(event)
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
    const point = svgPointFor(event)
    if (widget && point) {
      onWidgetPositionChange(widget.id, clampPosition(widget, {
        x: currentDrag.origin.x + point.x - currentDrag.pointerStart.x,
        y: currentDrag.origin.y + point.y - currentDrag.pointerStart.y,
      }), true)
    }
    dragState = null
  }
</script>

<div class="process-surface-viewport">
  <svg
    bind:this={svgElement}
    class="process-surface-svg"
    viewBox="0 0 {surface.designSize.width} {surface.designSize.height}"
    role="img"
    aria-label={surface.title}
  >
    <defs>
      <linearGradient id="process-vessel-fill" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.72" />
        <stop offset="100%" stop-color="#93c5fd" stop-opacity="0.38" />
      </linearGradient>
      <marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
        <path d="M 0 0 L 8 4 L 0 8 z" class="process-flow-arrow" />
      </marker>
    </defs>

    {#each surface.paths as path (path.id)}
      <path class="process-flow-casing" d={pathData(path)} />
      <path
        class={serviceClass(path)}
        d={pathData(path)}
        pathLength="1"
        stroke-dasharray="{pathFlowFraction(path)} 0.18"
        marker-end="url(#flow-arrow)"
      />
    {/each}

    {#each surface.widgets as widget (widget.id)}
      {@const geometry = widgetGeometryFor(widget)}
      <g
        class="{widgetClass(widget)} {dragState?.widgetId === widget.id ? 'dragging' : ''}"
        transform="translate({geometry.x} {geometry.y})"
        role="button"
        tabindex="0"
        aria-label="Move {widget.label}"
        onpointerdown={(event) => startDrag(event, widget)}
        onpointermove={updateDrag}
        onpointerup={finishDrag}
        onpointercancel={finishDrag}
      >
        {#if widget.type === 'vessel' || widget.type === 'heatExchanger'}
          <rect class="widget-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="18" />
          <rect
            class="widget-level-fill"
            x="10"
            y={(geometry.height - 10) - (geometry.height - 20) * levelFractionFor(widget)}
            width={geometry.width - 20}
            height={(geometry.height - 20) * levelFractionFor(widget)}
            rx="12"
          />
          {#if widget.type === 'heatExchanger'}
            <path class="widget-coil" d="M {geometry.width * 0.28} {geometry.height * 0.18} C {geometry.width * 0.72} {geometry.height * 0.30}, {geometry.width * 0.28} {geometry.height * 0.44}, {geometry.width * 0.72} {geometry.height * 0.56} S {geometry.width * 0.28} {geometry.height * 0.78}, {geometry.width * 0.72} {geometry.height * 0.88}" />
          {/if}
        {:else if widget.type === 'pump'}
          <circle class="widget-shell" cx={geometry.width / 2} cy={geometry.height / 2} r={Math.min(geometry.width, geometry.height) * 0.42} />
          <circle class="widget-ring" cx={geometry.width / 2} cy={geometry.height / 2} r={Math.min(geometry.width, geometry.height) * 0.34} />
          <path class="widget-impeller" d="M {geometry.width / 2} {geometry.height * 0.22} L {geometry.width * 0.68} {geometry.height * 0.58} L {geometry.width * 0.32} {geometry.height * 0.58} Z" />
        {:else if widget.type === 'valve'}
          <rect class="widget-shell" x="8" y={geometry.height * 0.28} width={geometry.width - 16} height={geometry.height * 0.44} rx="8" />
          <path class="widget-valve" d="M 16 {geometry.height * 0.32} L {geometry.width / 2} {geometry.height / 2} L 16 {geometry.height * 0.68} Z M {geometry.width - 16} {geometry.height * 0.32} L {geometry.width / 2} {geometry.height / 2} L {geometry.width - 16} {geometry.height * 0.68} Z" />
        {:else}
          <rect class="widget-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="14" />
        {/if}
        <text class="widget-title" x={geometry.width / 2} y="24" text-anchor="middle">{widget.label}</text>
        {#each bindingRows(widget).slice(0, widget.type === 'statusBanner' || widget.type === 'alarmStrip' ? 4 : 3) as row, index (row.path)}
          <text class="widget-readout" x="16" y={geometry.height - 18 - (bindingRows(widget).slice(0, 4).length - index - 1) * 19}>
            {row.label}: {row.formatted}
          </text>
        {/each}
      </g>
    {/each}
  </svg>
</div>
