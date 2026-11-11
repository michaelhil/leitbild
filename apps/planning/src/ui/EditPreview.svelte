<script lang="ts">
  import MarkTag from './MarkTag.svelte'
  import type { Preview } from './preview.ts'
  import type { Context } from './status-text.ts'

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
  const refused = $derived(preview.refusal !== null && !preview.refusal.needsAuthority || (shown?.violations.length ?? 0) > 0 || (preview.result?.problems.length ?? 0) > 0)
  const needsAuthority = $derived((shown?.weakens.length ?? 0) > 0 || preview.refusal?.needsAuthority === true)
  const ready = $derived(!refused && (!needsAuthority || (name.trim() !== '' && reason.trim() !== '')))
</script>

<section class="preview" aria-labelledby="preview-title" aria-live="polite">
  <h2 id="preview-title">Preview: {preview.label}</h2>
  <p class="hint">Not saved yet.</p>
  {#if shown}<p>{shown.consequence}</p>{/if}
  {#if refused}
    <p><MarkTag mark={{ shape: '✕', word: 'Refused' }} tone="refusal" /> This change cannot be saved.</p>
    <ul class="problems">
      {#each shown?.violations ?? [] as violation (violation)}<li>{violation}</li>{/each}
      {#each preview.result?.problems ?? [] as problem, index (index)}<li>{problem.text}</li>{/each}
      {#if preview.refusal && !preview.refusal.needsAuthority}<li>{preview.refusal.text}</li>{/if}
    </ul>
  {/if}
  {#if shown?.nearestAllowed}
    <p>Nearest allowed start: <strong>{context.format.clock(shown.nearestAllowed)}</strong>.
      <button type="button" disabled={busy} onclick={() => onUseTime(shown.nearestAllowed!)}>Use this time</button></p>
  {/if}
  {#if needsAuthority && !refused}
    <div class="authority">
      <p><MarkTag mark={{ shape: '■', word: 'Rule' }} tone="rule" /> This weakens {shown && shown.weakens.length > 0 ? context.names.list(shown.weakens) : 'a hard rule'}{preview.refusal ? `: ${preview.refusal.text}` : ''}. It is saved only with the name of who agreed and why, and the change log keeps both.</p>
      <label>Who agreed<input bind:value={name} autocomplete="name" /></label>
      <label>Why<input bind:value={reason} /></label>
    </div>
  {/if}
  <div class="actions">
    {#if !refused}<button type="button" class="primary" disabled={busy || !ready} onclick={() => onApply(needsAuthority ? { name: name.trim(), reason: reason.trim() } : null)}>Apply</button>{/if}
    <button type="button" disabled={busy} onclick={onDiscard}>{refused ? 'Close' : 'Cancel'}</button>
  </div>
</section>
