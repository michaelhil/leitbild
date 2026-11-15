<script lang="ts">
  import type { Card, CardAction } from './attention.ts'
  import MarkTag from './MarkTag.svelte'

  // The cards a planner acts on, in order. An answer a card asks for ("What sets the finish?") opens
  // beside the timeline (FinishPanel), never in this column.
  let { cards, busy = false, onAction }: {
    cards: readonly Card[]
    busy?: boolean
    onAction: (action: CardAction) => void
  } = $props()

  const actionWords: Readonly<Record<CardAction, string>> = {
    'open-workspace': 'Open the Workspace',
    'link-run': 'Link the running simulation',
    refresh: 'Read the World values',
    'add-work': 'Add equipment and jobs',
    generate: 'Generate',
    'why-finish': 'What sets the finish?',
    'align-window': 'Align the window to the simulation',
  }
  const tone = (shape: string) => shape === '✕' ? 'refusal' : shape === '?' ? 'unknown' : shape === '!' ? 'warning' : shape === '✓' ? 'good' : shape === '■' ? 'rule' : 'plain'
</script>

<section class="attention" aria-labelledby="attention-title">
  <h2 id="attention-title">Needs your attention</h2>
  {#if cards.length === 0}
    <p class="hint">Nothing needs your attention.</p>
  {/if}
  <ol class="cards">
    {#each cards as card, index (index)}
      <li class="card">
        <MarkTag mark={card.mark} tone={tone(card.mark.shape)} />
        <p class="card-title">{card.title}</p>
        {#if card.text}<p class="card-text">{card.text}</p>{/if}
        {#if card.steps.length > 0}
          <ul class="card-steps">{#each card.steps as step (step)}<li>{step}</li>{/each}</ul>
        {/if}
        {#if card.actions.length > 0}
          <div class="card-actions">
            {#each card.actions as action (action)}
              <button type="button" disabled={busy} onclick={() => onAction(action)}>{actionWords[action]}</button>
            {/each}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</section>
