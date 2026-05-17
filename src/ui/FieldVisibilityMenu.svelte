<script lang="ts">
  import { Eye, EyeOff } from 'lucide-svelte'
  import IconButton from './components/IconButton.svelte'
  import type { FieldVisibilityOption } from './control-rail-presenter.ts'

  interface Props {
    readonly categoryLabel: string
    readonly open: boolean
    readonly fields: ReadonlyArray<FieldVisibilityOption>
    readonly isVisible: (field: string) => boolean
    readonly toggleOpen: () => void
    readonly toggleField: (field: string) => void
  }

  let {
    categoryLabel,
    open,
    fields,
    isVisible,
    toggleOpen,
    toggleField,
  }: Props = $props()
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
          {@const VisibilityIcon = visible ? Eye : EyeOff}
          <button class="field-toggle" type="button" onclick={(event) => { event.stopPropagation(); toggleField(field.key) }}>
            <VisibilityIcon size={13} strokeWidth={1.8} />
            <span>{field.label}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</span>
