<script lang="ts">
  import { tick } from 'svelte'
  let { value, fallback, label, onsave }: {
    value: string
    fallback: string
    label: string
    onsave: (name: string, original: string) => Promise<void>
  } = $props()
  let editing = $state(false)
  let draft = $state('')
  let original = ''
  let saving = $state(false)
  let error = $state<string | null>(null)
  let input = $state<HTMLInputElement | null>(null)

  const edit = async (): Promise<void> => {
    draft = value
    original = value
    error = null
    editing = true
    await tick()
    input?.focus()
    input?.select()
  }
  const save = async (): Promise<void> => {
    if (saving) return
    saving = true
    error = null
    try {
      if (draft.trim() !== original) await onsave(draft.trim(), original)
      editing = false
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally { saving = false }
  }
</script>

<span class="inline-name" class:editing>
  {#if editing}
    <input bind:this={input} bind:value={draft} aria-label={label} placeholder={fallback} maxlength="256" disabled={saving}
      onkeydown={event => {
        if (event.isComposing) return
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save() }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing = false }
      }}
      onblur={() => { if (!saving && !error) editing = false }} />
    {#if error}<small class="inline-error" role="alert">{error}</small>{/if}
  {:else}
    <span class="name-text">{value || fallback}</span>
    <button class="name-edit card-control" type="button" title="Rename" aria-label={label} onclick={() => void edit()}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5M3 21l5-1L21 7a3.5 3.5 0 0 0-5-5L3 15z" /></svg>
    </button>
  {/if}
</span>
