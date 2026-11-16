<script lang="ts">
  import type { NameKind } from './explain-text.ts'
  import MarkTag from './MarkTag.svelte'
  import type { RefusalProof } from './outcome.ts'
  import type { Context } from './status-text.ts'
  import StatusBlock from './StatusBlock.svelte'
  import { unpricedLine, unpricedMark } from './unpriced.ts'
  import { whatIfApart, type WhatIfCardView } from './what-if.ts'
  import type { Answer } from './why-text.ts'
  import WhyNotPossible from './WhyNotPossible.svelte'

  // One what-if's answer, as a card: what was asked, that it is a what-if and not the plan's ranking, its
  // status with the lead's line first and the other goals as "best found at that cost", and what its method
  // leaves unpriced. It is never a row of the options table and is never recommended. A refused one offers
  // "Why not possible": its full chain from explain refusal (`why`), asked when the planner opens it.
  let { card, context, proof = null, why = null, selected = false, busy = false, onSelect, onWhy, onPick }: {
    card: WhatIfCardView
    context: Context
    proof?: RefusalProof | null
    why?: Answer<readonly string[]> | null
    selected?: boolean
    busy?: boolean
    onSelect: (option: string) => void
    onWhy?: ((option: string) => void) | undefined
    onPick?: ((kind: NameKind, key: string) => void) | undefined
  } = $props()
</script>

<article class="what-if-card" class:selected aria-labelledby="what-if-{card.key}">
  <p class="what-if-head"><MarkTag mark={{ shape: '◇', word: 'What-if' }} tone="estimate" /> <strong id="what-if-{card.key}">{card.label}</strong></p>
  <p class="hint">{card.question}</p>
  <p class="what-if-apart">{whatIfApart}</p>
  <StatusBlock view={card.status} warnings={card.warnings} caution={card.caution} stale={card.stale} {proof} {onPick} />
  {#if card.status.word === 'proven infeasible' && onWhy}<WhyNotPossible answer={why} {context} onAsk={() => onWhy(card.key)} {onPick} />{/if}
  {#if card.outage}<p class="what-if-outage">{card.outage}</p>{/if}
  {#if card.against}<p class="what-if-against">{card.against}</p>{/if}
  {#each card.unpriced as item, index (index)}
    <p class="beside"><MarkTag mark={unpricedMark} tone="assumption" title={item.words} /> {unpricedLine(item)}</p>
  {/each}
  <button type="button" class="quiet" disabled={busy || selected} onclick={() => onSelect(card.key)}>{selected ? 'Shown on the timeline' : 'Show on the timeline'}</button>
</article>
