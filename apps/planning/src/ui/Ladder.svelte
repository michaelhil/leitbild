<script lang="ts">
  import type { NameKind } from './explain-text.ts'
  import { finerTrade, type LadderView } from './ladder.ts'
  import MarkTag from './MarkTag.svelte'
  import Said from './Said.svelte'

  // "What overtime buys", beside the timeline: the rungs of bought crew time, lowest first, and between two
  // rungs the Module's word for what the higher one gains, exactly as it gives it, with the hours and money.
  let { view, state, text = null, busy = false, solving = false, selected = null, onSolve, onFiner, onSelect, onPick, onClose }: {
    view: LadderView | null
    state: 'loading' | 'ready' | 'not-built' | 'refused'
    /** A refusal in planner words, for state "refused". */
    text?: string | null
    busy?: boolean
    solving?: boolean
    selected?: string | null
    onSolve: () => void
    onFiner: () => void
    onSelect: (option: string) => void
    onPick?: ((kind: NameKind, key: string) => void) | undefined
    onClose: () => void
  } = $props()

  const rowInto = (rung: number) => view?.rows.find(row => row.to === rung) ?? null
</script>

<section class="ladder" aria-labelledby="ladder-title">
  <div class="panel-heading">
    <h2 id="ladder-title" tabindex="-1">What overtime buys</h2>
    <button type="button" class="quiet" onclick={onClose}>Close</button>
  </div>
  <p class="hint">Each rung adds bought crew time to the one below. Rebookings and tool days are allowed on every rung.</p>
  {#if state === 'loading'}
    <p class="hint" aria-live="polite">Reading what overtime buys…</p>
  {:else if state === 'not-built'}
    <p class="not-yet">What overtime buys is not available yet in this version of Planning. Until it is, Generate with and without “Days only” and compare the two in the options table.</p>
  {:else if state === 'refused'}
    <p class="error" role="alert">{text}</p>
  {:else if view !== null}
    {#if view.rungs.length === 0}<p class="hint">This plan buys no crew time, so there is no ladder to show.</p>{/if}
    <ol class="rungs">
      {#each view.rungs as rung (rung.rung)}
        {@const row = rowInto(rung.rung)}
        {#if row}
          <li class="ladder-step">
            <span class="ladder-word">{row.word}</span>{#if row.differences} <span class="ladder-difference">{row.differences}</span>{/if}
            {#if row.finish}<span class="ladder-finish">What sets the finish: <Said parts={row.finish} {onPick} quiet /></span>{/if}
          </li>
        {/if}
        <li class="rung" class:selected={rung.option !== null && rung.option === selected}>
          <span class="rung-number" aria-hidden="true">{rung.step}</span>
          <div class="rung-body">
            <p class="rung-name"><span class="sr-only">Rung {rung.step}: </span>{rung.name}</p>
            {#if rung.option !== null && rung.mark}
              <p class="chips"><MarkTag mark={rung.mark} tone={rung.tone} />{#if rung.stale} <MarkTag mark={{ shape: '↻', word: 'Out of date' }} tone="warning" />{/if}</p>
              {#if rung.outcome}<p class="rung-outcome">{rung.outcome}</p>{/if}
              {#each rung.uses as use (use)}<p class="rung-use">{use}</p>{/each}
              <button type="button" class="quiet" disabled={busy || rung.option === selected} onclick={() => { if (rung.option !== null) onSelect(rung.option) }}>{rung.option === selected ? 'Shown on the timeline' : 'Show on the timeline'}</button>
            {:else}
              <p class="hint">Not worked out yet on this plan.</p>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
    {#if view.toSolve.length > 0}
      <div class="actions">
        <button type="button" class="primary" disabled={busy || solving} onclick={onSolve}>{view.toSolve.length === view.rungs.length ? 'Work out every rung' : `Work out the ${view.toSolve.length === 1 ? 'missing rung' : `${view.toSolve.length} missing rungs`}`}</button>
      </div>
      <p class="hint">One Generate per rung, lowest first, so a rung starts from the one below it. The plan's own options stay.</p>
    {/if}
    <p class="hint finer">{finerTrade} <button type="button" class="link" onclick={onFiner}>Ask a what-if</button></p>
  {/if}
</section>
