<script lang="ts">
  import type { NameKind } from './explain-text.ts'
  import MarkTag from './MarkTag.svelte'
  import { sizeCautionMark } from './model.ts'
  import type { RefusalProof } from './outcome.ts'
  import ProofParts from './ProofParts.svelte'
  import type { StatusView } from './status-text.ts'

  // The status word, what it covers, each goal with how far from the best, and any warning beside it.
  // A refused option's proof is a list: "Not possible: …" with its hours, then the jobs that set it.
  let { view, warnings = [], caution = null, stale = false, proof = null, onPick }: {
    view: StatusView
    warnings?: readonly string[]
    /** The size caution in the Module's words: a chip beside the status word, and the sentence under it. */
    caution?: string | null
    stale?: boolean
    proof?: RefusalProof | null
    onPick?: ((kind: NameKind, key: string) => void) | undefined
  } = $props()
  const tone = $derived(view.word === 'validated feasible' ? 'good' : view.word === 'proven infeasible' ? 'refusal' : view.word === 'unresolved' ? 'unknown' : 'warning')
</script>

<div class="status">
  <p class="status-line"><MarkTag mark={view.mark} {tone} />{#if caution}{' '}<MarkTag mark={sizeCautionMark} tone="warning" />{/if} <span>{view.sentence}</span></p>
  {#if caution}<p class="beside caution">{caution}</p>{/if}
  {#if stale}
    <!-- What it was on the plan before the change, as a fact about that plan, never a claim about this one (walk V2). -->
    <p class="stale"><MarkTag mark={{ shape: '↻', word: 'Out of date' }} tone="warning" />{' '}{`Out of date: on the plan before your latest change this was ${view.word}. Generate again to know for the plan as it is now.`}</p>
  {/if}
  {#each warnings as warning (warning)}
    <p class="beside"><MarkTag mark={{ shape: '!', word: 'Warning' }} tone="warning" /> {warning}</p>
  {/each}
  {#if proof}
    <p class="proof-headline">{proof.headline}</p>
    <ProofParts parts={proof.parts} {onPick} />
  {:else if view.details.length > 0}
    <ul class="details">{#each view.details as detail (detail)}<li>{detail}</li>{/each}</ul>
  {/if}
  {#if view.goals.length > 0}
    <ol class="goals">
      {#each view.goals as goal, index (index)}
        <li><span class="goal-name">{goal.name}:</span> <strong>{goal.value}</strong> <MarkTag mark={goal.mark} tone={goal.mark.shape === '✓' ? 'good' : 'estimate'} />{#if goal.distance}{' '}<span class="distance">{goal.distance}</span>{/if}</li>
      {/each}
    </ol>
  {/if}
  {#if view.run}<p class="hint">{view.run}</p>{/if}
</div>
