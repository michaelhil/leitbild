<script lang="ts">
  import { tick } from 'svelte'
  import { Eye, EyeOff } from 'lucide-svelte'
  import IconButton from './components/IconButton.svelte'
  import type { FieldVisibilityOption } from './control-rail-presenter.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'

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

  let anchorElement = $state<HTMLSpanElement | null>(null)
  let menuStyle = $state('')

  const updateMenuPosition = (): void => {
    if (!anchorElement || !open) return
    const rect = anchorElement.getBoundingClientRect()
    const menuWidth = 240
    const margin = 8
    const left = Math.max(margin, Math.min(rect.left - 8, window.innerWidth - menuWidth - margin))
    const top = Math.max(margin, rect.bottom + 6)
    menuStyle = `left: ${left}px; top: ${top}px; min-width: ${menuWidth}px;`
  }

  const updateMenuPositionAfterRender = async (): Promise<void> => {
    await tick()
    updateMenuPosition()
  }

  runOnMount(() => {
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, { capture: true })
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, { capture: true })
    }
  })

  $effect(() => {
    if (!open) return
    void updateMenuPositionAfterRender()
  })
</script>

<span class="field-menu-wrap" bind:this={anchorElement}>
  <IconButton
    label="Choose visible {categoryLabel.toLowerCase()} data"
    title="Choose visible {categoryLabel.toLowerCase()} data"
    icon={Eye}
    size={14}
    variant="bare"
    onClick={toggleOpen}
  />
  {#if open}
    <div class="field-menu" role="menu" style={menuStyle}>
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
