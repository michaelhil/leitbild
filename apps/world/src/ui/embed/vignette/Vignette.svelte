<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { refObjectId } from '../../../core/model/alerts.ts'
  import { simulationRunIdSchema } from '../../../core/model/index.ts'
  import type { VignetteValue } from '../../../features/displays/compose/model.ts'
  import { severityStyle, severityTable, type Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, hostDisplayFrame } from '../view-host.ts'
  import { alertsTarget, worstChip } from './alerts.ts'
  import { clockText, provenanceMark, provenanceMarks } from './format.ts'
  import { firstFitting, wholeWords } from './fit-words.ts'
  import { fillsWindow, flowFrameWidth, VIGNETTE_INSET_PX, VIGNETTE_ROW_PX } from './grid.ts'
  import { toneOf } from './readout.ts'
  import { chipOrder, stateChipLook } from './state-chip.ts'
  import { createVignetteSession, sampleStale, vignetteRoutes, type VignetteSnapshot } from './vignette-client.ts'
  import { provideOpening } from './opening.svelte.ts'
  import AnswerNotice from './AnswerNotice.svelte'
  import Sections from './Sections.svelte'
  import StateChip from './StateChip.svelte'
  import TripLine from './TripLine.svelte'
  import './openbridge.ts'

  // A vignette's frame (architecture B): its title row (the title, the
  // "Assistant" mark where the Assistant composed it, the worst it shows,
  // and its object's own states as compact chips, state-chip.ts, which wrap
  // under the title where the row is short and are never cut); its sections,
  // each within the rows the composer allotted; and a footer saying whether
  // it is LIVE, PAUSED (the Run's clock stopped) or FROZEN (nothing updates:
  // the Run is gone or not loaded, or its samples fail), with the Run's
  // time, and what it is: generated from the model or AI-composed, never an
  // operating display (provenanceMark), in the window, inline in chat and in
  // a procedure tag's dialog alike. Frozen, its values, trends and alerts read
  // in the low-integrity style and assistive technology is told. On a
  // dashboard (`board`) the dashboard hosts the page and says when the
  // vignette can be seen; the dashboard's run frame keeps its alerts' counts
  // and tiles standing.
  let { envelope, board }: {
    envelope: EmbeddedViewEnvelope
    board?: { readonly visible: (listener: (visible: boolean) => void) => () => void; readonly frame: boolean }
  } = $props()

  let snapshot = $state.raw<VignetteSnapshot>({ phase: 'connecting', series: new Map(), sampleError: null })
  const readPalette = (): Palette => (document.documentElement.dataset.obcTheme as Palette | undefined) ?? 'day'
  let palette = $state<Palette>(readPalette())
  let wallNow = $state(Date.now())
  /** The height of the frame a person sees in a display window (its presentation's `visible`), which an alerts-only display fills. */
  let room = $state<number | null>(null)
  /** Why the last chip press opened nothing. */
  let unopened = $state<string | null>(null)

  const runId = $derived(simulationRunIdSchema.parse(envelope.subject.id))
  /** This display, as an element's pop-over names it when it opens the element's default in the display window. */
  const from = $derived({ key: envelope.state, title: envelope.title })
  // What its alerts, trip line and worst chip open (opening.svelte.ts).
  const { opening, stop: stopOpening } = provideOpening({ runId: () => runId, envelope: () => envelope, at: () => snapshot.latest?.at })
  runOnMount(() => {
    const session = createVignetteSession({
      runId,
      state: envelope.state,
      routes: vignetteRoutes,
      // An alerts-only display asks a window presenting it for the body's whole height, so its list fills it (W2.5).
      onChange: next => { snapshot = next; if (board === undefined && next.view !== undefined) embeddedDisplayFrame().reportFill('alerts', fillsWindow(next.view)) },
    })
    const unhost = board !== undefined ? board.visible(visible => session.setVisible(visible)) : hostDisplayFrame({
      kind: 'advice',
      card: document.querySelector<HTMLElement>('article.vignette'),
      drawing: () => (snapshot.phase === 'connecting' ? undefined : snapshot.view ?? snapshot),
      setVisible: visible => session.setVisible(visible),
      presented: () => {},
    })
    // The room it fills follows the window's body, never its own height: the window gives the frame no less (W2.5).
    const unroom = board !== undefined ? () => {} : embeddedDisplayFrame().subscribe(next => { room = next.visible?.height ?? null })
    session.start()
    // Staleness is judged on the wall clock, so it shows even while no sample arrives: a quarter-second tick freezes
    // the display within 5.25 s of its last sample (W8.1), not up to a second later.
    const tick = setInterval(() => { wallNow = Date.now() }, 250)
    // The embedding page's theme choice changes the palette live (main.ts).
    const theme = new MutationObserver(() => { palette = readPalette() })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-obc-theme'] })
    return () => { clearInterval(tick); theme.disconnect(); unroom(); unhost(); session.close(); stopOpening() }
  })

  const view = $derived(snapshot.view)
  const latest = $derived(snapshot.latest)
  const worst = $derived(latest === undefined ? null : worstChip(latest.observations, latest.alerts))
  /** The worst chip opens the full alerts view of what the vignette's alerts list (W2.6), where one can be opened from here. */
  const alertsOpen = $derived.by(() => {
    const target = view === undefined ? null : alertsTarget(view, latest?.alerts ?? [])
    return target === null || opening.where === null ? undefined : () => { opening.alerts(target.objectIds, target.title) }
  })
  const footer = $derived.by((): { readonly word: 'LIVE' | 'PAUSED' | 'FROZEN'; readonly why?: string } => {
    const stale = sampleStale(snapshot, wallNow)
    if (snapshot.phase === 'live' && !stale) return { word: latest?.at.paused === true ? 'PAUSED' : 'LIVE' }
    const why = snapshot.sampleError ?? (stale ? 'no answer from the Run for over 5 s' : snapshot.phase === 'inactive' ? 'the Run is not loaded' : snapshot.phase === 'missing' ? 'the Run no longer exists' : undefined)
    return why === undefined ? { word: 'FROZEN' } : { word: 'FROZEN', why }
  })
  const frozen = $derived(footer.word === 'FROZEN')
  const chips = $derived(chipOrder(view?.chips ?? []))
  /** Alerts only in a display window: as tall as the part of its frame a person sees; in chat or a dialog, its composed rows. */
  const fills = $derived(board === undefined && opening.where === 'window' && view !== undefined && fillsWindow(view))
  // Optional inline previews keep one native document scroller. A World
  // display window instead owns scrolling from the full article extent.
  const preview = $derived(board === undefined && opening.where !== 'window')
  const canvasWidth = $derived(opening.where === 'window' && view !== undefined ? flowFrameWidth(view) : null)

  /**
   * A chip inspects what decides its state through the drawing's existing faceplate;
   * where that component is not drawn, its default opens after this display.
   */
  const opener = (chip: VignetteValue): (() => void) | null => {
    const elementId = chip.decidingElement
    if (elementId === undefined || opening.where === null) return null
    const objectId = refObjectId(chip.ref)
    return () => {
      unopened = null
      void opening.element(objectId, elementId).then(why => { unopened = why })
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (A scrollable document region needs native keyboard focus.) -->
<div class:preview tabindex={preview ? 0 : undefined} role={preview ? 'region' : undefined} aria-label={preview ? 'Scrollable live display preview' : undefined}>
<article class="vignette" class:fill={fills} style:width={canvasWidth === null ? undefined : `${canvasWidth}px`} style:height={fills && room !== null ? `${room}px` : undefined} style:--inset={`${VIGNETTE_INSET_PX}px`} style:--row={`${VIGNETTE_ROW_PX}px`} aria-label={view?.title ?? envelope.title}>
  <header>
    <h1 title={view?.title ?? envelope.title} use:wholeWords={view?.title ?? envelope.title}></h1>
    {#if view?.by === 'assistant'}<span class="ai" title="Composed by the Assistant from what the Run declares"><obi-ai></obi-ai>Assistant</span>{/if}
    {#if worst !== null || chips.length > 0}
      <!-- The worst it shows (a press opens every alert, by category), then the object's own states (an operating mode first), right-aligned; they wrap, never cut. -->
      <div class="states" role="list" aria-label="States">
        {#if worst?.kind === 'priority' && alertsOpen !== undefined}
          <span role="listitem"><button type="button" class={['chip', toneOf(worst.priority), { doubtful: frozen }]} title="Open every alert, by category" onclick={alertsOpen}>{severityTable[worst.priority].word}</button></span>
        {:else if worst?.kind === 'priority'}
          <span role="listitem" class={['chip', toneOf(worst.priority), { doubtful: frozen }]}>{severityTable[worst.priority].word}</span>
        {:else if worst?.kind === 'undeclared'}
          <span role="listitem" class={['chip neutral', { doubtful: frozen }]}>{severityStyle(null, worst.severity)!.word}</span>
        {/if}
        {#each chips as chip (chip.ref)}
          <StateChip look={stateChipLook(chip, latest?.observations.find(observation => observation.ref === chip.ref), view?.title ?? envelope.title, frozen)} open={opener(chip)} />
        {/each}
      </div>
    {/if}
  </header>
  <!-- An answer's vignette: what makes it stale, when it was composed and why, in its reserved row (W8.2). -->
  {#if view?.answer !== undefined}<AnswerNotice answer={view.answer} at={latest?.at} />{/if}
  {#if unopened !== null}<p class="status" role="alert">Nothing opened: {unopened}</p>{/if}
  {#if view !== undefined}<TripLine {view} rows={latest?.alerts ?? []} reserve={view.tripLine === true} />{/if}

  {#if view === undefined}
    <p class="status">
      {#if snapshot.phase === 'missing'}This Run no longer exists.
      {:else if snapshot.phase === 'inactive'}The Run is not loaded; this display starts when it is.
      {:else if snapshot.phase === 'failed'}This display cannot be shown: {snapshot.failure}
      {:else}Connecting to the Run…{/if}
    </p>
  {:else}
    <Sections {view} {snapshot} {palette} {frozen} {runId} {from} {fills} frame={board?.frame === true} />
  {/if}

  <footer title={footer.why}>
    <span class={`clock ${footer.word.toLowerCase()}`}>{footer.word}</span>
    {#if latest !== undefined}<span>{latest.at.clock === 'simulation' ? 'sim' : 'wall'} {clockText(latest.at.at)}</span>{/if}
    {#if footer.why !== undefined}<span class="why" use:wholeWords={footer.why}></span>{/if}
    <span class="mark" title={provenanceMark(view)} aria-label={provenanceMark(view)} use:firstFitting={provenanceMarks(view)}>{provenanceMark(view)}</span>
  </footer>
  <!-- Said once when the display freezes and once when it is live again: what is drawn has stopped following the Run. -->
  <p class="announce" role="status">{frozen ? `Display frozen${footer.why === undefined ? '' : `: ${footer.why}`}. Values, trends and alerts are the last received${latest === undefined ? '' : `, at ${clockText(latest.at.at)}`}.` : ''}</p>
</article>
</div>

<style>
  .preview { max-height: 100vh; overflow-y: auto; overscroll-behavior-y: contain; }
  .vignette { --muted: var(--element-neutral-color); --text: var(--element-active-color); padding: 0 var(--inset); font-size: 13px; }
  /* Alerts only: as tall as the frame a person sees, its sections' row taking what the title, a status, the trip line and
     the footer leave, no less than their composed rows; a grid, so that row's height is definite for the list, which
     fits it or scrolls in it (the full alerts view), and the window need not zoom the display out. */
  .vignette.fill { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto 1fr auto; box-sizing: border-box; }
  .vignette.fill > :global(.sections) { grid-row: 4; min-height: 0; }
  .vignette.fill > footer { grid-row: 5; }
  footer { display: flex; align-items: center; gap: 8px; height: var(--row); min-width: 0; white-space: nowrap; }
  /* The title gives way first, by whole words (the whole in its title), down to a few; then the states wrap onto rows of their own under it. */
  header { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; min-height: var(--row); min-width: 0; }
  h1 { flex: 1 1 12em; min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; line-height: var(--row); font-size: 14px; font-weight: 600; }
  .ai { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--element-neutral-color); }
  .ai obi-ai { width: 16px; height: 16px; }
  .states { flex: 0 1 auto; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 2px 3px; min-width: 0; margin-left: auto; padding: 2px 0; }
  .chip { flex: none; padding: 0 6px; border: 1px solid; border-radius: 3px; font-size: 12px; font-weight: 700; line-height: 18px; letter-spacing: 0.03em; white-space: nowrap; }
  button.chip { font-family: inherit; cursor: pointer; }
  .chip.neutral { color: var(--element-active-color); border-color: var(--border-outline-color); }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); }
  /* Frozen: the worst it last showed, in OpenBridge's low-integrity colours. */
  .chip.doubtful { background: var(--alert-low-integrity-background-color); color: var(--element-active-color); border-color: var(--alert-low-integrity-border-color); }
  .status { margin: 0; padding: 4px 0; color: var(--element-neutral-color); }
  footer { font-size: 12px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .clock { font-weight: 700; letter-spacing: 0.04em; color: var(--element-active-color); }
  .clock.frozen { color: var(--element-neutral-color); }
  /* Where the row is short, the reason a sample froze gives way before the mark does. */
  .why { flex: 0 100 auto; min-width: 0; overflow: hidden; }
  /* The mark says it shorter where the footer is narrow (provenanceMarks), never cut. */
  .mark { flex: 0 1 auto; min-width: 0; margin-left: auto; overflow: hidden; }
  /* Read by assistive technology, not shown. */
  .announce { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
