<script lang="ts">
  import type { VignetteView } from '../../../features/displays/compose/model.ts'
  import { answerNotices, resetSeen } from './answer-notice.ts'
  import { clockText } from './format.ts'

  // An answer's vignette, in its one reserved row under the title (plan v5
  // W8.2): first what makes it stale, "Run reset after this answer" (said
  // from the first sample behind the answer's time, or a sample behind the one
  // before it, and kept) and "Model changed after this answer"; then when it
  // was composed and why. The reason gives way by its end; its whole text
  // stays in the title.
  let { answer, at }: {
    answer: NonNullable<VignetteView['answer']>
    /** The latest sample's time, undefined before one. */
    at: { readonly at: string; readonly clock: 'simulation' | 'wall' } | undefined
  } = $props()

  // Judged on each sample as it comes, and kept once said: the samples before it are not state the page reads.
  let seen = false
  let previous: typeof at = undefined
  const reset = $derived.by(() => {
    if (at !== undefined && resetSeen(answer.at, previous, at)) seen = true
    if (at !== undefined) previous = at
    return seen
  })
  const notices = $derived(answerNotices({ reset, modelChanged: answer.modelChanged === true }))
  const composed = $derived(`Composed ${answer.at.clock === 'simulation' ? 'sim ' : ''}${clockText(answer.at.at)}`)
  const why = $derived(answer.why === undefined ? '' : `Why this view: ${answer.why}`)
</script>

<p class="answer" title={[...notices, composed, why].filter(part => part !== '').join(' · ')}>
  {#each notices as notice (notice)}<strong class="stale" role="status">{notice}</strong>{/each}
  <span class="when">{composed}</span>
  {#if why !== ''}<span class="why">{why}</span>{/if}
</p>

<style>
  /* One row: the notices and the time whole, the reason after them, giving way at its end. */
  .answer { display: flex; align-items: baseline; gap: 8px; height: var(--row); margin: 0; overflow: hidden; line-height: var(--row); font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; }
  .stale { flex: none; padding: 0 6px; border: 1px solid var(--border-outline-color); border-radius: 3px; line-height: 18px; color: var(--element-active-color); font-weight: 600; }
  .when { flex: none; font-variant-numeric: tabular-nums; }
  .why { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
</style>
