<script lang="ts">
  import Choice from './Choice.svelte'
  import type { NameKind } from './explain-text.ts'
  import type { RefusalProof } from './outcome.ts'
  import type { Context } from './status-text.ts'
  import WhatIfCard from './WhatIfCard.svelte'
  import { whatIfChoices, whatIfVariant, type WhatIfAsk, type WhatIfCardView, type WhatIfKind, type WhatIfVariant } from './what-if.ts'

  // Ask a what-if, beside the timeline: one question at a time, sent as one Generate request kept beside the
  // plan's own options. The answers are cards under the question, newest first; none is a row of the options
  // table. A part of Planning not built yet is said as "not available yet", never as a fault.
  let { context, cards, proofs = {}, kind: initialKind = null, selected = null, busy = false, asking = false, missing = null, onAsk, onSelect, onPick, onClose }: {
    context: Context
    cards: readonly WhatIfCardView[]
    /** Each refused what-if's proof, from the Module's refusal. */
    proofs?: Readonly<Record<string, RefusalProof | null>>
    /** The kind to start on, e.g. "at most … h out" when the ladder pointed here. */
    kind?: WhatIfKind | null
    selected?: string | null
    busy?: boolean
    asking?: boolean
    /** Why the last question got no answer: "not available yet", or a refusal in planner words. */
    missing?: string | null
    onAsk: (label: string, variant: WhatIfVariant) => void
    onSelect: (option: string) => void
    onPick?: ((kind: NameKind, key: string) => void) | undefined
    onClose: () => void
  } = $props()

  const choices = $derived(whatIfChoices(context))
  // svelte-ignore state_referenced_locally
  let kind = $state<string>(initialKind ?? whatIfChoices(context).kinds[0]?.value ?? 'out')
  // svelte-ignore state_referenced_locally
  let group = $state<string>(whatIfChoices(context).group)
  let hours = $state('')
  let problems = $state<readonly string[]>([])

  const explain: Readonly<Record<WhatIfKind, string>> = {
    out: 'Adds one shorter outage limit for this what-if only. The plan\'s own rules stay in force beside it.',
    first: 'Brings this group back as soon as possible first, then solves the plan\'s goals in order.',
    cheapest: 'Solves the extra cost first, keeping every hard rule; the other goals follow at that cost, and a guideline breach is shown, not hidden.',
  }
  const ask = (): void => {
    const question: WhatIfAsk = kind === 'cheapest' ? { kind: 'cheapest' } : kind === 'first' ? { kind: 'first', group } : { kind: 'out', group, hours }
    const built = whatIfVariant(question, context)
    if (!built.ok) { problems = built.problems; return }
    problems = []
    onAsk(built.label, built.variant)
  }
</script>

<section class="what-if-panel" aria-labelledby="what-if-title">
  <div class="panel-heading">
    <h2 id="what-if-title" tabindex="-1">Ask a what-if</h2>
    <button type="button" class="quiet" onclick={onClose}>Close</button>
  </div>
  <p class="hint">A what-if never changes the plan. Its answer is a card here, apart from the plan's options.</p>
  {#if choices.kinds.length === 0}
    <p class="hint">This plan has no function group or extra-cost goal to ask about.</p>
  {:else}
    <form class="mini-form what-if-form" onsubmit={(event) => { event.preventDefault(); ask() }}>
      <Choice label="Question" options={choices.kinds} bind:value={kind} disabled={asking} />
      {#if kind === 'out' || kind === 'first'}
        <Choice label="Function group" options={choices.groups} bind:value={group} disabled={asking} />
      {/if}
      {#if kind === 'out'}
        <label>Longest outage, in hours<input inputmode="decimal" bind:value={hours} placeholder="48" disabled={asking} /></label>
      {/if}
      <p class="hint">{explain[kind as WhatIfKind] ?? ''}</p>
      <div class="actions"><button type="submit" class="primary" disabled={busy || asking}>{asking ? 'Asking…' : 'Ask'}</button></div>
      {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
    </form>
  {/if}
  {#if missing}<p class="not-yet" role="status">{missing}</p>{/if}
  {#if cards.length > 0}
    <h3>What-ifs asked</h3>
    <div class="what-if-cards">
      {#each cards as card (card.key)}
        <WhatIfCard {card} proof={proofs[card.key] ?? null} selected={card.key === selected} {busy} {onSelect} {onPick} />
      {/each}
    </div>
  {/if}
</section>
