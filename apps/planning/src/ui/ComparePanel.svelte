<script lang="ts">
  import Choice from './Choice.svelte'
  import MarkTag from './MarkTag.svelte'
  import { noPreviousWords, type Answer, type CompareView, type PreviousRow } from './why-text.ts'

  // What differs from the earlier options, beside the timeline, from the Module's facts (explain versus): the
  // earlier set itself, the changes since, the measures that changed, the methods and purchases that differ,
  // and the jobs that moved, were added or are gone.
  let { answer, unpaired = false, previous = [], against = null, more = null, onMore, onAgainst, onClose }: {
    answer: Answer<CompareView>
    /** The earlier set has no option of the shown option's variant: the planner chooses one. */
    unpaired?: boolean
    /** The moved jobs after the first ones, in plan order, once read. */
    more?: CompareView['moved'] | null
    /** Reads the moved jobs after the first ones, when the Module pages them. */
    onMore?: (() => void) | undefined
    /** The earlier set, from the previous read section. */
    previous?: readonly PreviousRow[]
    /** The earlier option compared with. */
    against?: string | null
    onAgainst?: ((option: string) => void) | undefined
    onClose: () => void
  } = $props()
</script>

<section class="compare-panel" aria-labelledby="compare-title">
  <div class="panel-heading">
    <h2 id="compare-title" tabindex="-1">What differs from the earlier options</h2>
    <button type="button" class="quiet" onclick={onClose}>Close</button>
  </div>
  {#if previous.length > 0}
    <h3>The earlier set</h3>
    <ul class="previous-set">
      {#each previous as row (row.key)}
        <li><MarkTag mark={row.mark} tone={row.mark.shape === '✓' ? 'good' : row.mark.shape === '✕' ? 'refusal' : 'warning'} /> {row.label}{#if row.recommended}{' '}<MarkTag mark={{ shape: '★', word: 'Recommended then' }} tone="good" />{/if}</li>
      {/each}
    </ul>
    {#if previous.length > 0 && onAgainst}
      <Choice label="Compare with" options={previous.map(row => ({ value: row.key, label: row.label }))} bind:value={() => against ?? '', next => onAgainst?.(next)} />
    {/if}
  {/if}
  {#if answer.state === 'loading'}
    <p class="hint" aria-live="polite">Asking Planning…</p>
  {:else if answer.state === 'none'}
    <p class="not-yet">{unpaired ? 'The earlier set has no option of the same method. Choose one under “Compare with”.' : noPreviousWords}</p>
  {:else if answer.state === 'not-built'}
    <p class="not-yet">Comparing with the earlier options is not available yet in this version of Planning.</p>
  {:else if answer.state === 'refused'}
    <p class="error" role="alert">{answer.text}</p>
  {:else}
    {@const view = answer.facts}
    <p class="hint">{view.against}</p>
    {#if view.changes.length > 0 || view.incomplete}
      <h3>Changes since then</h3>
      <ul class="why-lines">{#each view.changes as change, index (index)}<li>{change}</li>{/each}</ul>
      {#if view.incomplete}<p class="hint">{view.incomplete}</p>{/if}
    {/if}
    {#if view.same}<p>Nothing differs: the same values, methods, purchases and times.</p>{/if}
    <h3>Measures</h3>
    {#if view.outages.length > 0}
      <!-- A group name is long: each outage is a line of its own, so the narrow column never wraps it over many lines (walk V11). -->
      <ul class="compare-outages">
        {#each view.outages as outage (outage.name)}
          <li class:changed={outage.change !== 'the same'}><span class="outage-name">{outage.name}</span>{' '}<span class="outage-figures">{outage.now}, before {outage.was} ({outage.change})</span></li>
        {/each}
      </ul>
    {/if}
    {#if view.goals === null}
      <p class="hint">{view.goalsNote}</p>
    {:else}
      <table class="compare-goals">
        <thead><tr><th scope="col">Goal</th><th scope="col" class="number">Now</th><th scope="col" class="number">Before</th><th scope="col" class="number">Change</th></tr></thead>
        <tbody>
          {#each view.goals as goal (goal.name)}
            <tr class:changed={goal.change !== 'the same'}><th scope="row">{goal.name}</th><td class="number">{goal.now}</td><td class="number">{goal.was}</td><td class="number">{goal.change}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#each [...view.methods, ...view.buys] as line, index (index)}<p class="compare-line">{line}</p>{/each}
    {#if view.moved.length > 0 || view.more}
      <h3>Jobs that moved</h3>
      <ol class="chain">
        {#each view.moved as job, index (index)}
          <li><span class="step-name">{job.job}</span> · <span class="when">{job.was} → {job.now}</span> · <span class="because">{job.shift}</span></li>
        {/each}
      </ol>
      {#if view.moreCount > 0}
        {#if more !== null && more.length > 0}
          <details class="more-moved" open><summary>Show the other {view.moreCount}</summary>
            <ol class="chain">{#each more as job, index (index)}<li><span class="step-name">{job.job}</span> · <span class="when">{job.was} → {job.now}</span> · <span class="because">{job.shift}</span></li>{/each}</ol>
          </details>
        {:else if onMore}
          <button type="button" class="link" onclick={onMore}>Show the other {view.moreCount}</button>
        {:else}
          <p class="hint">{view.more}</p>
        {/if}
      {/if}
    {/if}
    {#if view.added.length > 0}<p class="compare-line">New in this set: {view.added.join(', ')}.</p>{/if}
    {#if view.removed}<p class="compare-line">{view.removed}</p>{/if}
  {/if}
</section>
