<script lang="ts">
  import { notBuiltWords } from './api.ts'
  import type { NameKind } from './explain-text.ts'
  import { proofParts } from './outcome.ts'
  import ProofParts from './ProofParts.svelte'
  import type { Context } from './status-text.ts'
  import type { Answer } from './why-text.ts'

  // "Why not possible": a refusal's full chain, asked of explain refusal only when the planner opens it. The
  // compact item carries each method's line; the path, later start and energy proof are the Module's words here.
  let { answer = null, context, onAsk, onPick }: {
    answer?: Answer<readonly string[]> | null
    context: Context
    onAsk: () => void
    onPick?: ((kind: NameKind, key: string) => void) | undefined
  } = $props()
  const parts = $derived(answer?.state === 'answered' ? proofParts(answer.facts, context) : [])
</script>

<div class="why-not">
  {#if answer === null}
    <button type="button" class="quiet" aria-expanded="false" onclick={onAsk}>Why not possible</button>
  {:else}
    <p class="proof-headline">Why not possible</p>
    {#if answer.state === 'loading'}
      <p class="hint" role="status">Asking Planning for the proof…</p>
    {:else if answer.state === 'answered'}
      <ProofParts {parts} {onPick} />
    {:else if answer.state === 'not-built'}
      <p class="hint">{notBuiltWords}</p>
    {:else if answer.state === 'refused'}
      <p class="hint">{answer.text}</p>
    {/if}
  {/if}
</div>
