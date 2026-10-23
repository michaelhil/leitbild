<script lang="ts">
  import { alertCensus, alertTiles, filtered, type AlertFilter, type DeclaredCategory } from '../../../features/displays/alerts/census.ts'
  import { fitLines, listLines, type ListLine } from '../../../features/displays/alerts/list.ts'
  import { unacknowledged, type AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import AlertCounts from './AlertCounts.svelte'
  import { elementOf, fitRow, inSection, rowParts, UNACK_WORD, type RowParts } from './alerts.ts'
  import AlertRowLine from './AlertRowLine.svelte'
  import AlertsView from './AlertsView.svelte'
  import AlertTiles from './AlertTiles.svelte'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { rowMeasure } from './row-measure.ts'
  import { markElements } from './selection.ts'
  import { tileLayout, tilesHeight } from './tile-fit.ts'
  import { vignetteOpening } from './opening.svelte.ts'

  // A vignette's alerts (plan v5 W2.1, W2.2, W2.5): its objects' alert rows
  // (or the whole Run's), or only those on its elements or observables, in
  // list order (features/displays/alerts/list.ts): first-outs ("1st RX TRIP:
  // …"), what challenges an object's own states, new alarms by priority,
  // returned ones, then "15 expected after RX TRIP ▸" and "2 standing ▸",
  // each opening in place. About whole objects, it heads with its counts
  // (AlertCounts) and, where they leave room for three rows, its tiles
  // (AlertTiles): each narrows the list (never to no rows), a tile also
  // pointing its alerts' items out on the drawing (selection.ts). It fills the
  // room its frame gives it, a row to a line, each row's parts fitted to its
  // width (fitRow); what does not fit is counted on "+N more", which opens the
  // full alerts view (L4) after this display, and the closing aggregates keep
  // their lines. A row on an element opens it: its drawing here selects it,
  // else its default opens after this display (opening.svelte.ts). The full
  // view itself is AlertsView.
  let { rows, categories, section, room }: {
    rows: ReadonlyArray<AlertRow>
    /** By object: the categories its Pack declares (the sample's), its tiles. */
    categories?: Readonly<Record<string, ReadonlyArray<DeclaredCategory>>> | undefined
    /** Its objects (or the whole Run), and the elements or observables it narrows to; `all`: the full alerts view. */
    section: Pick<Extract<VignetteSection, { kind: 'alerts' }>, 'objectIds' | 'elements' | 'refs' | 'all'>
    /** The section's rows: one for its head, the rest for lines, until it has measured its room. */
    room: number
  } = $props()

  /** The fewest lines the tiles leave the list: three rows, "+N more" and an aggregate (§5.5: counts and three rows on screen). */
  const LINES_BESIDE_TILES = 5

  const opening = vignetteOpening()
  let root: HTMLElement | undefined = $state()
  let head: HTMLElement | undefined = $state()
  let list: HTMLElement | undefined = $state()
  /** The section's width and height, its head's, and the height its lines have: what its head and tiles leave them. */
  let size = $state<{ width: number; height: number; head: number; lines: number } | null>(null)
  let open = $state<ReadonlySet<string>>(new Set())
  let chosen = $state<AlertFilter | null>(null)
  let failure = $state<string | null>(null)
  runOnMount(() => {
    if (root === undefined || list === undefined) return
    const observer = new ResizeObserver(() => {
      if (root !== undefined && list !== undefined) size = { width: root.clientWidth, height: root.clientHeight, head: head?.offsetHeight ?? 0, lines: list.clientHeight }
    })
    for (const node of [root, list, head]) if (node !== undefined) observer.observe(node)
    return () => { observer.disconnect(); markElements(null) }
  })

  const own = $derived(rows.filter(inSection(section)))
  const several = $derived(new Set(own.map(row => row.objectId)).size > 1)
  /** About whole objects: it counts and tiles them; an element's or a value's own alerts are a few rows. */
  const whole = $derived(section.elements === undefined && section.refs === undefined)
  const objects = $derived(section.objectIds === 'run' ? [...new Set(own.map(row => row.objectId))] : section.objectIds)
  const census = $derived(alertCensus(own))
  const tiles = $derived(whole ? alertTiles(own, objects.length === 1 ? categories?.[objects[0]!] : undefined) : [])
  /** What it is narrowed to, while that keeps a row. */
  const filter = $derived(chosen !== null && filtered(own, chosen, tiles).length > 0 ? chosen : null)
  const listed = $derived(filter === null ? own : filtered(own, filter, tiles))
  const nowMs = $derived(opening?.now ?? Number.NaN)
  const measure = rowMeasure()
  /** What of a row stands on its one line in the section's width. */
  const fitted = (row: AlertRow): RowParts => {
    const parts = rowParts(row, nowMs, several ? row.objectLabel : undefined)
    return size === null ? parts : fitRow(parts, size.width, measure)
  }
  const layout = $derived(size === null ? null : tileLayout(tiles, size.width, measure))
  // Narrowed, every aggregate stands open: the rows it was narrowed to are what it shows.
  const lines = $derived(listLines(listed, filter === null ? open : 'all'))
  /** Tiles stand where they leave the list its fewest lines. */
  const tiled = $derived(tiles.length > 0 && size !== null && layout !== null
    && size.height - size.head - tilesHeight(tiles, layout.columns) - 4 >= Math.min(listLines(own, open).length, LINES_BESIDE_TILES) * VIGNETTE_ROW_PX)
  /** Grid rows for lines: what its list measures, else its composed rows less its head. */
  const budget = $derived(Math.max(1, size === null ? room - 1 - (failure === null ? 0 : 1) : Math.floor(size.lines / VIGNETTE_ROW_PX)))
  const fit = $derived(fitLines(lines, budget))
  const hiddenUnack = $derived(fit.hidden.filter(unacknowledged).length)
  const title = $derived(section.objectIds === 'run' || several ? 'Alerts in the Run' : `Alerts · ${own[0]?.objectLabel ?? ''}`)

  const narrow = (next: AlertFilter | null): void => {
    chosen = next
    const tile = next?.kind === 'tile' ? tiles.find(entry => entry.key === next.key) : undefined
    markElements(tile === undefined ? null : { objectId: tile.rows[0]!.objectId, elementIds: tile.rows.flatMap(row => elementOf(row) ?? []) })
  }
  const toggle = (key: string): void => { open = open.has(key) ? new Set([...open].filter(entry => entry !== key)) : new Set([...open, key]) }
  const press = (row: AlertRow): (() => void) | undefined => {
    const element = elementOf(row)
    if (opening === undefined || element === undefined || opening.where === null) return undefined
    return () => { void opening.element(row.objectId, element).then(reason => { failure = reason === null ? null : `${row.alert.message} cannot be opened: ${reason}` }) }
  }
  const more = (): void => { opening?.alerts(section.objectIds, title.replace(/ · $/, '')) }
</script>

{#snippet line(entry: ListLine)}
  {#if entry.kind === 'row'}
    <li><AlertRowLine row={entry.row} parts={fitted(entry.row)} {nowMs} faded={entry.part === 'expected'} onopen={press(entry.row)} /></li>
  {:else}
    {@const asking = entry.rows.filter(unacknowledged).length}
    <li><button type="button" class="aggregate" class:expected={entry.part === 'expected'} aria-expanded={entry.open} onclick={() => toggle(entry.key)}>
      <span class="label">{entry.label}</span>{#if asking > 0}<span class="unack">{asking} {UNACK_WORD}</span>{/if}<span class="caret" aria-hidden="true">{entry.open ? '▾' : '▸'}</span>
    </button></li>
  {/if}
{/snippet}

{#if section.all === true}
  <AlertsView rows={own} {categories} {nowMs} {several} {press} />
{:else}
  <section class="alerts" aria-label="Alerts" bind:this={root}>
    <div class="head" bind:this={head}>
      {#if whole}
        <h2>{section.objectIds === 'run' ? 'Alerts in the Run' : 'Alerts'} · {own.length === 0 ? 'none' : own.length}</h2>
        <AlertCounts {census} {filter} onfilter={narrow} />
      {:else}
        <h2>Alerts · {own.length === 0 ? 'none' : own.length}{#if census.unacknowledged > 0}{' · '}<span class="unack">{census.unacknowledged} {UNACK_WORD}</span>{/if}</h2>
      {/if}
    </div>
    {#if tiled && layout !== null}<div class="tiles"><AlertTiles {tiles} {layout} {filter} onfilter={narrow} /></div>{/if}
    {#if failure !== null}<p class="failure" role="status">{failure}</p>{/if}
    <ul bind:this={list}>
      {#each fit.shown as entry (entry.kind === 'row' ? `${entry.part}|${entry.row.key}` : entry.key)}{@render line(entry)}{/each}
      {#if fit.hidden.length > 0}
        <li>
          {#if opening !== undefined && opening.where !== null}
            <button type="button" class="more" title="Open every alert, by category" onclick={more}>+{fit.hidden.length} more{#if hiddenUnack > 0}{' · '}{hiddenUnack} {UNACK_WORD}{/if} ›</button>
          {:else}
            <p class="more">+{fit.hidden.length} more{#if hiddenUnack > 0}{' · '}{hiddenUnack} {UNACK_WORD}{/if}</p>
          {/if}
        </li>
      {/if}
      {#each fit.pinned as entry (entry.kind === 'row' ? entry.row.key : entry.key)}{@render line(entry)}{/each}
    </ul>
  </section>
{/if}

<style>
  /* Its words stay near their row: a wide frame does not part a message from its tag and age (U-06). */
  .alerts { display: flex; flex-direction: column; height: 100%; max-width: 760px; overflow: hidden; }
  /* Its head: its name and count, then its counts, wrapping where they do not fit beside it. */
  .head { flex: none; display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; min-width: 0; }
  .tiles { flex: none; margin-bottom: 4px; }
  h2 { flex: none; margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; }
  /* The lines take what the head leaves: the room the list measures. */
  ul { flex: 1 1 0; min-height: 0; list-style: none; margin: 0; padding: 0; }
  .unack { font-weight: 700; color: var(--element-active-color); text-transform: uppercase; letter-spacing: 0.03em; }
  .aggregate, .more { display: flex; align-items: center; gap: 6px; width: 100%; height: var(--row); margin: 0; padding: 0 0 0 26px; border: 0; background: none; color: var(--element-active-color); font: inherit; font-size: 12px; text-align: left; white-space: nowrap; overflow: hidden; }
  button.aggregate, button.more { cursor: pointer; }
  button.aggregate:hover, button.more:hover { background: var(--flat-hover-background-color); }
  button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  /* An aggregate of expected alerts is set apart by a dashed rule, never by an alarm colour. */
  .aggregate.expected { border-left: 2px dashed var(--border-outline-color); padding-left: 24px; }
  .aggregate .label { font-weight: 600; }
  .caret { margin-left: auto; color: var(--element-neutral-color); }
  p.more { color: var(--element-neutral-color); }
  .failure { flex: none; margin: 0; font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
