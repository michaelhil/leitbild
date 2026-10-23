<script lang="ts">
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import type { VignetteSection, VignetteView } from '../../../features/displays/compose/model.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame } from '../view-host.ts'
  import { slotLook } from './collection.ts'
  import type { OpenedFrom } from './popover.ts'
  import { underTitle } from './format.ts'
  import { frameLayout, standsBeside, VIGNETTE_ROW_PX } from './grid.ts'
  import { drawingScale } from './network.ts'
  import { vignetteOpening } from './opening.svelte.ts'
  import { valueLook, type ReadingLook } from './readout.ts'
  import type { VignetteSnapshot } from './vignette-client.ts'
  import AlertsSection from './AlertsSection.svelte'
  import CriterionRow from './CriterionRow.svelte'
  import ElementBlocks from './ElementBlocks.svelte'
  import EntityTable from './EntityTable.svelte'
  import FlowTopology from './FlowTopology.svelte'
  import GroupedValues from './GroupedValues.svelte'
  import MapFocus from './MapFocus.svelte'
  import NetworkTopology from './NetworkTopology.svelte'
  import Readout from './Readout.svelte'
  import StateWord from './StateWord.svelte'
  import TrendStrip from './TrendStrip.svelte'

  // A vignette's sections, each within the rows the composer allotted: in its
  // frame (Vignette.svelte), stacked, or in a window frame (`beside`, Q20) its
  // flow drawing beside a column of the others where both fit its width, else
  // (grid.ts frameLayout) the column first, as a band over the drawing: its
  // values in columns, then its alerts' head and first rows, the drawing at
  // its size, scaled to the width or scrolled sideways under an edge fade
  // that says it continues. Frozen, values, trends and alerts read in
  // OpenBridge's low-integrity style: they no longer follow the Run.
  let { view, snapshot, palette, frozen, runId, from, fills }: {
    view: VignetteView
    snapshot: VignetteSnapshot
    palette: Palette
    frozen: boolean
    runId: SimulationRunId
    /** The display these sections stand in, as an element's detail opened from it names it. */
    from: OpenedFrom
    /** Alerts only in a display window (grid.ts fillsWindow): its list fills the frame, its composed rows the least it has. */
    fills: boolean
  } = $props()

  const latest = $derived(snapshot.latest)
  const observations = $derived(latest?.observations ?? [])
  const now = $derived(latest === undefined ? Number.NaN : Date.parse(latest.at.at))
  /** The flow drawing a window frame stands beside its column; -1 without one. */
  const drawing = $derived(view.sections.findIndex(section => section.kind === 'topology' && section.family === 'flow'))
  /** A frozen display's readings are doubtful: they are the last it had. */
  const shown = (look: ReadingLook): ReadingLook => (frozen ? { ...look, doubtful: true } : look)

  // The one width the layout follows: the frame's, at the window's zoom.
  let width = $state(0)
  let zoom = $state(1)
  runOnMount(() => embeddedDisplayFrame().subscribe(presentation => { zoom = presentation.zoom }))
  const layout = $derived.by(() => {
    if (!standsBeside(view)) return null
    const flow = view.sections[drawing] as Extract<VignetteSection, { kind: 'topology' }>
    return frameLayout({ width, drawingWidth: flow.layout.width * VIGNETTE_ROW_PX * drawingScale(flow), zoom })
  })
  /** The band's alerts: their head, three rows and the count of the rest. */
  const BAND_ALERT_ROWS = 5

  // In a chat a drawing is scaled to the frame's width as well as its rows (W7.3), never below 0.6 of its size: below
  // that "View drawing ›" opens it in the window, where there is one; where there is none it stays at 0.6 and scrolls.
  const opening = vignetteOpening()
  const CHAT_DRAWING_FLOOR = 0.6
  const inChat = $derived(opening !== undefined && opening.where !== 'window')
  /** A topology's further scale to the frame's width in a chat: 1 elsewhere, and where it fits. */
  const chatFit = (section: Extract<VignetteSection, { kind: 'topology' }>): number => {
    const natural = (section.layout.width + 1) * VIGNETTE_ROW_PX * drawingScale(section)
    return !inChat || width <= 0 ? 1 : Math.min(1, width / natural)
  }

  /** Which ends of a scrolled drawing are out of sight, judged on every scroll and every change of its or its drawing's size. */
  let more = $state({ left: false, right: false })
  const sensed = (scroller: HTMLElement) => {
    const sense = (): void => { more = { left: scroller.scrollLeft > 1, right: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1 } }
    const resized = new ResizeObserver(sense)
    resized.observe(scroller)
    if (scroller.firstElementChild !== null) resized.observe(scroller.firstElementChild)
    scroller.addEventListener('scroll', sense, { passive: true })
    sense()
    return { destroy: () => { resized.disconnect(); scroller.removeEventListener('scroll', sense) } }
  }
