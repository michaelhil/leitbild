<script lang="ts">
  import { Eye, EyeOff } from 'lucide-svelte'
  import IconButton from './components/IconButton.svelte'

  export interface FieldVisibilityOption {
    readonly key: string
    readonly label: string
  }

  export let categoryLabel: string
  export let open: boolean
  export let fields: ReadonlyArray<FieldVisibilityOption>
  export let isVisible: (field: string) => boolean
  export let toggleOpen: () => void
  export let toggleField: (field: string) => void
</script>

<span class="field-menu-wrap">
  <IconButton
    label="Choose visible {categoryLabel.toLowerCase()} data"
    title="Choose visible {categoryLabel.toLowerCase()} data"
    icon={Eye}
    size={14}
    variant="bare"
    onClick={toggleOpen}
  />
  {#if open}
    <div class="field-menu" role="menu">
      {#if fields.length === 0}
        <div class="field-menu-empty">No data fields</div>
      {:else}
        {#each fields as field (field.key)}
          {@const visible = isVisible(field.key)}
          <button class="field-toggle" type="button" on:click|stopPropagation={() => toggleField(field.key)}>
            <svelte:component this={visible ? Eye : EyeOff} size={13} strokeWidth={1.8} />
            <span>{field.label}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</span>
