<script lang="ts">
  import MarkTag from './MarkTag.svelte'
  import type { OptionView } from './model.ts'
  import StatusBlock from './StatusBlock.svelte'
  import { goalOrderText, statusView, type Context } from './status-text.ts'

  // The latest options, each with its status rendered from structure, its warnings beside the status,
  // and a baseline only for an option that is validated feasible on the current inputs.
  let { options, recommended, context, selected = null, busy = false, onSelect, onBaseline }: {
    options: readonly OptionView[]
    recommended: string | null
    context: Context
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
  <p class="hint">Goals in order: {goalOrderText(context.inputs.goals, context).join(' ')}</p>
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
        <StatusBlock {view} warnings={option.warnings.map(warning => warning.text)} stale={!option.fresh} />
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
