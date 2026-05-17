<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { ChevronDown, ChevronRight, Eye, EyeOff, Moon, Plus, Sun, X } from 'lucide-svelte'
  import IconButton from './components/IconButton.svelte'
  import StatusDot, { type StatusTone } from './components/StatusDot.svelte'
  import StatusIndicator from './components/StatusIndicator.svelte'
  import { iconHtml, isIconName, type IconName } from './icons.ts'
  import type { ThemeMode } from './theme.ts'
  import type { CategoryRow } from './types.ts'

  export let status: string
  export let systemStatusTone: StatusTone
  export let appVersion: string
  export let theme: ThemeMode
  export let collapsed: boolean
  export let categoryRows: ReadonlyArray<CategoryRow>
  export let placementMode: PackCreateObjectType | null
  export let selectedControllerId: string | null
  export let presentationFor: (object: OperationalObject) => PackObjectPresentation
  export let hasNewInfo: (object: OperationalObject) => boolean
  export let markSeen: (object: OperationalObject) => void
  export let selectObject: (object: OperationalObject) => void
  export let deleteObject: (object: OperationalObject) => Promise<void>
  export let beginPlacement: (type: PackCreateObjectType) => void
  export let cancelPlacement: () => void
  export let toggleTheme: () => void
  export let openStatusModal: () => void

  type VisibilityState = Record<string, ReadonlyArray<string>>

  let collapsedCategoryIds: Record<string, boolean> = {}
  let openFieldCategoryId: string | null = null
  let visibleFieldsByCategory: VisibilityState = {}

  const placementText = (): string => {
    if (!placementMode) return ''
    const placementKind = placementMode.placementKind ?? 'point'
    if (placementKind === 'route') return `Click start and end points for new ${placementMode.label.toLowerCase()}`
    if (placementKind === 'polygon') return `Click area vertices; press Enter to finish`
    return `Click map to place new ${placementMode.label.toLowerCase()}`
  }

  const objectStatus = (object: OperationalObject) =>
    presentationFor(object).status ?? { tone: 'idle' as const, label: object.operational.status, indicator: { shape: 'dot' as const } }

  const categoryIcon = (row: CategoryRow): IconName | null => {
    const icon = row.createType?.icon ?? ''
    if (!icon) return null
    if (!isIconName(icon)) throw new Error(`category ${row.category.id} requested unknown icon: ${icon}`)
    return icon
  }

  const categoryCollapsed = (categoryId: string): boolean =>
    collapsedCategoryIds[categoryId] === true

  const toggleCategory = (categoryId: string): void => {
    collapsedCategoryIds = { ...collapsedCategoryIds, [categoryId]: !categoryCollapsed(categoryId) }
  }

  const dataFieldsFor = (row: CategoryRow): ReadonlyArray<string> => {
    const fields = new Map<string, string>()
    for (const object of row.objects) {
      for (const field of presentationFor(object).fields) {
        fields.set(field.key, field.label)
      }
    }
    return [...fields.entries()]
      .sort((left, right) => left[1].localeCompare(right[1], undefined, { numeric: true, sensitivity: 'base' }))
      .map(([key]) => key)
  }

  const fieldLabel = (row: CategoryRow, fieldKey: string): string => {
    for (const object of row.objects) {
      const field = presentationFor(object).fields.find(candidate => candidate.key === fieldKey)
      if (field) return field.label
    }
    return fieldKey
  }

  const visibleFieldsFor = (categoryId: string): ReadonlyArray<string> =>
    visibleFieldsByCategory[categoryId] ?? []

  const fieldVisible = (categoryId: string, field: string): boolean =>
    visibleFieldsFor(categoryId).includes(field)

  const toggleField = (categoryId: string, field: string): void => {
    const current = visibleFieldsFor(categoryId)
    const next = current.includes(field)
      ? current.filter(candidate => candidate !== field)
      : [...current, field]
    visibleFieldsByCategory = { ...visibleFieldsByCategory, [categoryId]: next }
  }

  const visibleFieldsForObject = (categoryId: string, object: OperationalObject) => {
    const selected = new Set(visibleFieldsFor(categoryId))
    if (selected.size === 0) return []
    return presentationFor(object).fields.filter(field => selected.has(field.key))
  }

  const handleOutsideFieldMenuClick = (event: MouseEvent): void => {
    if (!openFieldCategoryId) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('.field-menu-wrap')) return
    openFieldCategoryId = null
  }

  onMount(() => {
    window.addEventListener('click', handleOutsideFieldMenuClick, { capture: true })
  })

  onDestroy(() => {
    window.removeEventListener('click', handleOutsideFieldMenuClick, { capture: true })
  })
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
          <span class="category-actions">
            <span class="field-menu-wrap">
              <IconButton
                label="Choose visible {row.category.label.toLowerCase()} data"
                title="Choose visible {row.category.label.toLowerCase()} data"
                icon={Eye}
                size={14}
                variant="bare"
                onClick={() => openFieldCategoryId = openFieldCategoryId === row.category.id ? null : row.category.id}
              />
              {#if openFieldCategoryId === row.category.id}
                {@const fields = dataFieldsFor(row)}
                <div class="field-menu" role="menu">
                  {#if fields.length === 0}
                    <div class="field-menu-empty">No data fields</div>
                  {:else}
                    {#each fields as field (field)}
                      <button class="field-toggle" type="button" on:click|stopPropagation={() => toggleField(row.category.id, field)}>
                        <svelte:component this={fieldVisible(row.category.id, field) ? Eye : EyeOff} size={13} strokeWidth={1.8} />
                        <span>{fieldLabel(row, field)}</span>
                      </button>
                    {/each}
                  {/if}
                </div>
              {/if}
            </span>
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
          </span>
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
          {@const statusPresentation = objectStatus(object)}
          <div
            class:selected={selectedControllerId === object.id}
            class:has-new-info={hasNewInfo(object)}
            class:muted={presentationFor(object).muted === true}
            class="object-row"
          >
            <button class="object-row-main" type="button" on:mouseenter={() => markSeen(object)} on:focus={() => markSeen(object)} on:click={() => selectObject(object)}>
              <span class="object-status">
                <StatusIndicator tone={statusPresentation.tone} label={statusPresentation.label} indicator={statusPresentation.indicator} />
              </span>
              <span>
                <span class="row-title">{object.label}{#if hasNewInfo(object)} <span class="new-info-dot">new</span>{/if}</span>
                {#each visibleFieldsForObject(row.category.id, object) as field (field.key)}
                  <span class="object-meta"><strong>{field.label}:</strong> {field.value}</span>
                {/each}
              </span>
              <span class="row-info" aria-label="Show {object.label} details">
                ?
                <span class="row-tooltip">
                  <strong>{object.label}</strong>
                  {#each presentationFor(object).fields as field}<span>{field.label}: {field.value}</span>{/each}
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
        {/each}
      {/if}
    </section>
  {/each}

  <footer class="system-footer">
    <button class="status-dot-button" type="button" aria-label="Show Leitbild status" title={status} on:click={openStatusModal}>
      <StatusDot tone={systemStatusTone} label={status} />
    </button>
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
