<script lang="ts">
  import type { ComposedTrendPanel } from '../../../packs/process-plant/displays/compose.ts'
  import {
    formatValue,
    paddedDomain,
    rawDomain,
    stepPath,
    timeTicks,
    unitLabel,
    valueTicks,
    type TrendPoint,
    type ValueDomain,
  } from './trend-geometry.ts'
  import { penStroke } from './pen-style.ts'
  import { thresholdName } from './panel-presenters.ts'

  let {
    panel,
    series,
    range,
    now,
    issuedAt,
    height,
    activeRuleIds,
  }: {
    panel: ComposedTrendPanel
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    range: ValueDomain | null
    now: number
    issuedAt: number
    height: number
    /** I&C rules active now; their threshold labels take the alarm colour. */
    activeRuleIds: ReadonlySet<string>
  } = $props()

  let width = $state(520)
  const pad = { left: 44, right: 64, top: 18, bottom: 22 }

  // Trip and alarm thresholds always fit the scale; control set points are
  // marked on the axis only when they fall inside it, to keep the trend quiet.
  // World decides which thresholds are drawn (primary signals, one per action).
  const drawnThresholds = $derived(panel.thresholds.filter(threshold => threshold.kind !== 'control'))
  const controlThresholds = $derived(panel.thresholds.filter(threshold => threshold.kind === 'control'))

  // Fixed scale: the grow-only range seen since the view opened plus the drawn
  // thresholds. Control set points never widen it.
  const domain = $derived.by((): ValueDomain | null => {
    const raw = rawDomain([
      ...(range === null ? [] : [range.min, range.max]),
      ...drawnThresholds.map(threshold => threshold.value),
    ])
    return raw === null ? null : paddedDomain(raw)
  })

  const windowStart = $derived(now - panel.horizonMs)
  const plotWidth = $derived(Math.max(40, width - pad.left - pad.right))
  const plotHeight = $derived(Math.max(40, height - pad.top - pad.bottom))
  const x = (t: number): number => pad.left + ((t - windowStart) / panel.horizonMs) * plotWidth
  const y = (v: number): number => domain === null ? pad.top : pad.top + (1 - (v - domain.min) / (domain.max - domain.min)) * plotHeight

  const isActive = (threshold: { readonly ruleIds: ReadonlyArray<string> }): boolean => threshold.ruleIds.some(ruleId => activeRuleIds.has(ruleId))

  // Labels at the right edge are pushed apart so close thresholds stay legible.
  const LABEL_SPACING = 12
  const thresholdLabels = $derived.by(() => {
    const placed: Array<{ key: string; y: number; text: string; title: string; kind: string; active: boolean }> = []
    const sorted = [...drawnThresholds].sort((left, right) => right.value - left.value)
    for (const threshold of sorted) {
      const lineY = y(threshold.value)
      const previous = placed[placed.length - 1]
      placed.push({
        key: `${threshold.ruleId}`,
        y: previous === undefined ? lineY : Math.max(lineY, previous.y + LABEL_SPACING),
        // Thresholds are configured numbers; show them exactly, never rounded.
        text: thresholdName(threshold, ''),
        title: `${threshold.label} (${threshold.signals.join(', ')})${threshold.modeLabel === undefined ? '' : `, only in ${threshold.modeLabel}`}`,
        kind: threshold.kind,
        active: isActive(threshold),
      })
    }
    return placed
  })

  // Where the window starts before any recorded value, say so instead of
  // leaving an unexplained blank.
  const firstSampleAt = $derived(Math.min(...panel.pens.map(pen => series.get(String(pen.path))?.[0]?.t ?? Number.POSITIVE_INFINITY)))
  const gapEnd = $derived(Number.isFinite(firstSampleAt) ? Math.min(firstSampleAt, now) : now)
  const showGap = $derived(gapEnd - windowStart > panel.horizonMs * 0.05)

  const summary = $derived(panel.pens.map(pen => {
    const latest = series.get(String(pen.path))?.at(-1)
    return `${pen.tagId ?? pen.path} ${pen.label}: ${latest === undefined ? 'no value' : `${formatValue(latest.v)} ${unitLabel(pen.unit)}`}`
  }).join('; '))
</script>

