<script lang="ts">
  import { X } from 'lucide-svelte'
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../core/packs/protocol.ts'
  import IconButton from './components/IconButton.svelte'
  import StatusIndicator from './components/StatusIndicator.svelte'

  interface Props {
    readonly object: OperationalObject
    readonly presentation: PackObjectPresentation
    readonly statusPresentation: PackObjectStatusPresentation
    readonly selected: boolean
    readonly hasNewInfo: boolean
    readonly visibleFields: ReadonlyArray<PackObjectField>
    readonly markSeen: (object: OperationalObject) => void
    readonly selectObject: (object: OperationalObject) => void
    readonly deleteObject: (object: OperationalObject) => Promise<void>
  }

  let {
    object,
    presentation,
    statusPresentation,
    selected,
    hasNewInfo,
    visibleFields,
    markSeen,
    selectObject,
    deleteObject,
  }: Props = $props()

  let newInfoBadge: HTMLButtonElement | null = $state(null)
  let newInfoTooltipVisible = $state(false)
  let newInfoTooltipPosition = $state({ left: 0, top: 0, width: 250 })

  const newInfoSummary = $derived(
    presentation.fields.length === 0
      ? presentation.summary
      : presentation.fields.map(field => `${field.label}: ${field.value}`).join(' · '),
  )

  const showNewInfoTooltip = (): void => {
    if (!newInfoBadge) return
    const rect = newInfoBadge.getBoundingClientRect()
    const margin = 12
    const desiredWidth = 250
    const width = Math.min(desiredWidth, Math.max(180, window.innerWidth - margin * 2))
    const left = Math.min(rect.left, window.innerWidth - width - margin)
    newInfoTooltipPosition = {
      left: Math.max(margin, left),
      top: rect.bottom + 6,
      width,
    }
    newInfoTooltipVisible = true
  }

  const acknowledgeNewInfo = (): void => {
    if (!hasNewInfo) return
    newInfoTooltipVisible = false
    markSeen(object)
  }
</script>

<div
  class:selected
  class:has-new-info={hasNewInfo}
  class:muted={presentation.muted === true}
  class="object-row"
  role="button"
  tabindex="0"
  onclick={() => selectObject(object)}
  onkeydown={(event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectObject(object)
  }}
>
  <div class="object-row-main">
    <span class="object-status">
      <StatusIndicator tone={statusPresentation.tone} label={statusPresentation.label} indicator={statusPresentation.indicator} />
    </span>
    <span class="object-row-content">
      <span class="row-title">
        <span class="row-title-text">{object.label}</span>
        {#if hasNewInfo}
          <button
            bind:this={newInfoBadge}
            class="new-info-dot"
            type="button"
            aria-label="Acknowledge new information for {object.label}"
            onmouseenter={showNewInfoTooltip}
            onfocus={showNewInfoTooltip}
            onclick={(event) => {
              event.stopPropagation()
              acknowledgeNewInfo()
            }}
            onmouseleave={acknowledgeNewInfo}
            onblur={acknowledgeNewInfo}
          >
            new
          </button>
        {/if}
      </span>
    </span>
  </div>
  <button class="row-info" type="button" aria-label="Show {object.label} details" onclick={(event) => event.stopPropagation()}>
    ?
    <span class="row-tooltip">
      <strong>{object.label}</strong>
      {#each presentation.fields as field}<span>{field.label}: {field.value}</span>{/each}
    </span>
  </button>
  <IconButton
    label="Delete {object.label}"
    title="Delete {object.label}"
    icon={X}
    size={13}
    variant="bare"
    onClick={() => deleteObject(object)}
  />
  {#if visibleFields.length > 0}
    <div class="object-row-details">
      {#each visibleFields as field (field.key)}
        <span class="object-meta"><strong>{field.label}:</strong> {field.value}</span>
      {/each}
    </div>
  {/if}
</div>

{#if hasNewInfo && newInfoTooltipVisible}
  <div
    class="new-info-tooltip"
    style:left="{newInfoTooltipPosition.left}px"
    style:top="{newInfoTooltipPosition.top}px"
    style:width="{newInfoTooltipPosition.width}px"
  >
    <strong>New information</strong>
    <span>{newInfoSummary}</span>
  </div>
{/if}
