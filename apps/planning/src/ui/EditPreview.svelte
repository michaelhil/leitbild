<script lang="ts">
  import type { Edit } from '../plan/edit-schema.ts'
  import { authorityWords } from './api.ts'
  import Choice from './Choice.svelte'
  import { crewEdit } from './edit-forms.ts'
  import { sentence } from './format.ts'
  import MarkTag from './MarkTag.svelte'
  import { createNames, namesInEdits } from './model.ts'
  import type { Preview } from './preview.ts'
  import type { Context } from './status-text.ts'

  // Every edit is shown here before it is saved. Only a refusal stops it: the edit itself is invalid, and
  // the rule, what could lift it and the nearest allowed time are said. A change the current option can no
  // longer keep is saved and asks for Generate; what Generate still needs is listed, and a drafted
  // tag-out or test can be given its crew right here.
  let { preview, pending = [], context, busy = false, onApply, onDiscard, onUseTime, onAddEdits }: {
    preview: Preview
    pending?: readonly Edit[]
    context: Context
    busy?: boolean
    onApply: (authority: { name: string; reason: string } | null) => void
    onDiscard: () => void
    onUseTime: (instant: string) => void
    onAddEdits?: (edits: readonly Edit[]) => void
  } = $props()

  let name = $state('')
  let reason = $state('')
  let crewFor = $state<Record<string, string>>({})
  const names = $derived(createNames(context.inputs, namesInEdits(pending)))
  const shown = $derived(preview.result?.preview ?? null)
  const problems = $derived(preview.result?.problems ?? [])
  const nearest = $derived(shown?.nearestAllowed ?? preview.refusal?.nearestAllowed ?? null)
  const refused = $derived(preview.refusal !== null && !preview.refusal.needsAuthority)
  const needsAuthority = $derived((shown?.weakens.length ?? 0) > 0 || preview.refusal?.needsAuthority === true || preview.asks !== null)
  const ready = $derived(!refused && (!needsAuthority || (name.trim() !== '' && reason.trim() !== '')))
  /** Crews and tools to choose from: the plan's and any this preview adds. */
  const crews = $derived([
    ...context.inputs.resources.map(item => ({ value: item.key, label: item.label })),
    ...pending.flatMap(edit => edit.edit === 'resource' && edit.label !== undefined && !context.inputs.resources.some(item => item.key === edit.key) ? [{ value: edit.key, label: edit.label }] : []),
  ])
  const chooseCrew = (job: string, crew: string) => {
    crewFor[job] = crew
    const built = crewEdit(job, crew)
    if (built.ok && onAddEdits !== undefined) onAddEdits(built.edits)
  }
</script>

<section class="preview" aria-labelledby="preview-title" aria-live="polite">
  <h2 id="preview-title" tabindex="-1">Preview: {preview.label}</h2>
  <p class="hint">Not saved yet.</p>
  {#if refused}
    <p><MarkTag mark={{ shape: '✕', word: 'Refused' }} tone="refusal" /> This change cannot be saved.</p>
    {#if preview.refusal}<p class="problems">{preview.refusal.text}</p>{/if}
  {:else if shown}
    <p>{shown.consequence}</p>
    {#if shown.violations.length > 0}
      <p><MarkTag mark={{ shape: '!', word: 'Generate again' }} tone="warning" /> The change can be saved, but the current option would then break:</p>
      <ul class="problems">{#each shown.violations as violation (violation)}<li>{violation}</li>{/each}</ul>
      <p class="hint">After saving, generate new options.</p>
    {/if}
  {/if}
  {#if problems.length > 0 && !refused}
    <h3>Before Generate can run</h3>
    <ul class="before-generate">
      {#each problems as problem, index (index)}
        <li>
          {problem.text}
          {#if problem.code === 'no-crew' && problem.about[0] !== undefined && onAddEdits !== undefined}
            {@const job = problem.about[0]}
            <Choice label="Who does it" bind:value={() => crewFor[job] ?? '', next => chooseCrew(job, next)} options={[{ value: '', label: 'Choose a crew or tool…' }, ...crews]} disabled={busy} />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if nearest}
    <p>Nearest allowed start: <strong>{context.format.when(nearest)}</strong>
      <button type="button" disabled={busy} onclick={() => onUseTime(nearest)}>Use this time</button></p>
  {/if}
  {#if needsAuthority && !refused}
    <div class="authority">
      <p><MarkTag mark={{ shape: '■', word: 'Rule' }} tone="rule" /> {sentence(`${preview.asks ?? 'This change weakens a hard rule'}${shown && shown.weakens.length > 0 ? `: ${names.list(shown.weakens)}` : ''}`)}</p>
      <p>{preview.refusal?.text ?? authorityWords} The change log keeps the name and the reason.</p>
      <label>Who agreed<input bind:value={name} autocomplete="off" /></label>
      <label>Their reason<input bind:value={reason} /></label>
    </div>
  {/if}
  <div class="actions">
    {#if !refused}<button type="button" class="primary" disabled={busy || !ready} onclick={() => onApply(needsAuthority ? { name: name.trim(), reason: reason.trim() } : null)}>Apply</button>{/if}
    <button type="button" disabled={busy} onclick={onDiscard}>{refused ? 'Close' : 'Cancel'}</button>
  </div>
</section>
