<script lang="ts">
  import { fitLines, listLines, type ListLine } from '../../../features/displays/alerts/list.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { elementOf, fitRow, inSection, rowParts, UNACK_WORD, unacknowledged, type RowParts } from './alerts.ts'
  import AlertRowLine from './AlertRowLine.svelte'
  import AlertsView from './AlertsView.svelte'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { rowMeasure } from './row-measure.ts'
  import { vignetteOpening } from './opening.svelte.ts'

  // A vignette's alerts (plan v5 W2.5): its objects' alert rows (or the whole
  // Run's), or only those on its elements or observables, in list order
  // (features/displays/alerts/list.ts): first-outs ("1st RX TRIP: …"), what
  // challenges an object's own states, new alarms by priority, returned ones,
  // then "15 expected after RX TRIP ▸" and "2 standing ▸", each opening in
  // place. It fills the room its frame gives it, a row to a line, each row's
  // parts fitted to its width (fitRow); what does not fit is counted on "+N more", which opens the
  // full alerts view (L4) after this display, and the closing aggregates keep
  // their lines. A row on an element opens it: its drawing here selects it,
  // else its default opens after this display (opening.svelte.ts). The full
  // view itself is AlertsView.
  let { rows, section, room }: {
    rows: ReadonlyArray<AlertRow>
    /** Its objects (or the whole Run), and the elements or observables it narrows to; `all`: the full alerts view. */
    section: Pick<Extract<VignetteSection, { kind: 'alerts' }>, 'objectIds' | 'elements' | 'refs' | 'all'>
    /** The section's rows: one for its head, the rest for lines, until it has measured its room. */
    room: number
  } = $props()

  const opening = vignetteOpening()
  let root: HTMLElement | undefined = $state()
  let list: HTMLElement | undefined = $state()
  /** The section's width and the height its lines have, what its head (shown or not) leaves them. */
  let size = $state<{ width: number; height: number } | null>(null)
  let open = $state<ReadonlySet<string>>(new Set())
  let failure = $state<string | null>(null)
  runOnMount(() => {
    if (root === undefined || list === undefined) return
    const observer = new ResizeObserver(() => { if (root !== undefined && list !== undefined) size = { width: root.clientWidth, height: list.clientHeight } })
    observer.observe(root)
    observer.observe(list)
    return () => observer.disconnect()
  })

  const own = $derived(rows.filter(inSection(section)))
  const several = $derived(new Set(own.map(row => row.objectId)).size > 1)
  const nowMs = $derived(opening?.now ?? Number.NaN)
  const measure = rowMeasure()
  /** What of a row stands on its one line in the section's width. */
  const fitted = (row: AlertRow): RowParts => {
    const parts = rowParts(row, nowMs, several ? row.objectLabel : undefined)
    return size === null ? parts : fitRow(parts, size.width, measure)
  }
  /** Grid rows for lines: what its list measures, else its composed rows less its head. */
  const budget = $derived(Math.max(1, size === null ? room - 1 - (failure === null ? 0 : 1) : Math.floor(size.height / VIGNETTE_ROW_PX)))
  const lines = $derived(listLines(own, open))
  const fit = $derived(fitLines(lines, budget))
  const unack = $derived(own.filter(unacknowledged).length)
  const hiddenUnack = $derived(fit.hidden.filter(unacknowledged).length)
  const title = $derived(section.objectIds === 'run' || several ? 'Alerts in the Run' : `Alerts · ${own[0]?.objectLabel ?? ''}`)

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
  <AlertsView rows={own} {nowMs} {several} {press} />
{:else}
  <section class="alerts" aria-label="Alerts" bind:this={root}>
    <h2>{section.objectIds === 'run' ? 'Alerts in the Run' : 'Alerts'} · {own.length === 0 ? 'none' : own.length}{#if unack > 0}{' · '}<span class="unack">{unack} {UNACK_WORD}</span>{/if}</h2>
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
