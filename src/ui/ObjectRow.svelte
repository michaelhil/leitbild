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

  const newInfoSummary = $derived(
    presentation.fields.length === 0
      ? presentation.summary
      : presentation.fields.map(field => `${field.label}: ${field.value}`).join(' · '),
  )

  const acknowledgeNewInfo = (): void => {
    if (!hasNewInfo) return
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
            class="new-info-dot"
            type="button"
            aria-label="Acknowledge new information for {object.label}"
            onclick={(event) => {
              event.stopPropagation()
              acknowledgeNewInfo()
            }}
            onmouseleave={acknowledgeNewInfo}
            onblur={acknowledgeNewInfo}
          >
            new
            <span class="new-info-tooltip">
              <strong>New information</strong>
              <span>{newInfoSummary}</span>
            </span>
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
