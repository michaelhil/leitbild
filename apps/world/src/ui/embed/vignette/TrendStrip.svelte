<script lang="ts">
  import { decimalsFor, type Observation } from '../../../core/observation/model.ts'
  import type { VignetteSection, VignetteValue } from '../../../features/displays/compose/model.ts'
  import { isState, PLOT_ROWS } from '../../../features/displays/compose/strips.ts'
  import { wordsThatFit } from './alerts.ts'
  import { underTitle } from './format.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { valueLook } from './readout.ts'
  import { rowMeasure } from './row-measure.ts'
  import { bandStretches, LABEL_GAP, LABEL_INDENT, LABEL_LINE, labelWidth, rateNow, rateText, stripDrawing, timeTicks, type DrawnSeries } from './trend.ts'

  // A vignette's trend (W5): its strips one under another over one window
  // ending now, each one quantity on its own scale (strips.ts). A strip's plot
  // takes five rows; its limits' names stand beside it, outside the plot, in a
  // margin the strips share so a time stands at one place on each; its legend
  // is under it, a row for each pen: its dash, its name (whole: the label,
  // without its object, or its short label, the rate and then the chip's
  // words giving way first), its value now, the chip of the limit it is past
  // and its rate. States read as bands under the strips, filled while on. The
  // time axis is under the last. Frozen, plots and values read in
  // OpenBridge's low-integrity colours: they no longer follow the Run.
  let { section, title, series, observations, now, setPoints, frozen }: {
    section: Extract<VignetteSection, { kind: 'trend' }>
    /** The vignette's title: a pen's name drops the object or element it names. */
    title: string
    series: ReadonlyMap<string, DrawnSeries>
    observations: ReadonlyArray<Observation>
    now: number
    /** An element's own trend marks its control set points ("CTL"). */
    setPoints: boolean
    frozen: boolean
  } = $props()

  const id = $props.id()
  const hatch = `unrecorded-${id}`
  const PLOT_HEIGHT = PLOT_ROWS * VIGNETTE_ROW_PX
  let width = $state(0)

  // Names are measured as an alert row's detail is: 12 px in the page's font.
  const rows = rowMeasure()
  const measure = (text: string): number => rows(text, 'detail')

  const states = (pens: ReadonlyArray<VignetteValue>): boolean => pens.every(isState)
  const inputs = $derived(section.strips.map(pens => ({ pens, series, observations, now, horizonMs: section.horizonMs, height: PLOT_HEIGHT, setPoints })))
  const ready = $derived(width > 0 && Number.isFinite(now))
  // The margin the strips share: as wide as the widest name any writes, at most 45 % of the trend; none without names.
  const gutter = $derived.by(() => {
    if (!ready) return 0
    const widest = Math.max(0, ...inputs.map((input, index) => (states(section.strips[index]!) ? 0 : labelWidth(input, measure))))
    return widest === 0 ? 0 : Math.min(Math.round(width * 0.45), Math.ceil(widest) + LABEL_GAP + 4)
  })
  const plotWidth = $derived(Math.max(40, width - gutter))
  const drawings = $derived(ready ? inputs.map((input, index) => (states(section.strips[index]!) ? null : stripDrawing({ ...input, width: plotWidth, room: gutter, measure }))) : [])
  const start = $derived(now - section.horizonMs)
  const x = (t: number): number => ((t - start) / section.horizonMs) * plotWidth

  // A narrow plot names every second or third time, always "now", so no two names touch.
  const AXIS_LABEL_PX = 72
  const times = $derived.by(() => {
    const ticks = ready ? timeTicks(now, section.horizonMs) : []
    const every = Math.max(1, Math.ceil(AXIS_LABEL_PX / (plotWidth / Math.max(1, ticks.length - 1))))
    return ticks.filter((_, index) => (ticks.length - 1 - index) % every === 0)
  })

  /** The object every pen names first ("Halden Unit 1 · …"), which the names leave out alike; none where they differ. */
  const shared = $derived.by(() => {
    const objects = new Set(section.strips.flat().map(pen => (pen.label.includes(' · ') ? pen.label.slice(0, pen.label.indexOf(' · ')) : '')))
    return objects.size === 1 && !objects.has('') ? [...objects][0]! : null
  })
  /**
   * A pen's names, longest first: as the vignette's title leaves it (without the object all pens name), without the
   * element it closes on ("· PZR → Relief header"), and its short label.
   */
  const namesOf = (pen: VignetteValue): ReadonlyArray<string> => {
    const under = underTitle(pen.label, title)
    const name = shared !== null && under.startsWith(`${shared} · `) ? under.slice(shared.length + 3) : under
    return [...new Set([name, name.includes(' · ') ? name.slice(0, name.lastIndexOf(' · ')) : name, ...(pen.shortLabel === undefined ? [] : [pen.shortLabel])])]
  }
  const rateOf = (pen: VignetteValue): string => {
    const recorded = series.get(pen.ref)
    const value = observations.find(observation => observation.ref === pen.ref)?.value
    if (recorded === undefined || typeof value !== 'number') return ''
    const rate = rateNow(recorded, now, 10 ** -decimalsFor(pen.unit, value, pen.quantity))
    return rate === null ? '' : rateText(rate, pen.unit, pen.quantity)
  }

  interface Fitted { readonly names: ReadonlyArray<string>; readonly chip: { readonly word: string; readonly text: string } | null; readonly rate: string }
  /**
   * A legend row keeps its name whole: the longest name that fits beside the value, the chip and the rate; else the
   * shortest with the rate given way, then with the chip's order word alone; only where none fits, its first whole
   * words. Fitted again whenever its room or its words change.
   */
  const legendFit = (node: HTMLElement, fitted: Fitted) => {
    let current = fitted
    const fit = (): void => {
      const name = node.querySelector<HTMLElement>('.name')!
      const chip = node.querySelector<HTMLElement>('.chip')
      const rate = node.querySelector<HTMLElement>('.rate')
      const shortest = current.names.at(-1)!
      const tries = [
        ...current.names.map(text => ({ text, rate: true, word: false })),
        { text: shortest, rate: false, word: false },
        { text: shortest, rate: false, word: true },
      ]
      for (const attempt of tries) {
        name.textContent = attempt.text
        if (chip !== null && current.chip !== null) chip.textContent = attempt.word ? current.chip.word : current.chip.text
        if (rate !== null) rate.textContent = attempt.rate ? current.rate : ''
        if (name.scrollWidth <= name.clientWidth) return
      }
      name.textContent = wordsThatFit(shortest, shown => { name.textContent = shown; return name.scrollWidth <= name.clientWidth })
    }
    fit()
    const resized = new ResizeObserver(fit)
    resized.observe(node)
    return { update: (next: Fitted) => { current = next; fit() }, destroy: () => resized.disconnect() }
  }
