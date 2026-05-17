<script lang="ts">
  import type { Component } from 'svelte'

  export let label: string
  export let icon: Component
  export let pressed: boolean | undefined = undefined
  export let disabled = false
  export let title = label
  export let size = 16
  export let onClick: () => void | Promise<void>
</script>

<button
  class="icon-button"
  type="button"
  aria-label={label}
  aria-pressed={pressed}
  {title}
  {disabled}
  on:click|stopPropagation={() => void onClick()}
>
  <svelte:component this={icon} size={size} strokeWidth={1.8} />
</button>
