<script lang="ts">
  let { value, onapply, label = 'Advanced configuration' }: { value: unknown; onapply: (value: unknown) => Promise<void>; label?: string } = $props()
  let dialog: HTMLDialogElement
  let text = $state('')
  let initial = $state('')
  let error = $state<string | null>(null)
  let busy = $state(false)
  const open = () => { text = JSON.stringify(value, null, 2); initial = text; error = null; dialog.showModal() }
  const close = () => { if (!busy && (text === initial || confirm('Discard unapplied configuration edits?'))) dialog.close() }
  const apply = async () => {
    busy = true; error = null
    try { await onapply(JSON.parse(text)); dialog.close() }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    finally { busy = false }
  }
</script>
<button type="button" onclick={open}>{label}…</button>
<dialog bind:this={dialog} oncancel={event => { event.preventDefault(); close() }}>
  <h2>{label}</h2><p>Edits are validated against the full scenario before applying. Unchanged sections are preserved.</p>
  <textarea aria-label={label} bind:value={text} spellcheck="false" disabled={busy}></textarea>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer><button onclick={close} disabled={busy}>Cancel</button><button onclick={() => void apply()} disabled={busy}>{busy ? 'Validating…' : 'Apply'}</button></footer>
</dialog>
<style>
  dialog { width: min(850px, 90vw); max-height: 90vh; color: #e6edf7; background: #142131; border: 1px solid #425670; border-radius: 12px; padding: 24px; }
  dialog::backdrop { background: #0008; }
  textarea { display: block; box-sizing: border-box; width: 100%; height: 52vh; font: 13px/1.5 monospace; color: inherit; background: #09131f; padding: 12px; }
  footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 12px; }
  [role=alert] { color: #ffabab; white-space: pre-wrap; }
</style>
