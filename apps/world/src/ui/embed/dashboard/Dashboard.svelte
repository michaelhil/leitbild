<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { simulationRunIdSchema } from '../../../core/model/index.ts'
  import { DASHBOARD_VIEW_TYPE } from '../../process-display/display-window-messages.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { openedListing } from '../opened-display.ts'
  import { embeddedDisplayFrame, hostDisplayFrame, type DisplayOpening } from '../view-host.ts'
  import { VIGNETTE_ROW_PX } from '../vignette/grid.ts'
  import Vignette from '../vignette/Vignette.svelte'
  import { createBoardVisibility, defaultText, frameAlertRows, frameEnvelope, isPhone, leadObjectOf, PHONE_SCALE, sectionEnvelope, sectionKey, sectionsShown } from './board.ts'
  import { changeDashboard, dashboardStateSchema, holdsText, pinToRunDashboard, readDashboard, REVISION_CONFLICT, staleText, type DashboardReading, type DashboardScope, type DashboardSection } from './dashboard.ts'

  // A Run's shared dashboard of one scope (plan v5 R4 B4), in the display
  // window beside the assets' defaults (D-H): on top the run frame, the whole
  // Run's alerts as a live vignette (W2's counts, tiles and list, filtered by
  // a press as in the window, its worst chip the Run-wide worst priority)
  // within 30 % of the screen's height (T17); then the sections World serves, its pins
  // or its default, each drawn by the vignette renderer and sampled while it
  // can be seen; a refused one says why. People unpin a pin here and, on a
  // dashboard of one object or of a collection, pin a section to the whole
  // Run's. The whole Run's dashboard opens each asset's own and each
  // collection it offers to compare after it, with Back. It is read again
  // when shown, every 15 s while shown, and after every change; a change
  // World refuses as stale is read again and said. A phone gets the frame and
  // one section (D9). Nothing here is stored but what World stores.
  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  const REREAD_MS = 15_000
  const runId = $derived(simulationRunIdSchema.parse(envelope.subject.id))
  const held = $derived(dashboardStateSchema.parse(JSON.parse(envelope.state)))
  const composedAt = new Date().toISOString()
  const visibility = createBoardVisibility()

  let reading = $state.raw<DashboardReading | null>(null)
  let failure = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let acting = $state(false)
  let opening = $state<DisplayOpening | null>(null)
  let pageShown = true
  let innerWidth = $state(0)
  let innerHeight = $state(0)
  let zoom = $state(1)
  /** On a phone: the one section shown. */
  let chosen = $state(0)
  let root: HTMLElement | undefined = $state()

  // T17 is a share of the screen: the browser's viewport, which this page's top window has (one origin), at the window's zoom.
  const phone = $derived(isPhone(innerWidth))
  /** A phone's parts stand at PHONE_SCALE, so no word is below 12 px (D9). */
  const scale = $derived(phone ? PHONE_SCALE : 1)
  const rows = $derived(frameAlertRows({ screen: innerHeight > 0 ? (window.top ?? window).innerHeight : 0, page: innerHeight / scale, zoom: zoom * scale }, VIGNETTE_ROW_PX))
  const entries = $derived((reading?.sections ?? []).map(section => ({ key: sectionKey(section), section, view: section.view === undefined ? null : sectionEnvelope(envelope, section.view), lead: leadObjectOf(section) })))
  const shown = $derived(sectionsShown(entries, phone, chosen))

  /** The section a cited line names (the state's `focus`: a pin's id or a title), shown and marked first (R4 §2.6). */
  const focusOf = (section: DashboardSection): boolean => held.focus !== undefined && (section.id ?? section.title).slice(0, 80) === held.focus
  /**
   * A focused section comes into view and stays there while the sections settle (each grows as its vignette first
   * reads), until the reader scrolls, presses or types in the board.
   */
  const focusFirst = (node: HTMLElement, focused: boolean) => {
    const scroller = node.parentElement
    if (!focused || scroller === null) return {}
    const observer = new ResizeObserver(() => node.scrollIntoView({ block: 'nearest' }))
    for (const section of scroller.children) observer.observe(section)
    const kinds = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
    const stop = () => { observer.disconnect(); for (const kind of kinds) scroller.removeEventListener(kind, stop) }
    for (const kind of kinds) scroller.addEventListener(kind, stop, { passive: true })
    return { destroy: stop }
  }
  let focusShown = false

  const read = async (): Promise<void> => {
    const answer = await readDashboard(runId, held.scope)
    if (answer.ok) { reading = answer.result; failure = null } else failure = answer.message
    // On a phone the focused section is the one shown, once.
    if (answer.ok && !focusShown) { focusShown = true; const at = answer.result.sections.findIndex(focusOf); if (at >= 0) chosen = at }
  }

  /** Another scope's dashboard, after this one in the window, with Back. */
  const openScope = (scope: DashboardScope, title: string) => (): void => {
    const opened = { state: JSON.stringify({ scope }), title, viewType: DASHBOARD_VIEW_TYPE } as const
    embeddedDisplayFrame().openDisplay({ ...opened, listing: () => openedListing({ key: envelope.state, title: envelope.title, envelope }, opened) })
  }

  const act = async (work: () => Promise<string | null>): Promise<void> => {
    if (acting) return
    acting = true
    try { notice = await work() } finally { acting = false }
  }
  const unpin = (section: DashboardSection & { readonly id: string }) => (): Promise<void> => act(async () => {
    const revision = reading?.revision ?? 0
    const changed = await changeDashboard(runId, { scope: held.scope, expectedRevision: revision, unpin: [section.id] })
    if (!changed.ok && changed.code === REVISION_CONFLICT) {
      const again = await readDashboard(runId, held.scope)
      if (again.ok) reading = again.result
      return staleText(`${section.title} was not unpinned`, again)
    }
    await read()
    return changed.ok ? `${section.title} is unpinned` : `${section.title} was not unpinned: ${changed.message}`
  })
  const pin = (view: { readonly state: string; readonly title: string }) => (): Promise<void> => act(() => pinToRunDashboard(runId, view))

  const observer = new IntersectionObserver(seen => { for (const entry of seen) visibility.setInView((entry.target as HTMLElement).dataset.key!, entry.isIntersecting) })
  /** A section samples only while it is scrolled into view. */
  const watched = (node: HTMLElement, key: string) => {
    node.dataset.key = key
    observer.observe(node)
    return { destroy: () => observer.unobserve(node) }
  }

  runOnMount(() => {
    const stopOpening = embeddedDisplayFrame().subscribeOpening(where => { opening = where })
    const stopZoom = embeddedDisplayFrame().subscribe(presentation => { zoom = presentation.zoom })
    const unhost = hostDisplayFrame({
      kind: 'generated',
      card: root ?? null,
      drawing: () => reading ?? undefined,
      setVisible: visible => { pageShown = visible; visibility.setPage(visible) },
      // Stepped to again in its window: what it holds may have changed meanwhile (a pin from the window's header).
      presented: () => { void read() },
    })
    const timer = setInterval(() => { if (pageShown) void read() }, REREAD_MS)
    void read()
    return () => { clearInterval(timer); observer.disconnect(); unhost(); stopOpening(); stopZoom() }
  })
