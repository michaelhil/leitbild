<script lang="ts">
  import type { ComposedTrendStrip, ComposedTrendThreshold } from '../../../packs/process-plant/displays/compose.ts'
  import { displayValue, formatQuantity, simulationClock, thresholdName, unitLabel } from '../../../packs/process-plant/displays/display-text.ts'
  import {
    paddedDomain,
    rawDomain,
    stepPath,
    tickLabels,
    timeTicks,
    valueTicks,
    type TrendPoint,
    type ValueDomain,
  } from './trend-geometry.ts'
  import { penStroke } from './pen-style.ts'

  // One strip of a trend: one measurement of parallel equipment on its own
  // value axis. Strips of a trend share the time window; only the bottom one
  // labels the time axis and only the top one names the advice marker.
  let {
    strip,
    horizon,
    windowMs,
    series,
    range,
    now,
    issuedAt,
    runStartedAt,
    height,
    timeAxis,
    adviceLabel,
    activeRuleIds,
  }: {
    strip: ComposedTrendStrip
    horizon: string
    /** The time the strip spans: the horizon, or the Run's history when that is shorter. */
    windowMs: number
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    range: ValueDomain | null
    now: number
    issuedAt: number
    /** Simulation time the Run started, when known; history cannot reach before it. */
    runStartedAt: number | null
    height: number
    timeAxis: boolean
    adviceLabel: boolean
    /** I&C rules active now; their threshold labels take the alarm colour. */
    activeRuleIds: ReadonlySet<string>
  } = $props()

  let width = $state(520)
  // Several strips share the page; each hatch pattern needs its own id.
  const uid = $props.id()
  const patternId = `no-data-${uid}`
  // The right gutter fits the longest threshold label, such as "LO TRIP 16.35 (+2)".
  const pad = $derived({ left: 44, right: 118, top: 18, bottom: timeAxis ? 22 : 0 })

  // Trip and alarm thresholds always fit the scale; control set points are
  // marked on the axis only when they fall inside it, to keep the trend quiet.
  const drawnThresholds = $derived(strip.thresholds.filter(threshold => threshold.kind !== 'control'))
  const controlThresholds = $derived(strip.thresholds.filter(threshold => threshold.kind === 'control'))

  // Fixed scale: the grow-only range seen since the view opened plus the drawn
  // thresholds. Control set points never widen it.
  const domain = $derived.by((): ValueDomain | null => {
    const raw = rawDomain([
      ...(range === null ? [] : [range.min, range.max]),
      ...drawnThresholds.map(threshold => threshold.value),
    ])
    return raw === null ? null : paddedDomain(raw)
  })

  const windowStart = $derived(now - windowMs)
  const plotWidth = $derived(Math.max(40, width - pad.left - pad.right))
  const plotHeight = $derived(Math.max(24, height - pad.top - pad.bottom))
  const x = (t: number): number => pad.left + ((t - windowStart) / windowMs) * plotWidth
  const y = (v: number): number => domain === null ? pad.top : pad.top + (1 - (v - domain.min) / (domain.max - domain.min)) * plotHeight
  // A plot shrunk to fit the display keeps its tick labels apart with fewer gridlines.
  const ticks = $derived(domain === null ? [] : valueTicks(domain, plotHeight < 60 ? 2 : 3))
  const labels = $derived(tickLabels(ticks.map(tick => displayValue(tick, strip.unit))))

  // The alarm colour follows the rule's severity, as in the alarm list and chips.
  const activeSeverity = (threshold: ComposedTrendThreshold): string | null =>
    threshold.ruleIds.some(ruleId => activeRuleIds.has(ruleId)) ? threshold.severity ?? 'warning' : null

  // The value labels are read against: the latest value of the strip's first pen.
  const current = $derived(strip.pens.map(pen => series.get(String(pen.path))?.at(-1)?.v).find(value => value !== undefined))

  // Lines of one direction closer than one label height share one label: the
  // active rule names the cluster, otherwise the line nearest the current
  // value, with a count of the others (all listed in its tooltip). Low and high
  // limits never merge, so the limit a value approaches stays named. A label
  // pushed off its line keeps a leader to it.
  const LABEL_SPACING = 12
  const thresholdLabels = $derived.by(() => {
    const sorted = [...drawnThresholds].sort((left, right) => right.value - left.value)
    const clusters: Array<Array<ComposedTrendThreshold>> = []
    for (const threshold of sorted) {
      const cluster = clusters.at(-1)
      const joins = cluster !== undefined
        && cluster[0]!.direction === threshold.direction
        && y(threshold.value) - y(cluster[0]!.value) < LABEL_SPACING
      if (joins) cluster.push(threshold)
      else clusters.push([threshold])
    }
    const placed: Array<{ key: string; lineY: number; y: number; text: string; title: string; severity: string | null }> = []
    for (const cluster of clusters) {
      const distance = (value: number): number => current === undefined ? 0 : Math.abs(value - current)
      const named = cluster.find(threshold => activeSeverity(threshold) === 'critical')
        ?? cluster.find(threshold => activeSeverity(threshold) !== null)
        ?? [...cluster].sort((left, right) => distance(left.value) - distance(right.value))[0]!
      const lineY = y(named.value)
      const previous = placed.at(-1)
      placed.push({
        key: named.ruleId,
        lineY,
        y: previous === undefined ? lineY : Math.max(lineY, previous.y + LABEL_SPACING),
        // Thresholds are configured numbers; show them exactly, never rounded.
        text: `${thresholdName(named, strip.unit, { withUnit: false })}${cluster.length > 1 ? ` (+${cluster.length - 1})` : ''}`,
        title: cluster.map(threshold => `${thresholdName(threshold, strip.unit)}: ${threshold.label} (${threshold.signals.join(', ')})${threshold.modeLabel === undefined ? '' : `, only in ${threshold.modeLabel}`}`).join('\n'),
        severity: activeSeverity(named),
      })
    }
    return placed
  })

  // Where the window starts before any recorded value, say why instead of
  // leaving an unexplained blank; a sliver too narrow for words stays unlabelled.
  const firstSampleAt = $derived(Math.min(...strip.pens.map(pen => series.get(String(pen.path))?.[0]?.t ?? Number.POSITIVE_INFINITY)))
  const gapEnd = $derived(Number.isFinite(firstSampleAt) ? Math.min(firstSampleAt, now) : now)
  const showGap = $derived(gapEnd - windowStart > windowMs * 0.05)
  const gapWide = $derived(x(gapEnd) - pad.left > 150)
  const RUN_START_TOLERANCE_MS = 5_000
  const gapText = $derived(runStartedAt !== null && runStartedAt > windowStart && Math.abs(gapEnd - runStartedAt) <= RUN_START_TOLERANCE_MS
    ? `before the Run started (sim ${simulationClock(runStartedAt)})`
    : 'no recorded data')

  // The advice marker's label is hidden when the advice was given just now:
  // the notice line already says so, and the label would sit on the data.
  const adviceVisible = $derived(issuedAt >= windowStart)
  const adviceRecent = $derived(now - issuedAt < windowMs * 0.04)
  const adviceNearLeft = $derived(x(issuedAt) - pad.left < 56)

  const summary = $derived(strip.pens.map(pen => {
    const latest = series.get(String(pen.path))?.at(-1)
    return `${pen.name}: ${latest === undefined ? 'no value' : formatQuantity(latest.v, pen.unit)}`
  }).join('; '))
