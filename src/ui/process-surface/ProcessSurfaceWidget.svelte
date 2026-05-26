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
  const rowLimit = $derived(widget.role === 'steam-generator'
    ? 6
    : widget.type === 'statusBanner' || widget.type === 'alarmStrip' ? 4 : 3)
  const displayRows = $derived(rows.slice(0, rowLimit))
  const widgetClass = $derived(`process-widget ${widget.type} ${widget.role ?? 'generic'} ${widget.style.tone ?? 'primary'} ${dragging ? 'dragging' : ''}`)
  const shortTitle = $derived(widget.label.length > 22 ? `${widget.label.slice(0, 20)}...` : widget.label)
  const pumpRadius = $derived(Math.min(geometry.width, geometry.height) * 0.36)
  const pumpValue = $derived(rows.find(row => row.label.toLowerCase().includes('speed')) ?? rows[0])
  const levelHeight = $derived(Math.max(0, (geometry.height - 34) * levelFraction))
  const levelY = $derived(geometry.height - 18 - levelHeight)
  const rowFor = (key: string): ProcessSurfaceValue | undefined => {
    const binding = widget.binds[key]
    return binding ? values.get(binding.path) : undefined
  }
  const numericValue = (key: string): number | null => {
    const value = rowFor(key)?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const sgDisplayFor = (key: string): { readonly label: string; readonly formatted: string } | undefined => {
    const binding = widget.binds[key]
    const value = binding ? values.get(binding.path) : undefined
    if (!binding || !value) return undefined
    return { label: binding.label ?? value.label, formatted: value.formatted }
  }
  const sgAlert = $derived((numericValue('radiation') ?? 0) > 1 || levelFraction < 0.22 || levelFraction > 0.84)
  const sgLevelHeight = $derived(Math.max(0, 188 * levelFraction))
  const sgLevelY = $derived(260 - sgLevelHeight)
  const sgReadoutKeys = ['pressure', 'steam', 'feedwater', 'heat']
  const sgLevel = $derived(sgDisplayFor('level'))
  const sgRadiation = $derived(sgDisplayFor('radiation'))
  const sgStateLabel = $derived(sgAlert ? 'CHECK' : 'NORM')
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
  {#if widget.type === 'statusBanner'}
    <rect class="overview-status-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="4" />
    <text class="overview-status-title" x="16" y="25">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <g transform="translate({220 + index * 300} 0)">
        <text class="overview-status-label" x="0" y="24">{row.label}</text>
        <text class="overview-status-value" x="0" y="50">{row.formatted}</text>
      </g>
    {/each}
  {:else if widget.role === 'steam-generator'}
    <rect class="sg-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="2" class:alert={sgAlert} />
    <line class="sg-section-rule" x1="0" x2={geometry.width} y1="38" y2="38" />
    <line class="sg-section-rule" x1="0" x2={geometry.width} y1="284" y2="284" />
    <text class="widget-title sg-title" x="12" y="23">{shortTitle}</text>
    <text class="sg-type-label" x="58" y="23">STEAM GENERATOR</text>
    <rect class="sg-state-pill" x={geometry.width - 58} y="10" width="46" height="17" rx="2" class:alert={sgAlert} />
    <text class="sg-state-text" x={geometry.width - 35} y="22" text-anchor="middle">{sgStateLabel}</text>
    {#if sgRadiation}
      <text class="sg-radiation-text" x={geometry.width - 12} y="52" text-anchor="end">RAD {sgRadiation.formatted}</text>
    {/if}

    <text class="sg-instrument-label" x="15" y="58">LEVEL</text>
    <rect class="sg-level-track" x="16" y="72" width="32" height="188" rx="1" />
    <rect class="sg-level-fill" x="19" y={sgLevelY} width="26" height={sgLevelHeight} rx="1" />
    <line class="sg-level-reference" x1="11" x2="53" y1="166" y2="166" />
    <line class="sg-level-reference low" x1="15" x2="49" y1="222" y2="222" />
    {#if sgLevel}
      <text class="sg-level-value" x="32" y="275" text-anchor="middle">{sgLevel.formatted}</text>
    {/if}

    <g class="sg-vessel" transform="translate(62 54)">
      <path class="sg-vessel-outline" d="M 32 0 H 70 C 82 0 90 9 90 21 V 191 C 90 204 81 214 68 214 H 34 C 21 214 12 204 12 191 V 21 C 12 9 20 0 32 0 Z" />
      <path class="sg-vessel-cap" d="M 32 0 H 70 C 82 0 90 9 90 21 H 12 C 12 9 20 0 32 0 Z" />
      <line class="sg-secondary-waterline" x1="18" x2="84" y1="78" y2="78" />
      <path class="sg-primary-bundle" d="M 36 32 C 80 45, 80 78, 37 91 C 20 96, 20 128, 37 134 C 80 149, 80 182, 36 195" />
      <path class="sg-primary-bundle secondary" d="M 51 31 C 94 45, 94 78, 52 91 C 35 96, 35 128, 52 134 C 94 149, 94 182, 51 195" />
      <path class="sg-steam-riser" d="M 51 -30 V 0" />
      <path class="sg-feedwater-line" d="M 51 214 V 248" />
      <text class="sg-port-label steam" x="58" y="-15">STEAM</text>
      <text class="sg-port-label feedwater" x="58" y="240">FW</text>
    </g>

    <g class="sg-metrics" transform="translate(14 306)">
      {#each sgReadoutKeys as key, index (key)}
        {@const row = sgDisplayFor(key)}
        {#if row}
          <g class="sg-metric-cell" transform="translate({(index % 2) * 94} {Math.floor(index / 2) * 30})">
            <text class="widget-readout-label sg-metric-label" x="0" y="0">{row.label}</text>
            <text class="widget-readout sg-readout" x="0" y="15">{row.formatted}</text>
          </g>
        {/if}
      {/each}
    </g>
  {:else if widget.type === 'numericReadout' || widget.type === 'alarmStrip'}
    <rect class="overview-readout-shell" x="0" y="0" width={geometry.width} height={geometry.height} rx="4" />
    <text class="widget-title overview-readout-title" x="14" y="21">{shortTitle}</text>
    {#each displayRows as row, index (row.path)}
      <text class="widget-readout overview-readout" x={14 + index * Math.max(92, (geometry.width - 28) / Math.max(1, displayRows.length))} y={geometry.height - 16}>
        <tspan class="widget-readout-label">{row.label}</tspan>
        <tspan dx="5">{row.formatted}</tspan>
      </text>
    {/each}
  {:else if widget.type === 'vessel'}
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