</script>

<svelte:window bind:innerWidth bind:innerHeight />

<main class="dashboard" bind:this={root} aria-label={envelope.title}>
  {#if innerHeight > 0}
    {#key rows}
      <div class="frame" style:zoom={phone ? scale : undefined}><Vignette envelope={frameEnvelope(envelope, rows, composedAt)} board={{ visible: visibility.subscribe('frame'), frame: true }} /></div>
    {/key}
  {/if}
  <div class="bar" style:zoom={phone ? scale : undefined}>
    <span class="holds">{reading === null ? (failure === null ? 'Reading the dashboard…' : 'No dashboard') : reading.stored ? holdsText(reading) : defaultText(held.scope)}</span>
    {#if opening === 'window'}
      {#each held.collections ?? [] as collection (collection.category)}
        <button type="button" class="link" title="Open the dashboard of the {collection.count} {collection.label}, side by side" onclick={openScope({ of: { category: collection.category } }, `${collection.label} · dashboard`)}>Compare {collection.label} ({collection.count}) ›</button>
      {/each}
    {/if}
    {#if notice !== null}<span class="notice" role="status">{notice}</span>{/if}
  </div>
  {#if reading === null}
    {#if failure !== null}<p class="refused" role="alert">{failure}</p>{/if}
  {:else}
    {#if phone && entries.length > 1}
      <div class="step" role="group" aria-label="Sections" style:zoom={scale}>
        <button type="button" aria-label="Previous section" disabled={chosen === 0} onclick={() => { chosen = Math.max(0, chosen - 1) }}>‹</button>
        <span>{Math.min(chosen, entries.length - 1) + 1} of {entries.length}: {shown[0]?.section.title ?? ''}</span>
        <button type="button" aria-label="Next section" disabled={chosen >= entries.length - 1} onclick={() => { chosen = Math.min(entries.length - 1, chosen + 1) }}>›</button>
      </div>
    {/if}
    <div class="sections" class:phone style:zoom={phone ? scale : undefined}>
      {#each shown as entry (entry.key)}
        {@const section = entry.section}
        <section class="section" class:focused={focusOf(section)} use:watched={entry.key} use:focusFirst={focusOf(section)} aria-label={section.title} aria-current={focusOf(section) ? 'true' : undefined}>
          <div class="caption">
            {#if section.id !== undefined}<span class="by">Pinned by {section.by === 'agent' ? 'the Assistant' : 'a person'}</span>{/if}
            {#if entry.lead !== null && held.scope === 'run' && opening === 'window'}
              <button type="button" class="link" title="Open the dashboard of {section.title} after this one" onclick={openScope({ subject: entry.lead }, `${section.title} · dashboard`)}>Its dashboard ›</button>
            {/if}
            {#if entry.view !== null && held.scope !== 'run'}
              <button type="button" class="link" disabled={acting} title="Pin this section to the whole Run's dashboard" onclick={pin({ state: entry.view.state, title: section.title })}>Pin to the Run's dashboard</button>
            {/if}
            {#if section.id !== undefined}
              <button type="button" class="link" disabled={acting} title="Take this pin off the dashboard" onclick={unpin({ ...section, id: section.id })}>Unpin</button>
            {/if}
          </div>
          {#if entry.view !== null}
            <Vignette envelope={entry.view} board={{ visible: visibility.subscribe(entry.key), frame: false }} />
          {:else}
            <p class="refused"><strong>{section.title}</strong> cannot be shown: {section.refused?.message ?? 'World sent no view for it'}</p>
          {/if}
        </section>
      {/each}
      {#if reading.more !== undefined}
        <p class="more">+{reading.more} more: World's default shows {entries.length}; the others have their overviews in this window's list</p>
      {/if}
    </div>
  {/if}
</main>

<style>
  .dashboard { display: flex; flex-direction: column; height: 100vh; min-width: 0; font-size: 13px; }
  /* The run frame stands; the sections scroll under it. */
  .frame { flex: none; }
  .bar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 0 12px; min-height: 24px; padding: 0 8px; border-top: 1px solid var(--border-divider-color); font-size: 12px; color: var(--element-neutral-color); }
  .notice { color: var(--element-active-color); }
  .sections { flex: 1 1 0; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); align-content: start; gap: 12px; padding: 4px 8px 12px; }
  .sections.phone { grid-template-columns: minmax(0, 1fr); }
  .section { min-width: 0; border: 1px solid var(--border-divider-color); border-radius: 6px; }
  /* The section a cited line names: marked as the focus is, so the eye finds it. */
  .section.focused { border-color: var(--border-focus-color); box-shadow: 0 0 0 1px var(--border-focus-color); }
  .caption { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 0 12px; min-height: 24px; padding: 0 8px; font-size: 12px; color: var(--element-neutral-color); }
  .caption .by { margin-right: auto; }
  .link { height: 24px; padding: 0 4px; border: 0; border-radius: 3px; background: none; color: var(--element-active-color); font: inherit; font-weight: 600; white-space: nowrap; cursor: pointer; }
  .link:hover { background: var(--flat-hover-background-color); }
  .link:disabled { color: var(--element-disabled-color); cursor: progress; }
  button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .refused, .more { margin: 0; padding: 8px; color: var(--element-neutral-color); }
  .step { flex: none; display: flex; align-items: center; gap: 8px; padding: 0 8px; font-size: 13px; }
  .step span { flex: 1 1 0; min-width: 0; }
  .step button { width: 32px; height: 32px; border: 1px solid var(--border-outline-color); border-radius: 4px; background: var(--container-section-color); color: var(--element-active-color); font: inherit; font-size: 16px; cursor: pointer; }
  .step button:disabled { color: var(--element-disabled-color); cursor: default; }
</style>