</script>

<div class="trend" bind:clientWidth={width}>
  {#if domain === null}
    <p class="trend-empty" style={`height:${height}px`}>No values yet for {strip.pens.map(pen => pen.name).join(', ')}.</p>
  {:else}
    <svg {width} {height} role="img" aria-label={`Trend of the last ${horizon}. ${summary}`}>
      <defs>
        <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" class="hatch" />
        </pattern>
      </defs>
      {#if showGap}
        <rect x={pad.left} y={pad.top} width={Math.max(0, x(gapEnd) - pad.left)} height={plotHeight} fill={`url(#${patternId})`} />
        {#if gapWide}
          <text class="gap-label" x={pad.left + (x(gapEnd) - pad.left) / 2} y={pad.top + plotHeight / 2} text-anchor="middle" dominant-baseline="middle">{gapText}</text>
        {/if}
      {/if}
      {#each ticks as tick, index (tick)}
        <line class="grid" x1={pad.left} x2={pad.left + plotWidth} y1={y(tick)} y2={y(tick)} />
        <text class="axis" x={pad.left - 6} y={y(tick)} text-anchor="end" dominant-baseline="middle">{labels[index]}</text>
      {/each}
      <text class="axis unit" x={pad.left - 6} y={pad.top - 7} text-anchor="end">{unitLabel(strip.unit)}</text>
      {#if timeAxis}
        {#each timeTicks(now, windowMs) as tick (tick.t)}
          <text class="axis" x={x(tick.t)} y={height - 6} text-anchor="middle">{tick.label}</text>
        {/each}
      {/if}

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
        {#if Math.abs(label.y - label.lineY) > 2}
          <polyline class="leader" points={`${pad.left + plotWidth},${label.lineY} ${pad.left + plotWidth + 4},${label.lineY} ${pad.left + plotWidth + 8},${label.y}`} />
        {/if}
        <text class={`threshold-label ${label.severity === null ? '' : `active-${label.severity}`}`} x={pad.left + plotWidth + 10} y={label.y} dominant-baseline="middle"><title>{label.title}</title>{label.text}</text>
      {/each}
      {#each controlThresholds.filter(threshold => threshold.value >= domain!.min && threshold.value <= domain!.max) as threshold (threshold.ruleId)}
        <line class="control-mark" x1={pad.left + plotWidth} x2={pad.left + plotWidth + 3} y1={y(threshold.value)} y2={y(threshold.value)}><title>{threshold.label} at {formatQuantity(threshold.value, strip.unit)} (control set point)</title></line>
      {/each}

      {#if adviceVisible}
        <line class="advice" x1={x(issuedAt)} x2={x(issuedAt)} y1={pad.top} y2={pad.top + plotHeight} />
        {#if adviceLabel && !adviceRecent}
          <text class="advice-label" x={adviceNearLeft ? x(issuedAt) + 3 : x(issuedAt) - 3} y={pad.top - 7} text-anchor={adviceNearLeft ? 'start' : 'end'}>{adviceNearLeft ? '◂ advice' : 'advice ▸'}</text>
        {/if}
      {:else if adviceLabel}
        <text class="advice-label" x={pad.left + 3} y={pad.top - 7}>◂ advice given before this window</text>
      {/if}
      <line class="now" x1={pad.left + plotWidth} x2={pad.left + plotWidth} y1={pad.top} y2={pad.top + plotHeight} />

      {#each strip.pens as pen, index (pen.path)}
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
  .trend-empty { margin: 0; display: flex; align-items: center; color: var(--element-neutral-color); font-size: 13px; }
  .grid { stroke: var(--border-divider-color); stroke-width: 1; }
  .axis { fill: var(--element-neutral-color); font-size: 11px; font-variant-numeric: tabular-nums; }
  .unit { font-weight: 600; }
  .threshold { stroke-width: 1; }
  .threshold.trip { stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .threshold.alarm { stroke: var(--element-neutral-color); stroke-opacity: 0.7; }
  .threshold.qualified { stroke-dasharray: 5 3; }
  .leader { fill: none; stroke: var(--element-neutral-color); stroke-width: 1; stroke-opacity: 0.7; }
  .threshold-label { fill: var(--element-neutral-color); font-size: 10px; font-variant-numeric: tabular-nums; }
  /* Colour appears only while the rule behind the line is active, keyed by its severity. */
  .threshold-label.active-critical { fill: var(--alert-alarm-color); font-weight: 700; }
  .threshold-label.active-warning { fill: var(--alert-warning-color); font-weight: 700; }
  .threshold-label.active-notice, .threshold-label.active-info { fill: var(--alert-caution-color); font-weight: 700; }
  .hatch { stroke: var(--border-divider-color); stroke-width: 1; }
  .gap-label { fill: var(--element-neutral-color); font-size: 11px; }
  .control-mark { stroke: var(--element-neutral-color); stroke-width: 2; }
  .advice { stroke: var(--element-neutral-color); stroke-dasharray: 2 3; }
  .advice-label { fill: var(--element-neutral-color); font-size: 10.5px; }
  .now { stroke: var(--border-outline-color); }
  .pen { fill: none; stroke-linejoin: round; }
</style>
