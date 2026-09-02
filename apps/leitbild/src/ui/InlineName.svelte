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

<span class="inline-name card-control">
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
    <button class="name-button" type="button" title="Click to rename" aria-label={label} onclick={() => void edit()}>{value || fallback}</button>
  {/if}
</span>
