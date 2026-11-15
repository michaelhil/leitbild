<script lang="ts">
  import MarkTag from './MarkTag.svelte'
  import { otherWarnings, sizeCautionOf, type OptionView } from './model.ts'
  import type { NameKind } from './explain-text.ts'
  import { refusalProof } from './outcome.ts'
  import { requestText } from './request.ts'
  import StatusBlock from './StatusBlock.svelte'
  import { goalOrderShort, statusView, type Context } from './status-text.ts'

  // The latest options, each with its status rendered from structure, its warnings beside the status,
  // and a baseline only for an option that is validated feasible on the current inputs.
  let { options, recommended, context, refusals = {}, selected = null, busy = false, onSelect, onBaseline, onPick }: {
    options: readonly OptionView[]
    recommended: string | null
    context: Context
    /** Each refused option's refusal in the Module's words; shown as a list under its status. */
    refusals?: Readonly<Record<string, readonly string[]>>
    onPick?: ((kind: NameKind, key: string) => void) | undefined
    selected?: string | null
    busy?: boolean
    onSelect: (option: string) => void
    onBaseline: (option: string, name: string, note: string) => void
  } = $props()

  let baselineFor = $state<string | null>(null)
  let name = $state('')
  let note = $state('')
  const views = $derived(options.map(option => ({ option, view: statusView(option.status, context) })))
</script>

<section class="options" aria-labelledby="options-title">
  <h2 id="options-title">Options</h2>
  <p class="hint">Goals in order: {goalOrderShort(context.inputs.goals, context).join(' · ')}. Their full wording is in Rules and goals.</p>
  {#if options.length === 0}
    <p class="hint">No options yet. Generate makes them.</p>
  {/if}
  <ol class="option-list">
    {#each views as { option, view } (option.key)}
      <li class:selected={option.key === selected}>
        <div class="option-head">
          <strong>{option.label}</strong>
          {#if option.key === recommended}<MarkTag mark={{ shape: '★', word: 'Recommended' }} tone="good" />{/if}
          <button type="button" disabled={busy || option.key === selected} onclick={() => onSelect(option.key)}>{option.key === selected ? 'Shown on the timeline' : 'Show on the timeline'}</button>
          {#if option.fresh && option.status.word === 'validated feasible'}
            <button type="button" disabled={busy} onclick={() => { baselineFor = option.key; name = option.label }}>Set as baseline</button>
          {/if}
        </div>
        {#if requestText(option, context.inputs)}<p class="hint">{requestText(option, context.inputs)}</p>{/if}
        <StatusBlock {view} warnings={otherWarnings(option)} caution={sizeCautionOf(option)} stale={!option.fresh} proof={option.status.word === 'proven infeasible' ? refusalProof(refusals[option.key], context) : null} {onPick} />
        {#if baselineFor === option.key}
          <form class="mini-form" onsubmit={(event) => { event.preventDefault(); onBaseline(option.key, name.trim(), note.trim()); baselineFor = null }}>
            <h3>Baseline</h3>
            <label>Name<input bind:value={name} required /></label>
            <label>Hand-over note<textarea bind:value={note} rows="3"></textarea></label>
            <div class="actions"><button type="submit" class="primary" disabled={busy || name.trim() === ''}>Save baseline</button><button type="button" onclick={() => { baselineFor = null }}>Cancel</button></div>
          </form>
        {/if}
      </li>
    {/each}
  </ol>
</section>
