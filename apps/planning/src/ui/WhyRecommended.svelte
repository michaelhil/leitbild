<script lang="ts">
  import Choice from './Choice.svelte'
  import MarkTag from './MarkTag.svelte'
  import { unpricedMark } from './unpriced.ts'
  import type { Answer, WhyView } from './why-text.ts'

  // Why the recommended option is recommended, beside the timeline, from the Module's facts: the plan's own
  // rule (every hard rule, then the goals in order), the option it was weighed against, the deciding goal,
  // the trade in each goal's unit, each goal side by side, what the method leaves unpriced, and the outage.
  let { title, policy, answer, choices = [], against = '', onAgainst, onClose }: {
    title: string
    /** The plan's rule, one line each: every hard rule, then each goal in its full words. */
    policy: readonly string[]
    answer: Answer<WhyView>
    /** The other options it can be weighed against; '' is the next in rank. */
    choices?: ReadonlyArray<{ readonly value: string; readonly label: string }>
    against?: string
    onAgainst?: ((option: string) => void) | undefined
    onClose: () => void
  } = $props()
</script>

<section class="why-panel" aria-labelledby="why-title">
  <div class="panel-heading">
    <h2 id="why-title" tabindex="-1">{title}</h2>
    <button type="button" class="quiet" onclick={onClose}>Close</button>
  </div>
  <h3>The rule it was chosen by</h3>
  <ul class="why-policy">{#each policy as line, index (index)}<li>{line}</li>{/each}</ul>
  {#if choices.length > 1 && onAgainst}
    <Choice label="Weigh it against" options={choices} bind:value={() => against, next => onAgainst?.(next)} />
  {/if}
  <h3>What decided it</h3>
  {#if answer.state === 'loading'}
    <p class="hint" aria-live="polite">Asking Planning…</p>
  {:else if answer.state === 'not-built' || answer.state === 'none'}
    <p class="not-yet">The deciding goal and the trade it made are not available yet in this version of Planning.</p>
  {:else if answer.state === 'refused'}
    <p class="error" role="alert">{answer.text}</p>
  {:else}
    {@const view = answer.facts}
    <p>{view.against}</p>
    {#if view.decided}<p class="why-decided"><strong>{view.decided}</strong></p>{/if}
    {#if view.trade}<p class="why-trade">{view.trade}</p>{/if}
    {#if view.goals.length > 0}
      <table class="why-goals">
        <thead><tr><th scope="col">Goal</th><th scope="col" class="number">This option</th>{#if view.againstLabel}<th scope="col" class="number">{view.againstLabel}</th>{/if}</tr></thead>
        <tbody>
          {#each view.goals as goal (goal.name)}
            <tr class:deciding={goal.deciding}>
              <th scope="row">{goal.name}{#if goal.deciding} <MarkTag mark={{ shape: '◆', word: 'Decided here' }} tone="good" />{/if}</th>
              <td class="number">{goal.value}</td>
              {#if view.againstLabel}<td class="number">{goal.against ?? ''}</td>{/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if view.outage}<p class="hint">{view.outage}</p>{/if}
    <h3>Unpriced</h3>
    {#if view.caveats.length === 0}
      <p class="hint">The method this option uses marks nothing as unpriced.</p>
    {/if}
    {#each view.caveats as caveat, index (index)}
      <div class="unpriced">
        <p><MarkTag mark={unpricedMark} tone="assumption" /> <strong>{caveat.line}</strong>{#if caveat.against} <span class="hint">against {caveat.against}</span>{/if}</p>
        <p class="hint">{caveat.method}{#if caveat.words}: {caveat.words}{/if}</p>
      </div>
    {/each}
  {/if}
</section>
