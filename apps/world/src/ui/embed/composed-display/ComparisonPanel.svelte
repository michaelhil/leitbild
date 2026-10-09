<script lang="ts">
  import type { ComposedComparisonPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { displayValue, formatQuantity, formatValue, thresholdName } from '../../../packs/process-plant/displays/display-text.ts'
  import { activeThreshold, median, ratePerMinute, rateText, rateWindowMs, windowText } from './panel-presenters.ts'
  import { displayName } from './pen-style.ts'
  import { paddedDomain, rawDomain, type TrendPoint, type ValueDomain } from './trend-geometry.ts'

  let { panel, latest, series, range, activeRuleIds }: {
    panel: ComposedComparisonPanel
    latest: ComposedDisplaySample | undefined
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    range: ValueDomain | null
    activeRuleIds: ReadonlySet<string>
  } = $props()

  let width = $state(520)
  const labelWidth = 120
  const valueWidth = 220
  const scaleStart = labelWidth
  const scaleWidth = $derived(Math.max(60, width - labelWidth - valueWidth))

  const valueOf = (path: string): number | undefined => {
    const value = latest?.values.find(entry => entry.path === path)?.value
    return typeof value === 'number' ? value : undefined
  }
  const values = $derived(panel.pens.map(pen => valueOf(String(pen.path))))
  const center = $derived(median(values.filter((value): value is number => value !== undefined)))

  // Position on a fixed, grow-only scale, shown as a pointer: bar lengths from a
  // non-zero origin would exaggerate differences (HMI review).
  const domain = $derived.by((): ValueDomain | null => {
    const raw = rawDomain([
      ...(range === null ? [] : [range.min, range.max]),
      ...panel.thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => threshold.value),
    ])
    return raw === null ? null : paddedDomain(raw)
  })
  const x = (value: number): number => domain === null ? scaleStart : scaleStart + ((value - domain.min) / (domain.max - domain.min)) * scaleWidth
  const row = composedDisplayLayout.comparisonRow
  const top = composedDisplayLayout.comparisonHeader
  const height = $derived(top + row * panel.pens.length)
  const deviation = (value: number): string => {
    if (center === null) return ''
    const difference = value - center
    return Math.abs(difference) < 1e-9 ? '' : `${difference > 0 ? '+' : '−'}${formatValue(displayValue(Math.abs(difference), panel.unit))} vs median`
  }
  const lines = $derived(panel.thresholds.filter(threshold => threshold.kind !== 'control'))
  // The same 30 s window as a 10-minute trend's legend, so one signal never shows two rates.
  const RATE_WINDOW_MS = rateWindowMs(600_000)
</script>

<div class="comparison" bind:clientWidth={width}>
  <svg {width} {height} role="img" aria-label={`Comparison now: ${panel.pens.map((pen, index) => `${displayName(pen)} ${values[index] === undefined ? 'no value' : formatQuantity(values[index]!, panel.unit)}`).join('; ')}`}>
    {#if domain !== null}
      {#each lines as threshold (threshold.ruleId)}
        {@const active = threshold.ruleIds.some(ruleId => activeRuleIds.has(ruleId)) ? threshold.severity ?? 'warning' : null}
        <line class="threshold" class:qualified={threshold.modeLabel !== undefined} x1={x(threshold.value)} x2={x(threshold.value)} y1={top - 6} y2={height}><title>{threshold.label}</title></line>
        <text class={`head ${active === null ? '' : `active-${active}`}`} x={x(threshold.value)} y="12" text-anchor="middle">{thresholdName(threshold, panel.unit, { withUnit: false })}</text>
      {/each}
      {#if center !== null}
        <line class="median" x1={x(center)} x2={x(center)} y1={top - 2} y2={height} />
      {/if}
    {/if}
    {#each panel.pens as pen, index (pen.path)}
      {@const value = values[index]}
      {@const y = top + index * row}
      {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
      <text class="tag" class:primary={pen.role === 'primary'} x="0" y={y + row / 2} dominant-baseline="middle">{displayName(pen)}{pen.command ? ' (demand)' : ''}<title>{pen.label} · {pen.role}{pen.command ? ' · operator or automation demand, not a measured state' : ''}</title></text>
      <line class="track" x1={scaleStart} x2={scaleStart + scaleWidth} y1={y + row / 2} y2={y + row / 2} />
      {#if value !== undefined && domain !== null}
        <path class="pointer" class:primary={pen.role === 'primary'} class:alarm={inAlarm !== null} d={`M${x(value)} ${y + 4} l5 ${row / 2 - 4} l-5 ${row / 2 - 4} l-5 ${-(row / 2 - 4)} z`} />
        <text class="value" x={scaleStart + scaleWidth + 10} y={y + row / 2} dominant-baseline="middle">{formatQuantity(value, panel.unit)}{#if inAlarm !== null}<tspan class={`state ${inAlarm.severity ?? 'warning'}`} dx="6">{inAlarm.direction === 'low' ? 'LO' : 'HI'} {inAlarm.kind === 'trip' ? 'TRIP' : 'ALM'}</tspan>{/if}<tspan class="sub" dx="6">{deviation(value)} {rateText(ratePerMinute(series.get(String(pen.path)) ?? [], RATE_WINDOW_MS), value, panel.unit)}</tspan></text>
      {:else}
        <text class="value" x={scaleStart + scaleWidth + 10} y={y + row / 2} dominant-baseline="middle">—</text>
      {/if}
    {/each}
  </svg>
  {#if center !== null && domain !== null}<p class="caption">Scale {formatValue(displayValue(domain.min, panel.unit))}–{formatQuantity(domain.max, panel.unit)} · dotted line: median of the {panel.pens.length} signals now · rates over {windowText(RATE_WINDOW_MS)}</p>{/if}
</div>

<style>
  .comparison { width: 100%; }
  svg { display: block; overflow: visible; }
  .head { fill: var(--element-neutral-color); font-size: 10.5px; font-variant-numeric: tabular-nums; }
  .head.active-critical { fill: var(--alert-alarm-color); font-weight: 700; }
  .head.active-warning { fill: var(--alert-warning-color); font-weight: 700; }
  .head.active-notice, .head.active-info { fill: var(--alert-caution-color); font-weight: 700; }
  .tag { fill: var(--element-neutral-color); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tag.primary { fill: var(--element-active-color); font-weight: 700; }
  .track { stroke: var(--border-divider-color); stroke-width: 2; }
  /* Values stand out by shape and weight; alarm colour only while a rule is active. */
  .pointer { fill: var(--element-neutral-color); }
  .pointer.primary { fill: var(--element-active-color); }
  .pointer.alarm { stroke: var(--alert-warning-color); stroke-width: 2; }
  .value { fill: var(--element-active-color); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .sub { fill: var(--element-neutral-color); font-size: 11px; font-weight: 400; }
  /* Same meaning as the alarm chip elsewhere: shown only while the rule is active. */
  .state { font-size: 10.5px; font-weight: 700; }
  .state.critical { fill: var(--alert-alarm-color); }
  .state.warning { fill: var(--alert-warning-color); }
  .state.notice, .state.info { fill: var(--alert-caution-color); }
  .median { stroke: var(--element-neutral-color); stroke-dasharray: 2 3; }
  .threshold { stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .threshold.qualified { stroke-dasharray: 5 3; }
  .caption { margin: 0; font-size: 10.5px; color: var(--element-neutral-color); }
</style>