<div class="trend" bind:clientWidth={width}>
  {#if domain === null}
    <p class="trend-empty">No values yet for this trend.</p>
  {:else}
    <svg {width} {height} role="img" aria-label={`Trend of the last ${panel.horizon}. ${summary}`}>
      <defs>
        <pattern id="no-data" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" class="hatch" />
        </pattern>
      </defs>
      {#if showGap}
        <rect x={pad.left} y={pad.top} width={Math.max(0, x(gapEnd) - pad.left)} height={plotHeight} fill="url(#no-data)" />
        <text class="gap-label" x={pad.left + (x(gapEnd) - pad.left) / 2} y={pad.top + plotHeight / 2} text-anchor="middle" dominant-baseline="middle">no recorded data</text>
      {/if}
      {#each valueTicks(domain) as tick (tick)}
        <line class="grid" x1={pad.left} x2={pad.left + plotWidth} y1={y(tick)} y2={y(tick)} />
        <text class="axis" x={pad.left - 6} y={y(tick)} text-anchor="end" dominant-baseline="middle">{formatValue(tick)}</text>
      {/each}
      <text class="axis unit" x={pad.left - 6} y={pad.top - 9} text-anchor="end">{unitLabel(panel.unit)}</text>
      {#each timeTicks(now, panel.horizonMs) as tick (tick.t)}
        <text class="axis" x={x(tick.t)} y={height - 6} text-anchor="middle">{tick.label}</text>
      {/each}

      {#each drawnThresholds as threshold (threshold.ruleId)}
        <line
          class={`threshold ${threshold.kind}`}
          class:qualified={threshold.modeLabel !== undefined}
          x1={pad.left}
          x2={pad.left + plotWidth}
          y1={y(threshold.value)}
          y2={y(threshold.value)}
        ><title>{threshold.label}</title></line>
      {/each}
      {#each thresholdLabels as label (label.key)}
        <text class={`threshold-label ${label.active ? `active-${label.kind}` : ''}`} x={pad.left + plotWidth + 4} y={label.y} dominant-baseline="middle"><title>{label.title}</title>{label.text}</text>
      {/each}
      {#each controlThresholds.filter(threshold => threshold.value >= domain!.min && threshold.value <= domain!.max) as threshold (threshold.ruleId)}
        <line class="control-mark" x1={pad.left + plotWidth} x2={pad.left + plotWidth + 3} y1={y(threshold.value)} y2={y(threshold.value)}><title>{threshold.label} at {threshold.value} {unitLabel(panel.unit)} (control set point)</title></line>
      {/each}

      {#if issuedAt >= windowStart}
        <line class="advice" x1={x(issuedAt)} x2={x(issuedAt)} y1={pad.top} y2={pad.top + plotHeight} />
        <text class="advice-label" x={x(issuedAt) - 3} y={pad.top + 9} text-anchor="end">advice ▸</text>
      {:else}
        <text class="advice-label" x={pad.left + 3} y={pad.top + 9}>◂ advice given before this window</text>
      {/if}
      <line class="now" x1={pad.left + plotWidth} x2={pad.left + plotWidth} y1={pad.top} y2={pad.top + plotHeight} />

      {#each panel.pens as pen, index (pen.path)}
        <path
          class="pen"
          d={stepPath(series.get(String(pen.path)) ?? [], x, y, { start: windowStart, end: now })}
          style={penStroke(pen.role, index)}
        />
      {/each}
    </svg>
  {/if}
</div>

<style>
  .trend { width: 100%; }
  svg { display: block; overflow: visible; }
  .trend-empty { margin: 0; padding: 24px 0; color: var(--element-neutral-color); font-size: 13px; }
  .grid { stroke: var(--border-divider-color); stroke-width: 1; }
  .axis { fill: var(--element-neutral-color); font-size: 11px; font-variant-numeric: tabular-nums; }
  .unit { font-weight: 600; }
  .threshold { stroke-width: 1; }
  .threshold.trip { stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .threshold.alarm { stroke: var(--element-neutral-color); stroke-opacity: 0.7; }
  .threshold.qualified { stroke-dasharray: 5 3; }
  .threshold-label { fill: var(--element-neutral-color); font-size: 10.5px; font-variant-numeric: tabular-nums; }
  /* Colour appears only while the rule behind the line is actually active. */
  .threshold-label.active-trip { fill: var(--alert-alarm-color); font-weight: 700; }
  .threshold-label.active-alarm { fill: var(--alert-warning-color); font-weight: 700; }
  .hatch { stroke: var(--border-divider-color); stroke-width: 1; }
  .gap-label { fill: var(--element-neutral-color); font-size: 11px; }
  .control-mark { stroke: var(--element-neutral-color); stroke-width: 2; }
  .advice { stroke: var(--element-neutral-color); stroke-dasharray: 2 3; }
  .advice-label { fill: var(--element-neutral-color); font-size: 10.5px; }
  .now { stroke: var(--border-outline-color); }
  .pen { fill: none; stroke-linejoin: round; }
</style>
