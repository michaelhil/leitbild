<script lang="ts">
  import type { OperationalObject } from '../core/model/index.ts'
  import type { SurfaceObjectRailRegionConfig } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { X } from 'lucide-svelte'
  import CategorySection from './CategorySection.svelte'
  import IconButton from './components/IconButton.svelte'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import type { CategoryRow } from './types.ts'
  import {
    buildPresentedCategoryRows,
    type FieldVisibilityState,
  } from './control-rail-presenter.ts'
  import {
    collapsedCategoryIdsForSurface,
    surfaceConfigKey,
    visibleFieldsForSurface,
  } from './surface.ts'
  import SystemFooter from './SystemFooter.svelte'
  import type { StatusTone } from './components/StatusDot.svelte'
  import type { ThemeMode } from './theme.ts'

  interface Props {
    readonly status: string
    readonly systemStatusTone: StatusTone
    readonly appVersion: string
    readonly theme: ThemeMode
    readonly footerVisible: boolean
    readonly collapsed: boolean
    readonly categoryRows: ReadonlyArray<CategoryRow>
    readonly railConfig: SurfaceObjectRailRegionConfig
    readonly placementMode: PackCreateObjectType | null
    readonly selectedControllerId: string | null
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly markSeen: (object: OperationalObject) => void
    readonly selectObject: (object: OperationalObject) => void
    readonly deleteObject: (object: OperationalObject) => Promise<void>
    readonly beginPlacement: (type: PackCreateObjectType) => void
    readonly cancelPlacement: () => void
    readonly toggleTheme: () => void
    readonly resetScenario: () => Promise<void>
    readonly openStatusModal: () => void
  }

  let {
    status,
    systemStatusTone,
    appVersion,
    theme,
    footerVisible,
    collapsed,
    categoryRows,
    railConfig,
    placementMode,
    selectedControllerId,
    presentationFor,
    hasNewInfo,
    markSeen,
    selectObject,
    deleteObject,
    beginPlacement,
    cancelPlacement,
    toggleTheme,
    resetScenario,
    openStatusModal,
  }: Props = $props()

  let collapsedCategoryIds = $state<Record<string, boolean>>({})
  let openFieldCategoryId = $state<string | null>(null)
  let visibleFieldsByCategory = $state<FieldVisibilityState>({})
  let appliedSurfaceConfigKey = $state('')

  const placementText = (): string => {
    if (!placementMode) return ''
    const placementKind = placementMode.placementKind ?? 'point'
    if (placementKind === 'route') return `Click start and end points for new ${placementMode.label.toLowerCase()}`
    if (placementKind === 'polygon') return `Click area vertices; press Enter to finish`
    return `Click map to place new ${placementMode.label.toLowerCase()}`
  }

  const categoryCollapsed = (categoryId: string): boolean =>
    collapsedCategoryIds[categoryId] === true

  const toggleCategory = (categoryId: string): void => {
    collapsedCategoryIds = { ...collapsedCategoryIds, [categoryId]: !categoryCollapsed(categoryId) }
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

  const handleOutsideFieldMenuClick = (event: MouseEvent): void => {
    if (!openFieldCategoryId) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('.field-menu-wrap')) return
    openFieldCategoryId = null
  }

  runOnMount(() => {
    window.addEventListener('click', handleOutsideFieldMenuClick, { capture: true })
    return () => {
      window.removeEventListener('click', handleOutsideFieldMenuClick, { capture: true })
    }
  })

  $effect(() => {
    const nextKey = surfaceConfigKey(railConfig)
    if (appliedSurfaceConfigKey === nextKey) return
    collapsedCategoryIds = collapsedCategoryIdsForSurface(railConfig)
    visibleFieldsByCategory = visibleFieldsForSurface(railConfig)
    openFieldCategoryId = null
    appliedSurfaceConfigKey = nextKey
  })

  const presentedCategoryRows = $derived(buildPresentedCategoryRows({
    categoryRows,
    collapsedCategoryIds,
    openFieldCategoryId,
    visibleFieldsByCategory,
    presentationFor,
    hasNewInfo,
  }))
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

  {#if footerVisible}
    <SystemFooter
      {status}
      {systemStatusTone}
      {appVersion}
      {theme}
      {toggleTheme}
      {resetScenario}
      {openStatusModal}
    />
  {/if}
</aside>
