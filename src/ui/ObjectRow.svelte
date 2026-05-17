<script lang="ts">
  import { X } from 'lucide-svelte'
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../core/packs/protocol.ts'
  import IconButton from './components/IconButton.svelte'
  import StatusIndicator from './components/StatusIndicator.svelte'

  export let object: OperationalObject
  export let presentation: PackObjectPresentation
  export let statusPresentation: PackObjectStatusPresentation
  export let selected: boolean
  export let hasNewInfo: boolean
  export let visibleFields: ReadonlyArray<PackObjectField>
  export let markSeen: (object: OperationalObject) => void
  export let selectObject: (object: OperationalObject) => void
  export let deleteObject: (object: OperationalObject) => Promise<void>
</script>

<div
  class:selected
  class:has-new-info={hasNewInfo}
  class:muted={presentation.muted === true}
  class="object-row"
>
  <button class="object-row-main" type="button" on:mouseenter={() => markSeen(object)} on:focus={() => markSeen(object)} on:click={() => selectObject(object)}>
    <span class="object-status">
      <StatusIndicator tone={statusPresentation.tone} label={statusPresentation.label} indicator={statusPresentation.indicator} />
    </span>
    <span>
      <span class="row-title">{object.label}{#if hasNewInfo} <span class="new-info-dot">new</span>{/if}</span>
      {#each visibleFields as field (field.key)}
        <span class="object-meta"><strong>{field.label}:</strong> {field.value}</span>
      {/each}
    </span>
    <span class="row-info" aria-label="Show {object.label} details">
      ?
      <span class="row-tooltip">
        <strong>{object.label}</strong>
        {#each presentation.fields as field}<span>{field.label}: {field.value}</span>{/each}
      </span>
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
</div>
