<script lang="ts">
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { Moon, Plus, Square, Sun, X } from 'lucide-svelte'
  import IconButton from './components/IconButton.svelte'
  import StatusDot, { type StatusTone } from './components/StatusDot.svelte'
  import { iconHtml, type IconName } from './icons.ts'
  import type { ThemeMode } from './theme.ts'
  import type { CategoryRow } from './types.ts'

  export let status: string
  export let appVersion: string
  export let theme: ThemeMode
  export let collapsed: boolean
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
  export let toggleTheme: () => void

  const placementText = (): string => {
    if (!placementMode) return ''
    const placementKind = placementMode.placementKind ?? 'point'
    if (placementKind === 'route') return `Click start and end points for new ${placementMode.label.toLowerCase()}`
    if (placementKind === 'polygon') return `Click area vertices; press Enter to finish`
    return `Click map to place new ${placementMode.label.toLowerCase()}`
  }

  const statusTone = (): StatusTone => {
    const normalized = status.toLowerCase()
    if (normalized === 'connected' || normalized === 'ready') return 'ready'
    if (normalized.includes('error') || normalized.includes('disconnect') || normalized.includes('fail')) return 'error'
    if (normalized.includes('starting') || normalized.includes('creating')) return 'working'
    return 'idle'
  }
</script>

<aside class="control-rail" aria-hidden={collapsed} inert={collapsed}>
  {#if placementMode}
      <div class="placement-banner">
        {placementText()}
      <IconButton label="Cancel placement" icon={X} onClick={cancelPlacement} />
    </div>
  {/if}

  {#each categoryRows as row (row.category.id)}
    <section class="category">
      <div class="category-header">
        <h2>{row.category.label} <span>{row.objects.length}</span></h2>
        {#if row.createType}
          <IconButton
            label="Add {row.category.label.toLowerCase()}"
            title="Add {row.category.label.toLowerCase()}"
            icon={Plus}
            onClick={() => row.createType && beginPlacement(row.createType)}
          />
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
          <button class="command-button" on:click|stopPropagation={cancelDestination}>
            <Square size={16} strokeWidth={1.8} /> Cancel destination
          </button>
        {:else}
          <div class="object-meta">Click a valid target.</div>
        {/if}
      </div>
    {/if}
    {#if commandStatus}
      <div class="object-meta">{commandStatus}</div>
    {/if}
  </footer>

  <footer class="system-footer">
    <StatusDot tone={statusTone()} label={status} />
    <span class="brand">Leitbild</span>
    <span class="version">v{appVersion}</span>
    <IconButton
      label="Toggle light and dark mode"
      title="Toggle light and dark mode"
      icon={theme === 'dark' ? Sun : Moon}
      pressed={theme === 'dark'}
      onClick={toggleTheme}
    />
  </footer>
</aside>
