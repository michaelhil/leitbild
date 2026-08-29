<script lang="ts">
  import type { OperationalObject, SimulationClockState } from '../core/model/index.ts'
  import type { SurfaceObjectRailRegionConfig } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackMapLayerGroup, PackObjectPresentation } from '../core/packs/protocol.ts'
  import RailLayerGroupSection from './RailLayerGroupSection.svelte'
  import RailSourcePicker from './RailSourcePicker.svelte'
  import { X } from 'lucide-svelte'
  import CategorySection from './CategorySection.svelte'
  import IconButton from './components/IconButton.svelte'
  import type { ProcessPlantArtifactKind } from './process-surface/process-surface-client.ts'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from './procedures/procedure-run-selectors.ts'
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

  const processPlantCategoryId = 'process-plants'
  const proceduresFieldKey = 'procedures'
  const procedureFieldOption = { key: proceduresFieldKey, label: 'Procedures' } as const
  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], completed: [] }

  interface Props {
    readonly status: string
    readonly systemStatusTone: StatusTone
    readonly appVersion: string
    readonly clock?: SimulationClockState
    readonly footerVisible: boolean
    readonly collapsed: boolean
    readonly categoryRows: ReadonlyArray<CategoryRow>
    readonly railConfig: SurfaceObjectRailRegionConfig
    readonly placementMode: PackCreateObjectType | null
    readonly selectedControllerId: string | null
    readonly categoryMapVisibility?: Readonly<Record<string, boolean>>
    readonly deferObjectRows?: boolean
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
    readonly detailPresentationFor?: (object: OperationalObject) => PackObjectPresentation
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly markSeen: (object: OperationalObject) => void
    readonly selectObject: (object: OperationalObject) => void
    readonly deleteObject: (object: OperationalObject) => Promise<void>
    readonly openProcessSurface?: (object: OperationalObject) => void
    readonly openProcedureSystem?: (object: OperationalObject) => void
    readonly openProcedureSystemAt?: (object: OperationalObject, summary?: ProcedureRunSummary) => void
    readonly openProcessPlantArtifact?: (object: OperationalObject, artifact: ProcessPlantArtifactKind) => void
    readonly openProcessPlantCatalog?: (object: OperationalObject) => void
    readonly openProcessPlantCredibility?: (object: OperationalObject) => void
    readonly openDroneControl?: (object: OperationalObject) => void
    readonly openDroneProfileEditor?: (object: OperationalObject) => void
    readonly procedureSummariesForObject?: (object: OperationalObject) => ProcedureRunSummaryGroup
    readonly beginPlacement: (type: PackCreateObjectType) => void
    readonly cancelPlacement: () => void
    readonly openStatusModal: () => void
    readonly openSettings: () => void
    readonly toggleClockPaused: () => Promise<void>
    readonly toggleCategoryMapVisibility?: (categoryId: string) => void
    readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
    readonly mapLayerGroupVisibility?: Readonly<Record<string, boolean>>
    readonly onMapLayerGroupToggle?: (groupId: string) => void
    readonly sourcePicker?: {
      readonly title: string
      readonly sources: ReadonlyArray<{ readonly id: string; readonly label: string; readonly disabled?: boolean; readonly hint?: string }>
      readonly activeId: string | null
      readonly onSelect?: (sourceId: string) => void
    } | null
  }

  let {
    status,
    systemStatusTone,
    appVersion,
    clock,
    footerVisible,
    collapsed,
    categoryRows,
    railConfig,
    placementMode,
    selectedControllerId,
    categoryMapVisibility = {},
    deferObjectRows = false,
    presentationFor,
    detailPresentationFor,
    hasNewInfo,
    markSeen,
    selectObject,
    deleteObject,
    openProcessSurface,
    openProcedureSystem,
    openProcedureSystemAt,
    openProcessPlantArtifact,
    openProcessPlantCatalog,
    openProcessPlantCredibility,
    openDroneControl,
    openDroneProfileEditor,
    procedureSummariesForObject = () => emptyProcedureRunSummaries,
    beginPlacement,
    cancelPlacement,
    openStatusModal,
    openSettings,
    toggleClockPaused,
    toggleCategoryMapVisibility = () => undefined,
    mapLayerGroups = [],
    mapLayerGroupVisibility = {},
    onMapLayerGroupToggle = () => undefined,
    sourcePicker = null,
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
    includeRows: !deferObjectRows,
    presentationFor,
    hasNewInfo,
    additionalFieldOptionsForCategory: row => row.category.id === processPlantCategoryId ? [procedureFieldOption] : [],
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
      categoryMapVisible={categoryMapVisibility[entry.row.category.id] ?? true}
      isFieldVisible={fieldVisible}
      {toggleField}
      toggleFieldMenu={(categoryId) => openFieldCategoryId = openFieldCategoryId === categoryId ? null : categoryId}
      {toggleCategoryMapVisibility}
      {toggleCategory}
      {beginPlacement}
      {markSeen}
      {selectObject}
      {deleteObject}
      {detailPresentationFor}
      {openProcessSurface}
      {openProcedureSystem}
      {openProcedureSystemAt}
      {openProcessPlantArtifact}
      {openProcessPlantCatalog}
      {openProcessPlantCredibility}
      {openDroneControl}
      {openDroneProfileEditor}
      {procedureSummariesForObject}
      proceduresVisible={fieldVisible(entry.row.category.id, proceduresFieldKey)}
    />
  {/each}

  <RailLayerGroupSection
    groups={mapLayerGroups}
    visibility={mapLayerGroupVisibility}
    onToggle={onMapLayerGroupToggle}
  />

  {#if sourcePicker}
    <RailSourcePicker
      title={sourcePicker.title}
      sources={sourcePicker.sources}
      activeId={sourcePicker.activeId}
      onSelect={sourcePicker.onSelect}
    />
  {/if}

  {#if footerVisible}
    <SystemFooter
      {status}
      {systemStatusTone}
      {appVersion}
      {clock}
      {openStatusModal}
      {openSettings}
      {toggleClockPaused}
    />
  {/if}
</aside>
