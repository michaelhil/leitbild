<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation, PackObjectStatusPresentation } from '../core/packs/protocol.ts'
  import { Moon, Sun, X } from 'lucide-svelte'
  import CategorySection, { type PresentedObjectRow } from './CategorySection.svelte'
  import IconButton from './components/IconButton.svelte'
  import StatusDot, { type StatusTone } from './components/StatusDot.svelte'
  import { isIconName, type IconName } from './icons.ts'
  import type { ThemeMode } from './theme.ts'
  import type { CategoryRow } from './types.ts'
  import type { FieldVisibilityOption } from './FieldVisibilityMenu.svelte'

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
  interface PresentedCategoryRow {
    readonly row: CategoryRow
    readonly headerIcon: IconName | null
    readonly collapsed: boolean
    readonly fieldMenuOpen: boolean
    readonly fieldOptions: ReadonlyArray<FieldVisibilityOption>
    readonly presentedRows: ReadonlyArray<PresentedObjectRow>
  }

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

  let presentedCategoryRows: ReadonlyArray<PresentedCategoryRow> = []

  const objectStatus = (object: OperationalObject, presentation: PackObjectPresentation): PackObjectStatusPresentation =>
    presentation.status ?? { tone: 'idle', label: object.operational.status, indicator: { shape: 'dot' } }

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

  const fieldOptionsFor = (presentedRows: ReadonlyArray<PresentedObjectRow>): ReadonlyArray<FieldVisibilityOption> => {
    const fields = new Map<string, string>()
    for (const row of presentedRows) {
      for (const field of row.presentation.fields) fields.set(field.key, field.label)
    }
    return [...fields.entries()]
      .sort((left, right) => left[1].localeCompare(right[1], undefined, { numeric: true, sensitivity: 'base' }))
      .map(([key, label]) => ({ key, label }))
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

  const visibleFieldsForObject = (categoryId: string, presentation: PackObjectPresentation) => {
    const selected = new Set(visibleFieldsFor(categoryId))
    if (selected.size === 0) return []
    return presentation.fields.filter(field => selected.has(field.key))
  }

  const presentedRowsFor = (row: CategoryRow): ReadonlyArray<PresentedObjectRow> =>
    row.objects.map(object => {
      const presentation = presentationFor(object)
      return {
        object,
        presentation,
        status: objectStatus(object, presentation),
        visibleFields: visibleFieldsForObject(row.category.id, presentation),
        hasNewInfo: hasNewInfo(object),
      }
    })

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

  $: presentedCategoryRows = categoryRows.map(row => {
    const presentedRows = presentedRowsFor(row)
    return {
      row,
      headerIcon: categoryIcon(row),
      collapsed: categoryCollapsed(row.category.id),
      fieldMenuOpen: openFieldCategoryId === row.category.id,
      fieldOptions: fieldOptionsFor(presentedRows),
      presentedRows,
    }
  })
</script>

<aside class="control-rail" aria-hidden={collapsed} inert={collapsed}>
  {#if placementMode}
      <div class="placement-banner">
        {placementText()}
      <IconButton label="Cancel placement" icon={X} onClick={cancelPlacement} />
    </div>
  {/if}

  {#each presentedCategoryRows as entry (entry.row.category.id)}
    <CategorySection
      row={entry.row}
      headerIcon={entry.headerIcon}
      collapsed={entry.collapsed}
      fieldMenuOpen={entry.fieldMenuOpen}
      fieldOptions={entry.fieldOptions}
      presentedRows={entry.presentedRows}
      {selectedControllerId}
      isFieldVisible={fieldVisible}
      {toggleField}
      toggleFieldMenu={(categoryId) => openFieldCategoryId = openFieldCategoryId === categoryId ? null : categoryId}
      {toggleCategory}
      {beginPlacement}
      {markSeen}
      {selectObject}
      {deleteObject}
    />
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
