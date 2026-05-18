<script lang="ts">
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackObjectPresentation } from '../core/packs/protocol.ts'
  import { Moon, RotateCcw, Sun, X } from 'lucide-svelte'
  import CategorySection from './CategorySection.svelte'
  import IconButton from './components/IconButton.svelte'
  import StatusDot, { type StatusTone } from './components/StatusDot.svelte'
  import type { ThemeMode } from './theme.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import type { CategoryRow } from './types.ts'
  import {
    buildPresentedCategoryRows,
    type FieldVisibilityState,
  } from './control-rail-presenter.ts'

  interface Props {
    readonly status: string
    readonly systemStatusTone: StatusTone
    readonly appVersion: string
    readonly theme: ThemeMode
    readonly collapsed: boolean
    readonly categoryRows: ReadonlyArray<CategoryRow>
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
    collapsed,
    categoryRows,
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

  <footer class="system-footer">
    <button class="status-dot-button" type="button" aria-label="Show Leitbild status" title={status} onclick={openStatusModal}>
      <StatusDot tone={systemStatusTone} label={status} />
    </button>
    <span class="brand">Leitbild</span>
    <span class="version">v{appVersion}</span>
    <IconButton
      label="Reset scenario"
      title="Reset scenario"
      icon={RotateCcw}
      variant="bare"
      onClick={() => { void resetScenario() }}
    />
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
