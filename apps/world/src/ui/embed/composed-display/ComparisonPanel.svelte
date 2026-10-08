<script lang="ts">
  import type { ComposedComparisonPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { activeThreshold, median, ratePerMinute, rateText, thresholdName } from './panel-presenters.ts'
  import { displayName } from './pen-style.ts'
  import { formatValue, paddedDomain, rawDomain, unitLabel, type TrendPoint, type ValueDomain } from './trend-geometry.ts'
  import AlarmChip from './AlarmChip.svelte'

  let { panel, latest, series, range, activeRuleIds }: {
    panel: ComposedComparisonPanel
    latest: ComposedDisplaySample | undefined
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    range: ValueDomain | null
    activeRuleIds: ReadonlySet<string>
  } = $props()

  let width = $state(520)
  const labelWidth = 120
  const valueWidth = 190
  const scaleStart = labelWidth
  const scaleWidth = $derived(Math.max(60, width - labelWidth - valueWidth))
  const unit = $derived(unitLabel(panel.unit))

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
    return Math.abs(difference) < 1e-9 ? '' : `${difference > 0 ? '+' : '−'}${formatValue(Math.abs(difference))} vs median`
  }
  const lines = $derived(panel.thresholds.filter(threshold => threshold.kind !== 'control'))
</script>

<div class="comparison" bind:clientWidth={width}>
  <svg {width} {height} role="img" aria-label={`Comparison now: ${panel.pens.map((pen, index) => `${displayName(pen)} ${values[index] === undefined ? 'no value' : formatValue(values[index]!)}`).join('; ')} ${unit}`}>
    {#if domain !== null}
      {#each lines as threshold (threshold.ruleId)}
        {@const active = threshold.ruleIds.some(ruleId => activeRuleIds.has(ruleId))}
        <line class="threshold" class:qualified={threshold.modeLabel !== undefined} x1={x(threshold.value)} x2={x(threshold.value)} y1={top - 6} y2={height}><title>{threshold.label}</title></line>
        <text class={`head ${active ? `active-${threshold.kind}` : ''}`} x={x(threshold.value)} y="12" text-anchor="middle">{thresholdName(threshold, '')}</text>
      {/each}
      {#if center !== null}
        <line class="median" x1={x(center)} x2={x(center)} y1={top - 2} y2={height} />
      {/if}
    {/if}
    {#each panel.pens as pen, index (pen.path)}
      {@const value = values[index]}
      {@const y = top + index * row}
      {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
      <text class="tag" class:primary={pen.role === 'primary'} x="0" y={y + row / 2} dominant-baseline="middle">{displayName(pen)}<title>{pen.label} · {pen.role}</title></text>
      <line class="track" x1={scaleStart} x2={scaleStart + scaleWidth} y1={y + row / 2} y2={y + row / 2} />
      {#if value !== undefined && domain !== null}
        <path class="pointer" class:primary={pen.role === 'primary'} class:alarm={inAlarm !== null} d={`M${x(value)} ${y + 4} l5 ${row / 2 - 4} l-5 ${row / 2 - 4} l-5 ${-(row / 2 - 4)} z`} />
        <text class="value" x={scaleStart + scaleWidth + 10} y={y + row / 2} dominant-baseline="middle">{formatValue(value)} {unit}<tspan class="sub" dx="6">{deviation(value)} {rateText(ratePerMinute(series.get(String(pen.path)) ?? []), value, unit)}</tspan></text>
      {:else}
        <text class="value" x={scaleStart + scaleWidth + 10} y={y + row / 2} dominant-baseline="middle">—</text>
      {/if}
      {#if inAlarm !== null}
        <foreignObject x={labelWidth - 52} y={y + 3} width="50" height={row - 6}><AlarmChip threshold={inAlarm} /></foreignObject>
      {/if}
    {/each}
  </svg>
  {#if center !== null}<p class="caption">Dotted line: median of the {panel.pens.length} signals now.</p>{/if}
</div>

<style>
  .comparison { width: 100%; }
  svg { display: block; overflow: visible; }
  .head { fill: var(--element-neutral-color); font-size: 10.5px; font-variant-numeric: tabular-nums; }
  .head.active-trip { fill: var(--alert-alarm-color); font-weight: 700; }
  .head.active-alarm { fill: var(--alert-warning-color); font-weight: 700; }
  .tag { fill: var(--element-neutral-color); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tag.primary { fill: var(--element-active-color); font-weight: 700; }
  .track { stroke: var(--border-divider-color); stroke-width: 2; }
  /* Values stand out by shape and weight; alarm colour only while a rule is active. */
  .pointer { fill: var(--element-neutral-color); }
  .pointer.primary { fill: var(--element-active-color); }
  .pointer.alarm { stroke: var(--alert-warning-color); stroke-width: 2; }
  .value { fill: var(--element-active-color); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .sub { fill: var(--element-neutral-color); font-size: 11px; font-weight: 400; }
  .median { stroke: var(--element-neutral-color); stroke-dasharray: 2 3; }
  .threshold { stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .threshold.qualified { stroke-dasharray: 5 3; }
  .caption { margin: 0; font-size: 10.5px; color: var(--element-neutral-color); }
</style>
