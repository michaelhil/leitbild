<script lang="ts">
  import type { Priority } from '../../../core/model/alerts.ts'
  import { sameFilter, type AlertCensus, type AlertFilter } from '../../../features/displays/alerts/census.ts'
  import { counterCounts, priorityWords, UNACK_WORD } from './alerts.ts'
  import './openbridge.ts'

  // An alert list's counts (plan v5 W2.1): its news by priority, each in
  // OpenBridge's obc-alert-counter-item, then the unacknowledged, then apart
  // from the news those expected after a first-out, the standing and the
  // advisory ones (features/displays/alerts/census.ts): every alert once.
  // Each count is a button that narrows the list to what it counts and,
  // pressed again, widens it; a count of none is not shown.
  let { census, filter, onfilter }: {
    census: AlertCensus
    filter: AlertFilter | null
    onfilter: (filter: AlertFilter | null) => void
  } = $props()

  const byPriority = (priority: Priority | null): AlertFilter => ({ kind: 'priority', priority })
  const apart = (counted: 'expected' | 'standing' | 'advisory'): AlertFilter => ({ kind: 'apart', counted })
  const press = (next: AlertFilter) => (): void => { onfilter(sameFilter(filter, next) ? null : next) }
  const quiet = $derived([
    { counted: 'expected' as const, count: census.expected },
    { counted: 'standing' as const, count: census.standing },
    { counted: 'advisory' as const, count: census.advisory },
  ].filter(entry => entry.count > 0))
</script>

<div class="counts" role="group" aria-label="Alert counts">
  {#each census.news as entry (entry.priority ?? 'undeclared')}
    {@const counts = counterCounts(entry.priority, entry.count)}
    <button type="button" class="count" aria-pressed={sameFilter(filter, byPriority(entry.priority))} title={`${entry.count} ${priorityWords(entry.priority)}, not expected: show only these`} onclick={press(byPriority(entry.priority))}>
      {#if counts === null}<span class="word">{entry.count} {priorityWords(entry.priority)}</span>{:else}<obc-alert-counter-item {counts}></obc-alert-counter-item>{/if}
    </button>
  {/each}
  {#if census.unacknowledged > 0}
    <button type="button" class="count" aria-pressed={sameFilter(filter, { kind: 'unacknowledged' })} title={`${census.unacknowledged} unacknowledged: show only these`} onclick={press({ kind: 'unacknowledged' })}>
      <span class="word unack">{census.unacknowledged} {UNACK_WORD}</span>
    </button>
  {/if}
  {#each quiet as entry (entry.counted)}
    <button type="button" class="count" aria-pressed={sameFilter(filter, apart(entry.counted))} title={`${entry.count} ${entry.counted}: show only these`} onclick={press(apart(entry.counted))}>
      <span class="word">{entry.count} {entry.counted}</span>
    </button>
  {/each}
</div>

<style>
  .counts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
  .count { display: inline-flex; align-items: center; height: var(--row); padding: 0 2px; border: 1px solid transparent; border-radius: 4px; background: none; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
  .count:hover { background: var(--flat-hover-background-color); }
  .count:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  /* The count the list is narrowed to. */
  .count[aria-pressed='true'] { border-color: var(--element-active-color); background: var(--flat-activated-background-color); }
  .word { padding: 0 4px; font-size: 12px; color: var(--element-neutral-color); }
  .unack { font-weight: 700; letter-spacing: 0.03em; color: var(--element-active-color); }
</style>
