<script lang="ts">
  import type { FinishStep, NameKind, Part } from './explain-text.ts'
  import MarkTag from './MarkTag.svelte'
  import Said from './Said.svelte'

  // "What sets the finish", beside the timeline: the one line on what limits it most, then one row per
  // step, last job first: the job (the row's only link), its time, and one plain sentence for the cause.
  let { steps, limiting = null, onPick, onClose }: {
    steps: readonly FinishStep[]
    /** "Most limiting: …", from the same finish chain. */
    limiting?: { readonly parts: readonly Part[] } | null
    onPick?: ((kind: NameKind, key: string) => void) | undefined
    onClose: () => void
  } = $props()
</script>

<section class="finish-panel" aria-labelledby="finish-title">
  <div class="panel-heading">
    <h2 id="finish-title" tabindex="-1">What sets the finish</h2>
    <button type="button" class="quiet" onclick={onClose}>Close</button>
  </div>
  {#if steps.length === 0}
    <p class="hint">Nothing holds the last job back: it finishes as soon as its own work is done.</p>
  {:else}
    {#if limiting}<p class="limiting"><Said parts={limiting.parts} {onPick} quiet /></p>{/if}
    <p class="hint">Last job first; each row says what holds that job where it is.</p>
    <ol class="chain">
      {#each steps as step, index (index)}
        <li>
          <span class="step-name"><Said parts={[{ name: step.job, kind: 'job', key: step.jobKey }]} {onPick} /></span> · <span class="when">{step.when}</span> · <span class="because"><Said parts={step.becauseParts} {onPick} quiet /></span>
          {#if step.due}<span class="due"><MarkTag mark={{ shape: '■', word: 'Rule' }} tone="rule" /> {step.due}</span>{/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>
