<script lang="ts">
  import { categoryGroups, listPart, LIST_FILTERS, passes, type ListFilter } from '../../../features/displays/alerts/list.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { fitRow, rowParts, UNACK_WORD, unacknowledged, type RowParts } from './alerts.ts'
  import AlertRowLine from './AlertRowLine.svelte'
  import { rowMeasure } from './row-measure.ts'

  // The full alerts view (plan v5 W2.6, L4), opened after a display by its
  // "+N more" or its worst chip, with Back: every alert of its objects, grouped
  // by category (its Pack's annunciator systems; else by object) in their
  // declared order under headings that stay in view, each group in list order
  // (first-outs, own states, new, returned, then those expected after a
  // first-out, faded and saying so, and the standing ones); filtered, in the
  // grid alarm list's words: Active, Unacknowledged, Standing, All. It scrolls;
  // a row on an element opens it. Nothing here acknowledges (W2.7).
  let { rows, nowMs, several, press }: {
    rows: ReadonlyArray<AlertRow>
    nowMs: number
    several: boolean
    press: (row: AlertRow) => (() => void) | undefined
  } = $props()

  let filter = $state<ListFilter>('all')
  let width = $state<number | null>(null)
  let root: HTMLElement | undefined = $state()
  runOnMount(() => {
    if (root === undefined) return
    const observer = new ResizeObserver(() => { if (root !== undefined) width = root.clientWidth })
    observer.observe(root)
    return () => observer.disconnect()
  })
  const measure = rowMeasure()
  const counts = $derived(Object.fromEntries(LIST_FILTERS.map(option => [option.value, rows.filter(row => passes(option.value, row)).length])) as Record<ListFilter, number>)
  const groups = $derived(categoryGroups(rows.filter(row => passes(filter, row))))
  const fitted = (row: AlertRow): RowParts => {
    const parts = rowParts(row, nowMs, several ? row.objectLabel : undefined)
    return width === null ? parts : fitRow(parts, width, measure)
  }
</script>

<section class="all" aria-label="All alerts" bind:this={root}>
  <div class="filters" role="tablist" aria-label="Alert filter">
    {#each LIST_FILTERS as option (option.value)}
      <button type="button" role="tab" aria-selected={filter === option.value} class:active={filter === option.value} onclick={() => { filter = option.value }}>{option.label} {counts[option.value]}</button>
    {/each}
  </div>
  <div class="list">
    {#if groups.length === 0}
      <p class="empty">{rows.length === 0 ? 'No alerts.' : `No ${LIST_FILTERS.find(option => option.value === filter)!.label.toLowerCase()} alerts.`}</p>
    {/if}
    {#each groups as group (group.key)}
      {@const asking = group.rows.filter(unacknowledged).length}
      <h3>{group.label} · {group.rows.length}{#if asking > 0}{' · '}<span class="unack">{asking} {UNACK_WORD}</span>{/if}</h3>
      <ul>
        {#each group.rows as row (row.key)}
          <li><AlertRowLine {row} parts={fitted(row)} {nowMs} faded={listPart(row) === 'expected'} onopen={press(row)} /></li>
        {/each}
      </ul>
    {/each}
  </div>
</section>

<style>
  /* Its words stay near their row: a wide frame does not part a message from its tag and age (U-06). */
  .all { display: flex; flex-direction: column; height: 100%; min-height: 0; max-width: 760px; }
  .filters { flex: none; display: flex; gap: 4px; height: var(--row); align-items: center; }
  .filters button { height: 22px; padding: 0 8px; border: 1px solid var(--border-outline-color); border-radius: 3px; background: var(--container-section-color); color: var(--element-active-color); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .filters button.active { border-color: var(--element-active-color); font-weight: 700; }
  .filters button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  .list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  /* A group's heading stays in view while its rows scroll under it. */
  h3 { position: sticky; top: 0; z-index: 1; margin: 0; height: var(--row); line-height: var(--row); background: var(--container-background-color); font-size: 12px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; }
  ul { list-style: none; margin: 0; padding: 0; }
  .unack { font-weight: 700; color: var(--element-active-color); }
  .empty { margin: 0; height: var(--row); line-height: var(--row); color: var(--element-neutral-color); }
</style>