</script>

{#snippet one(section: VignetteSection, index: number, rows: number | null = section.rows, fit: number = 1)}
    <div class="section" class:frozen={frozen && (section.kind === 'alerts' || section.kind === 'entity')} style:height={rows === null || fills ? undefined : `${rows * VIGNETTE_ROW_PX}px`} style:min-height={rows !== null && fills ? `${rows * VIGNETTE_ROW_PX}px` : undefined}>
      {#if section.kind === 'values' && section.blocks !== undefined}
        <div class="values"><ElementBlocks blocks={section.blocks} {view} {observations} {frozen} /></div>
      {:else if section.kind === 'values'}
        <div class="values">
          {#each section.values as value (value.ref)}
            {@const look = shown(valueLook(value, observations, value.ref))}
            {#if look.kind === 'criterion'}<CriterionRow {look} label={underTitle(value.label, view.title, view.subject)} />{:else if look.kind === 'state'}<StateWord {look} label={underTitle(value.label, view.title, view.subject)} />{:else}<Readout {look} label={underTitle(value.label, view.title, view.subject)} />{/if}
          {/each}
        </div>
        {#if section.table !== undefined}<GroupedValues section={section.table} {observations} {frozen} />{/if}
      {:else if section.kind === 'grouped'}
        <GroupedValues {section} {observations} {frozen} />
      {:else if section.kind === 'trend'}
        {#each section.strips as pens, strip (strip)}
          <TrendStrip {pens} title={view.subject?.object ?? view.title} series={snapshot.series} {observations} {now} horizonMs={section.horizonMs} rows={Math.max(3, pens.length)} axis={strip === section.strips.length - 1} {frozen} />
        {/each}
      {:else if section.kind === 'alerts'}
        <AlertsSection rows={latest?.alerts ?? []} {section} room={rows ?? section.rows} />
      {:else if section.kind === 'entity'}
        <EntityTable {section} rows={latest?.entities[index]?.rows ?? []} more={latest?.entities[index]?.more ?? 0} />
      {:else if section.kind === 'slots'}
        <div class="values">
          {#each section.slots as slot (slot.key)}
            <!-- Core slots and telemetry carry no observation priority: they read neutral. -->
            {@const look = shown(slotLook(slot, latest?.slots[section.objectId]?.[slot.key]))}
            {#if look.kind === 'state'}<StateWord {look} label={underTitle(slot.label, view.title, view.subject)} />{:else}<Readout {look} label={underTitle(slot.label, view.title, view.subject)} />{/if}
          {/each}
        </div>
      {:else if section.kind === 'map'}
        <MapFocus frame={latest?.maps[index]} />
      {:else if section.family === 'flow'}
        <FlowTopology {section} {observations} alerts={latest?.alerts ?? []} {palette} {frozen} {runId} {from} {fit} />
      {:else}
        <NetworkTopology {section} {observations} {palette} {frozen} {fit} />
      {/if}
    </div>
{/snippet}

<div class="sections" class:fill={fills} bind:clientWidth={width}>
  {#if layout?.kind === 'band'}
    <!-- The column first, as a band: its values in columns beside its alerts' head and first rows, then the drawing. -->
    <div class="band">
      {#each view.sections as section, index (index)}
        {#if section.kind === 'values'}<div class="band-values">{@render one(section, index, null)}</div>{/if}
      {/each}
      {#each view.sections as section, index (index)}
        {#if section.kind === 'alerts'}<div class="band-alerts">{@render one(section, index, Math.min(section.rows, BAND_ALERT_ROWS))}</div>{/if}
      {/each}
    </div>
    {#if layout.drawing === 'scrolled'}
      <div class="scroll-wrap" class:more-left={more.left} class:more-right={more.right}>
        <div class="scroll" use:sensed>{@render one(view.sections[drawing]!, drawing)}</div>
        {#if more.left}<span class="continues left" aria-hidden="true">‹ drawing continues</span>{/if}
        {#if more.right}<span class="continues right" aria-hidden="true">drawing continues ›</span>{/if}
      </div>
    {:else}
      {@render one(view.sections[drawing]!, drawing, layout.drawing === 'scaled' ? Math.ceil(view.sections[drawing]!.rows * layout.scale) : view.sections[drawing]!.rows, layout.drawing === 'scaled' ? layout.scale : 1)}
    {/if}
    {#each view.sections as section, index (index)}
      {#if index !== drawing && section.kind !== 'values' && section.kind !== 'alerts'}{@render one(section, index)}{/if}
    {/each}
  {:else if layout?.kind === 'beside'}
    <!-- A window frame (Q20): the drawing at its own width, every other view in a column beside it. -->
    <div class="beside">
      <div class="drawing">{@render one(view.sections[drawing]!, drawing)}</div>
      <div class="column">
        {#each view.sections as section, index (index)}{#if index !== drawing}{@render one(section, index)}{/if}{/each}
      </div>
    </div>
  {:else}
    {#each view.sections as section, index (index)}
      {@const fit = section.kind === 'topology' ? chatFit(section) : 1}
      {#if section.kind === 'topology' && fit * drawingScale(section) < CHAT_DRAWING_FLOOR && opening?.where === 'relay'}
        <!-- Too small to read here: the window shows it whole. -->
        <div class="section view-drawing" style:height={`${2 * VIGNETTE_ROW_PX}px`}>
          <button type="button" onclick={() => opening.self()}>View drawing ›</button>
          <span>too wide to read in this chat</span>
        </div>
      {:else if section.kind === 'topology' && fit < 1}
        {@const scaled = Math.max(fit, CHAT_DRAWING_FLOOR / drawingScale(section))}
        <div class="scroll">{@render one(section, index, Math.ceil(section.rows * scaled), scaled)}</div>
      {:else}{@render one(section, index)}{/if}
    {/each}
  {/if}
</div>

<style>
  .section { overflow: hidden; }
  /* Alerts only: the sections take the frame's height left under the title (Vignette), the alerts their share of it. */
  .sections.fill { display: flex; flex-direction: column; }
  .sections.fill > .section { flex: 1 1 auto; }
  /* A block of values reads label beside value: never stretched across a wide frame (U-06). */
  .values { max-width: 480px; }
  /* Alerts and tables of a frozen display: OpenBridge's low-integrity colours around what they last showed, a little outside it so no word moves. */
  .section.frozen { background: var(--alert-low-integrity-background-color); box-shadow: 0 0 0 4px var(--alert-low-integrity-background-color), 0 0 0 5px var(--alert-low-integrity-border-color); }
  .beside { display: flex; gap: 16px; align-items: flex-start; }
  .drawing { flex: none; }
  .column { flex: 0 0 360px; min-width: 0; }
  /* The band: values in columns of 300 px or more, read down each, the alerts beside them where the width holds both, else under them. */
  .band { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0 24px; margin-bottom: 8px; }
  .band-values { flex: 2 1 600px; min-width: 0; }
  .band-values > .section > .values { max-width: none; column-width: 300px; column-gap: 24px; }
  .band-values > .section > .values > :global(*) { break-inside: avoid; }
  .band-alerts { flex: 1 1 320px; min-width: 0; max-width: 720px; }
  /* The drawing scrolls sideways in the frame's width, an edge fading where it continues; the window body scrolls down. */
  .scroll-wrap { position: relative; }
  .scroll { overflow-x: auto; overflow-y: hidden; }
  /* Its own section only, never a section nested inside the drawing. */
  .scroll > .section { width: max-content; }
  .scroll-wrap.more-left::before, .scroll-wrap.more-right::after { content: ''; position: absolute; top: 0; bottom: 0; width: 32px; pointer-events: none; }
  .scroll-wrap.more-left::before { left: 0; background: linear-gradient(to left, transparent, var(--container-background-color)); }
  .scroll-wrap.more-right::after { right: 0; background: linear-gradient(to right, transparent, var(--container-background-color)); }
  .continues { position: absolute; z-index: 1; top: 4px; padding: 0 8px; border: 1px solid var(--border-outline-color); border-radius: 12px; background: var(--container-background-color); color: var(--element-active-color); font-size: 12px; line-height: 20px; white-space: nowrap; pointer-events: none; }
  .continues.left { left: 4px; }
  .continues.right { right: 4px; }
  /* A chat's drawing too small to read: a link to the window in its place, on the drawing's first row. */
  .view-drawing { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--element-neutral-color); }
  .view-drawing button { height: 32px; padding: 0 12px; border: 1px solid var(--border-outline-color); border-radius: 4px; background: var(--container-background-color); color: var(--element-active-color); font: inherit; font-weight: 600; cursor: pointer; }
</style>
