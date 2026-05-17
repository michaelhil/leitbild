<script lang="ts">
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { ChevronDown, ChevronRight, Moon, Plus, Sun, X } from 'lucide-svelte'
  import IconButton from './components/IconButton.svelte'
  import StatusDot, { type StatusTone } from './components/StatusDot.svelte'
  import { iconHtml, isIconName, type IconName } from './icons.ts'
  import type { ThemeMode } from './theme.ts'
  import type { CategoryRow } from './types.ts'

  export let status: string
  export let appVersion: string
  export let theme: ThemeMode
  export let collapsed: boolean
  export let categoryRows: ReadonlyArray<CategoryRow>
  export let placementMode: PackCreateObjectType | null
  export let selectedControllerId: string | null
  export let presentationFor: (object: OperationalObject) => PackObjectPresentation
  export let detailLines: (object: OperationalObject) => ReadonlyArray<string>
  export let hasNewInfo: (object: OperationalObject) => boolean
  export let markSeen: (object: OperationalObject) => void
  export let selectObject: (object: OperationalObject) => void
  export let beginPlacement: (type: PackCreateObjectType) => void
  export let cancelPlacement: () => void
  export let toggleTheme: () => void

  let collapsedCategoryIds = new Set<string>()

  const placementText = (): string => {
    if (!placementMode) return ''
    const placementKind = placementMode.placementKind ?? 'point'
    if (placementKind === 'route') return `Click start and end points for new ${placementMode.label.toLowerCase()}`
    if (placementKind === 'polygon') return `Click area vertices; press Enter to finish`
    return `Click map to place new ${placementMode.label.toLowerCase()}`
  }

  const statusTone = (): StatusTone => {
    const normalized = status.trim().toLowerCase()
    if (normalized === 'connected' || normalized === 'ready') return 'ready'
    if (normalized.includes('error') || normalized.includes('disconnect') || normalized.includes('fail')) return 'error'
    if (normalized.includes('starting') || normalized.includes('creating')) return 'working'
    return 'idle'
  }

  const objectStatusTone = (object: OperationalObject): StatusTone => {
    const normalized = object.operational.status.trim().toLowerCase()
    if (normalized.includes('error') || normalized.includes('blocked') || normalized.includes('critical')) return 'error'
    if (normalized.includes('target') || normalized.includes('en_route') || normalized.includes('on_scene') || normalized.includes('limited')) return 'working'
    if (normalized.includes('available') || normalized.includes('open') || normalized.includes('active')) return 'ready'
    return 'idle'
  }

  const categoryIcon = (row: CategoryRow): IconName | null => {
    const icon = row.createType?.icon ?? ''
    if (!icon) return null
    if (!isIconName(icon)) throw new Error(`category ${row.category.id} requested unknown icon: ${icon}`)
    return icon
  }

  const categoryCollapsed = (categoryId: string): boolean =>
    collapsedCategoryIds.has(categoryId)

  const toggleCategory = (categoryId: string): void => {
    const next = new Set(collapsedCategoryIds)
    if (next.has(categoryId)) {
      next.delete(categoryId)
    } else {
      next.add(categoryId)
    }
    collapsedCategoryIds = next
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
    {@const headerIcon = categoryIcon(row)}
    <section class="category">
      <div class="category-header">
        <div class="category-title">
          {#if headerIcon}
            <span class="category-icon">{@html iconHtml(headerIcon, { size: 17 })}</span>
          {/if}
          <h2>{row.category.label} <span>({row.objects.length})</span></h2>
          {#if row.createType}
            <IconButton
              label="Add {row.category.label.toLowerCase()}"
              title="Add {row.category.label.toLowerCase()}"
              icon={Plus}
              size={14}
              variant="bare"
              onClick={() => row.createType && beginPlacement(row.createType)}
            />
          {/if}
        </div>
        <IconButton
          label="{categoryCollapsed(row.category.id) ? 'Expand' : 'Collapse'} {row.category.label.toLowerCase()}"
          title="{categoryCollapsed(row.category.id) ? 'Expand' : 'Collapse'} {row.category.label.toLowerCase()}"
          icon={categoryCollapsed(row.category.id) ? ChevronRight : ChevronDown}
          size={15}
          variant="ghost"
          onClick={() => toggleCategory(row.category.id)}
        />
      </div>
      {#if !categoryCollapsed(row.category.id)}
        {#if row.objects.length === 0}
          <div class="empty-row">{row.category.emptyLabel}</div>
        {/if}
        {#each row.objects as object (object.id)}
          <button class:selected={selectedControllerId === object.id} class:has-new-info={hasNewInfo(object)} class="object-row" on:mouseenter={() => markSeen(object)} on:focus={() => markSeen(object)} on:click={() => selectObject(object)}>
            <span class="object-status"><StatusDot tone={objectStatusTone(object)} label={object.operational.status} /></span>
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
      {/if}
    </section>
  {/each}

  <footer class="system-footer">
    <StatusDot tone={statusTone()} label={status} />
    <span class="brand">Leitbild</span>
    <span class="version">v{appVersion}</span>
    <IconButton
      label="Toggle light and dark mode"
      title="Toggle light and dark mode"
      icon={theme === 'dark' ? Sun : Moon}
      pressed={theme === 'dark'}
      variant="bare"
      onClick={toggleTheme}
    />
  </footer>
</aside>
