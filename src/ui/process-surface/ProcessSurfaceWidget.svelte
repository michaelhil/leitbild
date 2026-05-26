<script lang="ts">
  import type { CompiledProcessSurfaceWidget, ProcessSurfaceValue } from '../../packs/process-plant/surfaces/index.ts'
  import { bindingRowsFor, levelFractionFor } from './process-surface-rendering.ts'

  interface Props {
    readonly widget: CompiledProcessSurfaceWidget
    readonly geometry: CompiledProcessSurfaceWidget['geometry']
    readonly values: ReadonlyMap<string, ProcessSurfaceValue>
    readonly dragging?: boolean
    readonly onStartDrag?: (event: PointerEvent, widget: CompiledProcessSurfaceWidget) => void
    readonly onUpdateDrag?: (event: PointerEvent) => void
    readonly onFinishDrag?: (event: PointerEvent) => void
  }

  let {
    widget,
    geometry,
    values,
    dragging = false,
    onStartDrag,
    onUpdateDrag,
    onFinishDrag,
  }: Props = $props()

  const rows = $derived(bindingRowsFor(widget, values))
  const levelFraction = $derived(levelFractionFor(widget, values))
  const rowLimit = $derived(widget.type === 'statusBanner' || widget.type === 'alarmStrip' ? 4 : 3)
  const displayRows = $derived(rows.slice(0, rowLimit))
  const widgetClass = $derived(`process-widget ${widget.type} ${widget.style.tone ?? 'primary'} ${dragging ? 'dragging' : ''}`)
  const shortTitle = $derived(widget.label.length > 22 ? `${widget.label.slice(0, 20)}...` : widget.label)
  const pumpRadius = $derived(Math.min(geometry.width, geometry.height) * 0.36)
  const pumpValue = $derived(rows.find(row => row.label.toLowerCase().includes('speed')) ?? rows[0])
  const levelHeight = $derived(Math.max(0, (geometry.height - 34) * levelFraction))
  const levelY = $derived(geometry.height - 18 - levelHeight)
</script>

<g
  class={widgetClass}
  transform="translate({geometry.x} {geometry.y})"
  role="button"
  tabindex="0"
  aria-label="Move {widget.label}"
  onpointerdown={(event) => onStartDrag?.(event, widget)}
  onpointermove={(event) => onUpdateDrag?.(event)}
  onpointerup={(event) => onFinishDrag?.(event)}
  onpointercancel={(event) => onFinishDrag?.(event)}
>
  {#if widget.type === 'vessel'}
    <rect class="widget-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="10" />
    <rect class="widget-level-fill" x="12" y={levelY} width={geometry.width - 24} height={levelHeight} rx="8" />
    <line class="widget-reference-line" x1="12" x2={geometry.width - 12} y1={geometry.height * 0.32} y2={geometry.height * 0.32} />
    <text class="widget-title" x="16" y="22">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <text class="widget-readout" x="16" y={geometry.height - 50 + index * 17}>
        <tspan class="widget-readout-label">{row.label}</tspan>
        <tspan dx="4">{row.formatted}</tspan>
      </text>
    {/each}
  {:else if widget.type === 'heatExchanger'}
    <rect class="widget-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="10" />
    <rect class="widget-level-fill" x="12" y={levelY} width={geometry.width - 24} height={levelHeight} rx="8" />
    <path class="widget-coil" d="M {geometry.width * 0.28} {geometry.height * 0.18} C {geometry.width * 0.72} {geometry.height * 0.30}, {geometry.width * 0.28} {geometry.height * 0.44}, {geometry.width * 0.72} {geometry.height * 0.56} S {geometry.width * 0.28} {geometry.height * 0.78}, {geometry.width * 0.72} {geometry.height * 0.88}" />
    <text class="widget-title" x="16" y="22">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <text class="widget-readout" x="16" y={geometry.height - 48 + index * 16}>
        <tspan class="widget-readout-label">{row.label}</tspan>
        <tspan dx="4">{row.formatted}</tspan>
      </text>
    {/each}
  {:else if widget.type === 'pump'}
    <circle class="widget-shell" cx={geometry.width / 2} cy={geometry.height / 2} r={pumpRadius} />
    <circle class="widget-ring" cx={geometry.width / 2} cy={geometry.height / 2} r={pumpRadius * 0.78} />
    <path class="widget-impeller" d="M {geometry.width / 2} {geometry.height * 0.24} L {geometry.width * 0.66} {geometry.height * 0.58} L {geometry.width * 0.34} {geometry.height * 0.58} Z" />
    <text class="widget-title centered" x={geometry.width / 2} y={geometry.height * 0.18} text-anchor="middle">{shortTitle}</text>
    {#if pumpValue}
      <text class="widget-readout centered" x={geometry.width / 2} y={geometry.height * 0.78} text-anchor="middle">{pumpValue.formatted}</text>
    {/if}
  {:else if widget.type === 'valve'}
    <rect class="widget-shell" x="6" y={geometry.height * 0.30} width={geometry.width - 12} height={geometry.height * 0.40} rx="6" />
    <path class="widget-valve" d="M 16 {geometry.height * 0.33} L {geometry.width / 2} {geometry.height / 2} L 16 {geometry.height * 0.67} Z M {geometry.width - 16} {geometry.height * 0.33} L {geometry.width / 2} {geometry.height / 2} L {geometry.width - 16} {geometry.height * 0.67} Z" />
    <text class="widget-title centered" x={geometry.width / 2} y="18" text-anchor="middle">{shortTitle}</text>
    {#if displayRows[0]}
      <text class="widget-readout centered" x={geometry.width / 2} y={geometry.height - 10} text-anchor="middle">{displayRows[0].formatted}</text>
    {/if}
  {:else}
    <rect class="widget-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="8" />
    <text class="widget-title" x="16" y="22">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <text class="widget-readout" x="16" y={42 + index * 17}>
        <tspan class="widget-readout-label">{row.label}</tspan>
        <tspan dx="4">{row.formatted}</tspan>
      </text>
    {/each}
  {/if}
</g>