</script>

{#snippet axis()}
  <div class="axis" style:width={`${plotWidth}px`}>{#each times as tick (tick.label)}<span style:left={`${x(tick.t)}px`} style:transform={x(tick.t) < AXIS_LABEL_PX / 2 ? 'none' : x(tick.t) > plotWidth - AXIS_LABEL_PX / 2 ? 'translateX(-100%)' : 'translateX(-50%)'}>{tick.label}</span>{/each}</div>
{/snippet}

<div class="trend" class:frozen bind:clientWidth={width}>
  {#each section.strips as pens, index (index)}
    {@const last = index === section.strips.length - 1}
    {#if states(pens)}
      {#each pens as pen (pen.ref)}
        {@const look = valueLook(pen, observations, pen.ref)}
        {@const recorded = series.get(pen.ref)}
        <div class="band" title={look.title}>
          <span class="band-line" use:legendFit={{ names: namesOf(pen), chip: null, rate: '' }}><span class="name"></span><span class={`now ${look.tone ?? ''}`}>{look.text}</span></span>
          <!-- On: the full band; off: a thin line; nothing where the record holds no value. -->
          <svg class="band-track" width={plotWidth} height="6" role="img" aria-label={`${pen.label}: ${look.text}`}>
            {#if recorded !== undefined && ready}
              {#each bandStretches(recorded.points, x, { start, end: now }, recorded.holdMs, recorded.silentFrom) as stretch, at (at)}<rect class:on={stretch.on} class="stretch" x={stretch.x} y={stretch.on ? 0 : 2} width={stretch.width} height={stretch.on ? 6 : 2} />{/each}
            {/if}
          </svg>
        </div>
      {/each}
      {#if last}{@render axis()}{/if}
    {:else}
      {@const drawing = drawings[index] ?? null}
      <div class="plot" style:height={`${PLOT_HEIGHT}px`}>
        {#if drawing === null}
          <p class="empty" style:width={`${plotWidth}px`}>No recorded values in this window yet</p>
        {:else}
          <svg width={width} height={PLOT_HEIGHT} role="img" aria-label={pens.map(pen => `${pen.label}: ${valueLook(pen, observations, pen.ref).text}`).join(', ')}>
            <rect class="frame" x="0.5" y="0.5" width={plotWidth - 1} height={PLOT_HEIGHT - 1} rx="3" />
            {#if drawing.unrecorded !== null}
              <!-- Before the record starts nothing is known: a quiet hatch, never drawn as if a value held. -->
              <defs><pattern id={hatch} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="8" /></pattern></defs>
              <rect class="unrecorded" x="1" y="1" width={Math.max(0, drawing.unrecorded.width - 1)} height={PLOT_HEIGHT - 2} fill={`url(#${hatch})`}><title>No record yet</title></rect>
            {/if}
            {#each drawing.values as tick (tick.label)}<line class="grid" x1="1" x2={plotWidth - 1} y1={tick.y} y2={tick.y} />{/each}
            {#each drawing.setPoints as mark (mark.key)}
              <line class="set-point" x1={plotWidth - 9} x2={plotWidth - 1} y1={mark.y} y2={mark.y}><title>{mark.title}</title></line>
              {#if mark.labelY !== null}<text class="name set-point-name" x={plotWidth + LABEL_GAP} y={mark.labelY} dominant-baseline="central"><title>{mark.title}</title>{mark.label}</text>{/if}
            {/each}
            {#each drawing.lines as line (line.key)}<line class={`limit ${line.tone ?? ''}`} class:idle={line.idle} x1="1" x2={plotWidth - 1} y1={line.y} y2={line.y}><title>{line.title}</title></line>{/each}
            {#each drawing.values as tick (tick.label)}<text class="tick" x="4" y={tick.labelY}>{tick.label}</text>{/each}
            {#each drawing.pens as pen (pen.ref)}<path class={`pen ${pen.tone ?? ''}`} d={pen.path} stroke-dasharray={pen.dash === '' ? undefined : pen.dash} />{/each}
            <!-- Names beside the plot, each at its line or led to it. -->
            {#each drawing.labels as label (label.key)}
              {#if label.lineY !== null && Math.abs(label.y - label.lineY) > 2}<polyline class="leader" points={`${plotWidth},${label.lineY} ${plotWidth + 3},${label.lineY} ${plotWidth + LABEL_GAP - 2},${label.y}`} />{/if}
              {#each label.rows as row, at (at)}
                <text class="name" x={plotWidth + LABEL_GAP + (at === 0 ? 0 : LABEL_INDENT)} y={label.y + at * LABEL_LINE} dominant-baseline="central"><title>{label.title}</title>{#each row as run, part (part)}<tspan class={run.tone ?? ''} class:idle={run.idle} class:mark={run.mark === true}>{run.text}</tspan>{/each}</text>
              {/each}
            {/each}
          </svg>
        {/if}
      </div>
      {#if last}{@render axis()}{/if}
      <ul class="legend">
        {#each pens as pen, at (pen.ref)}
          {@const look = valueLook(pen, observations, pen.ref)}
          <li title={look.title} use:legendFit={{ names: namesOf(pen), chip: look.chip, rate: rateOf(pen) }}>
            <svg class="swatch" width="24" height="10" aria-hidden="true"><line class={`pen ${drawing?.pens[at]?.tone ?? ''}`} x1="1" x2="23" y1="5" y2="5" stroke-dasharray={drawing?.pens[at]?.dash || undefined} /></svg>
            <span class="name"></span>
            <span class={`now ${look.tone ?? ''}`}>{look.text}{look.unit === '' ? '' : ` ${look.unit}`}</span>
            {#if look.chip !== null}<span class={`chip ${look.chip.tone ?? 'neutral'}`}></span>{/if}
            <span class="rate"></span>
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
</div>

<style>
  .trend { min-width: 0; }
  .plot { position: relative; min-width: 0; }
  svg { display: block; overflow: visible; }
  .empty { margin: 0; padding: 4px 6px; height: 100%; box-sizing: border-box; border: 1px solid var(--border-divider-color); border-radius: 3px; color: var(--element-neutral-color); }
  .frame { fill: var(--container-section-color); stroke: var(--border-divider-color); stroke-width: 1; }
  .grid { stroke: var(--border-divider-color); stroke-width: 1; }
  /* Quiet: thin and sparse, so the record reads first. */
  .hatch { stroke: var(--border-divider-color); stroke-width: 1; stroke-opacity: 0.9; }
  /* A halo in the plot's own background keeps a value legible where traces run through it. */
  .tick { fill: var(--element-neutral-color); font-size: 12px; font-variant-numeric: tabular-nums; paint-order: stroke; stroke: var(--container-section-color); stroke-width: 3px; stroke-linejoin: round; }
  /* A limit is a neutral dash; in its alarm's colour only while a value is past it where it acts now; faint where it does not act now. */
  .limit { stroke: var(--element-neutral-color); stroke-width: 1; stroke-dasharray: 5 3; stroke-opacity: 0.8; }
  .limit.idle { stroke-dasharray: 2 4; stroke-opacity: 0.4; }
  .limit.caution { stroke: var(--alert-caution-color); stroke-opacity: 1; stroke-width: 1.5; }
  .limit.warning { stroke: var(--alert-warning-color); stroke-opacity: 1; stroke-width: 1.5; }
  .limit.alarm { stroke: var(--alert-alarm-color); stroke-opacity: 1; stroke-width: 1.5; }
  .limit.critical { stroke: var(--alert-critical-color); stroke-opacity: 1; stroke-width: 1.5; }
  .set-point { stroke: var(--element-neutral-color); stroke-width: 2; stroke-opacity: 0.4; }
  text.set-point-name { fill-opacity: 0.55; }
  .leader { fill: none; stroke: var(--element-neutral-color); stroke-width: 1; stroke-opacity: 0.6; }
  .name { font-size: 12px; font-variant-numeric: tabular-nums; white-space: pre; }
  text.name { fill: var(--element-neutral-color); }
  text.name .idle { fill-opacity: 0.55; }
  /* Past a limit that acts: its name in bold, readable, led by a mark in its alarm's colour. */
  text.name .caution, text.name .warning, text.name .alarm, text.name .critical { font-weight: 700; fill: var(--display-alert-text); }
  text.name .mark.caution { fill: var(--alert-caution-color); }
  text.name .mark.warning { fill: var(--alert-warning-color); }
  text.name .mark.alarm { fill: var(--alert-alarm-color); }
  text.name .mark.critical { fill: var(--alert-critical-color); }
  .pen { fill: none; stroke: var(--element-active-color); stroke-width: 1.5; stroke-linejoin: round; }
  .pen.caution { stroke: var(--alert-caution-color); stroke-width: 2; }
  .pen.warning { stroke: var(--alert-warning-color); stroke-width: 2; }
  .pen.alarm { stroke: var(--alert-alarm-color); stroke-width: 2; }
  .pen.critical { stroke: var(--alert-critical-color); stroke-width: 2; }
  /* A legend row reads as one: never wider than a block of values (U-06), its value beside its name. */
  .legend { list-style: none; margin: 0; padding: 0; max-width: 480px; }
  .legend li { display: flex; align-items: center; gap: 6px; height: var(--row); min-width: 0; white-space: nowrap; }
  .swatch { flex: none; }
  .swatch .pen { stroke-width: 2; }
  .legend .name, .band .name { flex: 1 1 0; min-width: 0; overflow: hidden; font-size: 12px; color: var(--element-neutral-color); }
  .now { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
  .now.caution, .now.warning, .now.alarm, .now.critical { font-weight: 700; color: var(--display-alert-text); }
  .rate { flex: none; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .rate:empty { display: none; }
  .chip { flex: none; padding: 0 4px; border: 1px solid; border-radius: 3px; font-weight: 700; letter-spacing: 0.03em; }
  .chip.neutral { color: var(--element-active-color); border-color: var(--border-outline-color); }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); }
  /* A state's band: its name and its word now over a 6 px band, filled while on. */
  .band { display: flex; flex-direction: column; justify-content: center; gap: 2px; height: var(--row); min-width: 0; }
  .band-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; max-width: 480px; line-height: 15px; white-space: nowrap; }
  .stretch { fill: var(--element-neutral-color); fill-opacity: 0.5; }
  .stretch.on { fill: var(--element-active-color); fill-opacity: 1; }
  .axis { position: relative; height: var(--row); color: var(--element-neutral-color); font-size: 12px; }
  .axis span { position: absolute; top: 4px; white-space: nowrap; }
  .frozen .frame { stroke: var(--alert-low-integrity-border-color); fill: var(--alert-low-integrity-background-color); }
  .frozen .tick { stroke: var(--alert-low-integrity-background-color); }
  .frozen .now { padding: 0 3px; border-radius: 3px; outline: 1px solid var(--alert-low-integrity-border-color); background: var(--alert-low-integrity-background-color); }
</style>
