<script lang="ts">
  import type { NameKind } from './explain-text.ts'
  import type { ProofPart } from './outcome.ts'
  import Said from './Said.svelte'

  // A refusal's words in the Module's order: each sentence, and each list of jobs as rows of a name and its times.
  let { parts, onPick }: {
    parts: readonly ProofPart[]
    onPick?: ((kind: NameKind, key: string) => void) | undefined
  } = $props()
</script>

{#each parts as part, index (index)}
  {#if part.text}<p class="proof-text">{part.text}</p>{/if}
  {#if part.steps.length > 0}
    <ol class="chain">
      {#each part.steps as step, at (at)}
        <li><span class="step-name">{#if step.job}<Said parts={[{ name: step.name, kind: 'job', key: step.job }]} {onPick} />{:else}{step.name}{/if}</span>{#if step.detail} · <span class="when">{step.detail}</span>{/if}</li>
      {/each}
    </ol>
  {/if}
{/each}
