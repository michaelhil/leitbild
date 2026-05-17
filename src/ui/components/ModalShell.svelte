<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { X } from 'lucide-svelte'

  export let title: string
  export let close: () => void
  export let closeOnBackdrop = true
  export let closeOnEscape = true
  export let size: 'small' | 'medium' | 'large' = 'medium'
  export let description: string | null = null

  const closeFromBackdrop = (): void => {
    if (closeOnBackdrop) close()
  }

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!closeOnEscape || event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
</script>

<div class="modal-backdrop" role="presentation" on:mousedown={closeFromBackdrop}>
  <dialog class="modal-shell {size}" open aria-modal="true" aria-label={title} on:mousedown|stopPropagation>
    <header class="modal-header">
      <div>
        <h2>{title}</h2>
        {#if description}
          <p>{description}</p>
        {/if}
      </div>
      <button class="icon-button" type="button" aria-label="Close" title="Close" on:click|stopPropagation={close}>
        <X size={16} strokeWidth={1.8} />
      </button>
    </header>
    <div class="modal-body">
      <slot />
    </div>
    <footer class="modal-footer">
      <slot name="footer" />
    </footer>
  </dialog>
</div>
