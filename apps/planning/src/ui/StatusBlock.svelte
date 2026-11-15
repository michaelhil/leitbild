<script lang="ts">
  import type { NameKind } from './explain-text.ts'
  import MarkTag from './MarkTag.svelte'
  import type { RefusalProof } from './outcome.ts'
  import Said from './Said.svelte'
  import type { StatusView } from './status-text.ts'

  // The status word, what it covers, each goal with how far from the best, and any warning beside it.
  // A refused option's proof is a list: "Not possible: …" with its hours, then the jobs that set it.
  let { view, warnings = [], stale = false, proof = null, onPick }: {
    view: StatusView
    warnings?: readonly string[]
    stale?: boolean
    proof?: RefusalProof | null
    onPick?: ((kind: NameKind, key: string) => void) | undefined
  } = $props()
  const tone = $derived(view.word === 'validated feasible' ? 'good' : view.word === 'proven infeasible' ? 'refusal' : view.word === 'unresolved' ? 'unknown' : 'warning')
</script>

<div class="status">
  <p class="status-line"><MarkTag mark={view.mark} {tone} /> <span>{view.sentence}</span></p>
  {#if stale}
    <p class="stale"><MarkTag mark={{ shape: '↻', word: 'Out of date' }} tone="warning" /> Made before the latest change: its status is not claimed for the current plan. Generate again.</p>
  {/if}
  {#each warnings as warning (warning)}
    <p class="beside"><MarkTag mark={{ shape: '!', word: 'Warning' }} tone="warning" /> {warning}</p>
  {/each}
  {#if proof}
    <p class="proof-headline">{proof.headline}</p>
    {#each proof.parts as part, index (index)}
      {#if part.text}<p class="proof-text">{part.text}</p>{/if}
      {#if part.steps.length > 0}
        <ol class="chain">
          {#each part.steps as step, at (at)}
            <li><span class="step-name">{#if step.job}<Said parts={[{ name: step.name, kind: 'job', key: step.job }]} {onPick} />{:else}{step.name}{/if}</span>{#if step.detail} · <span class="when">{step.detail}</span>{/if}</li>
          {/each}
        </ol>
      {/if}
    {/each}
  {:else if view.details.length > 0}
    <ul class="details">{#each view.details as detail (detail)}<li>{detail}</li>{/each}</ul>
  {/if}
  {#if view.goals.length > 0}
    <ol class="goals">
      {#each view.goals as goal, index (index)}
        <li><span class="goal-name">{goal.name}:</span> <strong>{goal.value}</strong> <MarkTag mark={goal.mark} tone={goal.mark.shape === '✓' ? 'good' : 'estimate'} />{#if goal.distance} <span class="distance">{goal.distance}</span>{/if}</li>
      {/each}
    </ol>
  {/if}
  {#if view.run}<p class="hint">{view.run}</p>{/if}
</div>
