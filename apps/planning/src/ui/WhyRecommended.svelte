<script lang="ts">
  import MarkTag from './MarkTag.svelte'
  import { unpricedLine, unpricedMark } from './unpriced.ts'
  import type { Answer, WhyView } from './why-text.ts'

  // Why the recommended option is recommended, beside the timeline: the plan's own rule (every hard rule,
  // then the goals in order), the Module's answer with the deciding goal and the trade, and what the method
  // leaves unpriced, beside the other methods' so they can be weighed.
  let { view, answer, onClose }: { view: WhyView; answer: Answer; onClose: () => void } = $props()
</script>

<section class="why-panel" aria-labelledby="why-title">
  <div class="panel-heading">
    <h2 id="why-title" tabindex="-1">{view.title}</h2>
    <button type="button" class="quiet" onclick={onClose}>Close</button>
  </div>
  <h3>The rule it was chosen by</h3>
  <p class="why-policy">{view.policy}</p>
  <h3>What decided it</h3>
  {#if answer.state === 'loading'}
    <p class="hint" aria-live="polite">Asking Planning…</p>
  {:else if answer.state === 'not-built'}
    <p class="not-yet">{view.missing}</p>
  {:else if answer.state === 'refused'}
    <p class="error" role="alert">{answer.text}</p>
  {:else}
    <ul class="why-lines">{#each answer.lines as line, index (index)}<li>{line}</li>{/each}</ul>
  {/if}
  <h3>Unpriced</h3>
  {#if view.unpriced.length === 0 && view.otherMethods.length === 0}
    <p class="hint">Nothing in this plan is marked as unpriced.</p>
  {:else}
    {#if view.unpriced.length === 0}<p class="hint">The method this option uses marks nothing as unpriced.</p>{/if}
    {#each view.unpriced as item, index (index)}
      <div class="unpriced">
        <p><MarkTag mark={unpricedMark} tone="assumption" /> <strong>{unpricedLine(item)}</strong> <span class="hint">({item.method})</span></p>
        <p class="hint">{item.words}</p>
        {#if item.agreement}<p class="hint">Needs the agreement of {item.agreement}, listed with the baseline.</p>{/if}
      </div>
    {/each}
    {#if view.otherMethods.length > 0}
      <p class="hint">For comparison:</p>
      <ul class="unpriced-others">
        {#each view.otherMethods as entry (entry.method)}
          {#each entry.items as item, index (index)}<li>{entry.method}: {unpricedLine(item)}</li>{/each}
        {/each}
      </ul>
    {/if}
  {/if}
</section>
