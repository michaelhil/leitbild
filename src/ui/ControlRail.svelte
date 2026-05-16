<script lang="ts">
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { iconHtml, type IconName } from './icons.ts'
  import type { CategoryRow } from './types.ts'

  export let status: string
  export let commandStatus: string
  export let categoryRows: ReadonlyArray<CategoryRow>
  export let placementMode: PackCreateObjectType | null
  export let selectedControllerId: string | null
  export let selectedControllerObject: OperationalObject | null
  export let objects: ReadonlyArray<OperationalObject>
  export let iconForPresentation: (presentation: PackObjectPresentation) => IconName
  export let presentationFor: (object: OperationalObject) => PackObjectPresentation
  export let detailLines: (object: OperationalObject) => ReadonlyArray<string>
  export let hasNewInfo: (object: OperationalObject) => boolean
  export let markSeen: (object: OperationalObject) => void
  export let selectObject: (object: OperationalObject) => void
  export let beginPlacement: (type: PackCreateObjectType) => void
  export let cancelPlacement: () => void
  export let cancelDestination: () => Promise<void>
</script>

<aside class="control-rail">
  <header class="rail-header">
    <div class="brand">Leitbild</div>
    <div class="object-meta">{status}</div>
  </header>

  {#if placementMode}
      <div class="placement-banner">
        Click map to place new {placementMode.label.toLowerCase()}
      <button class="icon-button" on:click|stopPropagation={cancelPlacement}>{@html iconHtml('x', { size: 16 })}</button>
    </div>
  {/if}

  {#each categoryRows as row (row.category.id)}
    <section class="category">
      <div class="category-header">
        <h2>{row.category.label} <span>{row.objects.length}</span></h2>
        {#if row.createType}
          <button
            class="icon-button"
            title="Add {row.category.label.toLowerCase()}"
            on:click|stopPropagation={() => row.createType && beginPlacement(row.createType)}
          >{@html iconHtml('plus', { size: 16 })}</button>
        {/if}
      </div>
      {#if row.objects.length === 0}
        <div class="empty-row">{row.category.emptyLabel}</div>
      {/if}
      {#each row.objects as object (object.id)}
        <button class:selected={selectedControllerId === object.id} class:has-new-info={hasNewInfo(object)} class="object-row" on:mouseenter={() => markSeen(object)} on:focus={() => markSeen(object)} on:click={() => selectObject(object)}>
          <span>{@html iconHtml(iconForPresentation(presentationFor(object)), { size: 18 })}</span>
          <span>
            <span class="row-title">{object.label}{#if hasNewInfo(object)} <span class="new-info-dot">new</span>{/if}</span>
            <span class="object-meta">{presentationFor(object).summary}</span>
          </span>
          <span class="row-hover-card">
            <strong>{object.label}</strong>
            {#each detailLines(object) as line}<span>{line}</span>{/each}
          </span>
        </button>
      {/each}
    </section>
  {/each}

  <footer class="rail-footer">
    {#if selectedControllerObject}
      <div class="selected-card">
        <strong>{selectedControllerObject.label}</strong>
        <div class="object-meta">{selectedControllerObject.operational.status}</div>
        {#if selectedControllerObject.tasking?.currentTaskId}
          <div class="object-meta">Destination: {objects.find(object => object.id === selectedControllerObject?.tasking?.currentTaskId)?.label ?? selectedControllerObject.tasking.currentTaskId}</div>
          <button class="command-button" on:click|stopPropagation={cancelDestination}>{@html iconHtml('stop', { size: 16 })} Cancel destination</button>
        {:else}
          <div class="object-meta">Click a valid target.</div>
        {/if}
      </div>
    {/if}
    {#if commandStatus}
      <div class="object-meta">{commandStatus}</div>
    {/if}
  </footer>
</aside>
