<script lang="ts">
  import type { ComposedComparisonPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { median } from './panel-presenters.ts'
  import { formatValue, paddedDomain, rawDomain, unitLabel, type ValueDomain } from './trend-geometry.ts'

  let { panel, latest, range }: {
    panel: ComposedComparisonPanel
    latest: ComposedDisplaySample | undefined
    range: ValueDomain | null
  } = $props()

  let width = $state(520)
  const labelWidth = 150
  const valueWidth = 120
  const barStart = labelWidth
  const barWidth = $derived(Math.max(60, width - labelWidth - valueWidth))

  const valueOf = (path: string): number | undefined => {
    const value = latest?.values.find(entry => entry.path === path)?.value
    return typeof value === 'number' ? value : undefined
  }
  const values = $derived(panel.pens.map(pen => valueOf(String(pen.path))))
  const center = $derived(median(values.filter((value): value is number => value !== undefined)))

  // Fixed, grow-only scale over the values seen and the drawn thresholds.
  const domain = $derived.by((): ValueDomain | null => {
    const raw = rawDomain([
      ...(range === null ? [] : [range.min, range.max]),
      ...panel.thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => threshold.value),
    ])
    return raw === null ? null : paddedDomain(raw)
  })
  const x = (value: number): number => domain === null ? barStart : barStart + ((value - domain.min) / (domain.max - domain.min)) * barWidth
  const row = composedDisplayLayout.comparisonRow
  const top = composedDisplayLayout.comparisonHeader
  const height = $derived(top + row * panel.pens.length)
  const deviation = (value: number): string => {
    if (center === null) return ''
    const difference = value - center
    return Math.abs(difference) < 1e-9 ? '= median' : `${difference > 0 ? '+' : '−'}${formatValue(Math.abs(difference))}`
  }
</script>

<div class="comparison" bind:clientWidth={width}>
  <svg {width} {height} role="img" aria-label={`Comparison: ${panel.pens.map((pen, index) => `${pen.tagId ?? pen.path} ${values[index] === undefined ? 'no value' : formatValue(values[index]!)}`).join('; ')} ${unitLabel(panel.unit)}`}>
    <text class="head" x="0" y="13">Compared now · {unitLabel(panel.unit)}</text>
    {#if center !== null && domain !== null}
      <line class="median" x1={x(center)} x2={x(center)} y1={top - 4} y2={height} />
      <text class="head" x={x(center) + 3} y={height - 3}>median</text>
    {/if}
    {#if domain !== null}
      {#each panel.thresholds.filter(threshold => threshold.kind !== 'control') as threshold (threshold.ruleId)}
        <line class="threshold" class:qualified={threshold.modeLabel !== undefined} x1={x(threshold.value)} x2={x(threshold.value)} y1={top - 4} y2={height}><title>{threshold.label}: {threshold.value} {unitLabel(panel.unit)}</title></line>
        <text class="head" x={x(threshold.value)} y="13" text-anchor="middle">{threshold.kind === 'trip' ? 'TRIP' : 'ALM'} {threshold.value}</text>
      {/each}
    {/if}
    {#each panel.pens as pen, index (pen.path)}
      {@const value = values[index]}
      {@const y = top + index * row}
      <text class="tag" class:primary={pen.role === 'primary'} x="0" y={y + row / 2} dominant-baseline="middle">{pen.tagId ?? pen.path}<title>{pen.label} · {pen.role}</title></text>
      <rect class="track" x={barStart} y={y + 6} width={barWidth} height={row - 12} />
      {#if value !== undefined && domain !== null}
        <rect class="bar" class:primary={pen.role === 'primary'} x={barStart} y={y + 6} width={Math.max(1, x(value) - barStart)} height={row - 12} />
        <text class="value" x={barStart + barWidth + 8} y={y + row / 2} dominant-baseline="middle">{formatValue(value)} <tspan class="deviation">{deviation(value)}</tspan></text>
      {:else}
        <text class="value" x={barStart + barWidth + 8} y={y + row / 2} dominant-baseline="middle">—</text>
      {/if}
    {/each}
  </svg>
</div>

<style>
  .comparison { width: 100%; }
  svg { display: block; overflow: visible; }
  .head { fill: var(--element-neutral-color); font-size: 11px; }
  .tag { fill: var(--element-active-color); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tag.primary { font-weight: 700; }
  .track { fill: var(--container-section-color); }
  /* Outliers stand out by weight and position, not colour (ISA-101). */
  .bar { fill: var(--element-neutral-color); }
  .bar.primary { fill: var(--element-active-color); }
  .value { fill: var(--element-active-color); font-size: 12px; font-variant-numeric: tabular-nums; }
  .deviation { fill: var(--element-neutral-color); font-size: 11px; }
  .median { stroke: var(--element-neutral-color); stroke-dasharray: 2 3; }
  .threshold { stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .threshold.qualified { stroke-dasharray: 5 3; }
</style>
