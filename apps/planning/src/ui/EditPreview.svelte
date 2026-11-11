<script lang="ts">
  import { authorityWords } from './api.ts'
  import { sentence } from './format.ts'
  import MarkTag from './MarkTag.svelte'
  import type { Preview } from './preview.ts'
  import { problemText, type Context } from './status-text.ts'

  // Every edit is shown here before it is saved: its consequence, the rules it would break (then it is
  // refused, with the nearest allowed time), and what it weakens (then someone must agree, by name).
  let { preview, context, busy = false, onApply, onDiscard, onUseTime }: {
    preview: Preview
    context: Context
    busy?: boolean
    onApply: (authority: { name: string; reason: string } | null) => void
    onDiscard: () => void
    onUseTime: (instant: string) => void
  } = $props()

  let name = $state('')
  let reason = $state('')
  const shown = $derived(preview.result?.preview ?? null)
  const nearest = $derived(shown?.nearestAllowed ?? preview.refusal?.nearestAllowed ?? null)
  const refused = $derived(preview.refusal !== null && !preview.refusal.needsAuthority || (shown?.violations.length ?? 0) > 0 || (preview.result?.problems.length ?? 0) > 0)
  const needsAuthority = $derived((shown?.weakens.length ?? 0) > 0 || preview.refusal?.needsAuthority === true || preview.asks !== null)
  const ready = $derived(!refused && (!needsAuthority || (name.trim() !== '' && reason.trim() !== '')))
</script>

<section class="preview" aria-labelledby="preview-title" aria-live="polite">
  <h2 id="preview-title" tabindex="-1">Preview: {preview.label}</h2>
  <p class="hint">Not saved yet.</p>
  {#if refused}
    <!-- A refused change moves nothing, so no consequence is shown for it. -->
    <p><MarkTag mark={{ shape: '✕', word: 'Refused' }} tone="refusal" /> This change breaks a rule and cannot be saved.</p>
    <ul class="problems">
      {#each shown?.violations ?? [] as violation (violation)}<li>{violation}</li>{/each}
      {#each preview.result?.problems ?? [] as problem, index (index)}<li>{problemText(problem, context.names)}</li>{/each}
      {#if preview.refusal && !preview.refusal.needsAuthority}<li>{preview.refusal.text}</li>{/if}
    </ul>
  {:else if shown}
    <p>{shown.consequence}</p>
  {/if}
  {#if nearest}
    <p>Nearest allowed start: <strong>{context.format.clock(nearest)}</strong>
      <button type="button" disabled={busy} onclick={() => onUseTime(nearest)}>Use this time</button></p>
  {/if}
  {#if needsAuthority && !refused}
    <div class="authority">
      <p><MarkTag mark={{ shape: '■', word: 'Rule' }} tone="rule" /> {sentence(`${preview.asks ?? 'This change weakens a hard rule'}${shown && shown.weakens.length > 0 ? `: ${context.names.list(shown.weakens)}` : ''}`)}</p>
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
