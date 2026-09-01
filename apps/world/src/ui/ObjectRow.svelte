<script lang="ts">
  import { ClipboardList, FileText, Gamepad2, GitBranch, Library, MonitorCog, Settings2, ShieldCheck, X } from 'lucide-svelte'
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../core/packs/protocol.ts'
  import IconButton from './components/IconButton.svelte'
  import StatusIndicator from './components/StatusIndicator.svelte'
  import { processPlantIdForObject, type ProcessPlantArtifactKind } from './process-display/process-display-client.ts'
  import ProcedureRunBadges from './procedures/ProcedureRunBadges.svelte'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from './procedures/procedure-run-selectors.ts'

  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], completed: [] }

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
    readonly detailPresentationFor?: (object: OperationalObject) => PackObjectPresentation
    readonly openProcessDisplay?: (object: OperationalObject) => void
    readonly openProcedureSystem?: (object: OperationalObject) => void
    readonly openProcedureSystemAt?: (object: OperationalObject, summary?: ProcedureRunSummary) => void
    readonly openProcessPlantArtifact?: (object: OperationalObject, artifact: ProcessPlantArtifactKind) => void
    readonly openProcessPlantCatalog?: (object: OperationalObject) => void
    readonly openProcessPlantCredibility?: (object: OperationalObject) => void
    readonly openDroneControl?: (object: OperationalObject) => void
    readonly openDroneProfileEditor?: (object: OperationalObject) => void
    readonly procedureSummaries?: ProcedureRunSummaryGroup
    readonly proceduresVisible: boolean
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
    detailPresentationFor,
    openProcessDisplay,
    openProcedureSystem,
    openProcedureSystemAt,
    openProcessPlantArtifact,
    openProcessPlantCatalog,
    openProcessPlantCredibility,
    openDroneControl,
    openDroneProfileEditor,
    procedureSummaries = emptyProcedureRunSummaries,
    proceduresVisible,
  }: Props = $props()

  let newInfoBadge: HTMLButtonElement | null = $state(null)
  let newInfoTooltipVisible = $state(false)
  let newInfoTooltipPosition = $state({ left: 0, top: 0, width: 250 })
  let detailPresentation: PackObjectPresentation | null = $state(null)
  let detailPresentationKey: string | null = $state(null)

  const newInfoSummary = $derived(
    presentation.fields.length === 0
      ? presentation.summary
      : presentation.fields.map(field => `${field.label}: ${field.value}`).join(' · '),
  )
  const currentPresentationKey = $derived(`${object.id}:${object.revision}`)
  const activeDetailPresentation = $derived(
    detailPresentationKey === currentPresentationKey && detailPresentation !== null
      ? detailPresentation
      : presentation,
  )

  const loadDetailPresentation = (): void => {
    if (detailPresentationKey === currentPresentationKey && detailPresentation !== null) return
    detailPresentation = detailPresentationFor?.(object) ?? presentation
    detailPresentationKey = currentPresentationKey
  }

  const showNewInfoTooltip = (): void => {
    if (!newInfoBadge) return
    const rect = newInfoBadge.getBoundingClientRect()
    const margin = 12
    const desiredWidth = 250
    const width = Math.min(desiredWidth, Math.max(180, window.innerWidth - margin * 2))
    const left = Math.min(rect.left, window.innerWidth - width - margin)
    newInfoTooltipPosition = {
      left: Math.max(margin, left),
      top: rect.bottom + 6,
      width,
    }
    newInfoTooltipVisible = true
  }

  const acknowledgeNewInfo = (): void => {
    if (!hasNewInfo) return
    newInfoTooltipVisible = false
    markSeen(object)
  }

  const processDisplayAvailable = $derived(object.packId === 'process-plant' && openProcessDisplay !== undefined)
  const processSystemIdAvailable = $derived(processPlantIdForObject(object) !== null)
  const procedureSystemAvailable = $derived(
    object.packId === 'process-plant'
      && openProcedureSystem !== undefined
      && processSystemIdAvailable,
  )
  const processArtifactAvailable = $derived(
    object.packId === 'process-plant'
      && openProcessPlantArtifact !== undefined
      && processSystemIdAvailable,
  )
  const processCatalogAvailable = $derived(object.packId === 'process-plant' && openProcessPlantCatalog !== undefined)
  const processCredibilityAvailable = $derived(
    object.packId === 'process-plant'
      && openProcessPlantCredibility !== undefined
      && processSystemIdAvailable,
  )
  const droneControlAvailable = $derived(object.packId === 'drone' && openDroneControl !== undefined)
  const droneProfileEditorAvailable = $derived(object.packId === 'drone' && openDroneProfileEditor !== undefined)
  const openProcedureSummary = (summary: ProcedureRunSummary): void => {
    if (openProcedureSystemAt) {
      openProcedureSystemAt(object, summary)
      return
    }
    openProcedureSystem?.(object)
  }
</script>

<div
  class:selected
  class:has-new-info={hasNewInfo}
  class:muted={presentation.muted === true}
  class="object-row"
  role="button"
  tabindex="0"
  onmouseenter={loadDetailPresentation}
  onfocus={loadDetailPresentation}
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
        <span
          class="row-title-text"
        >
          <span class="row-label">{object.label}</span>
          <span class="row-tooltip">
            <strong>{object.label}</strong>
            {#each activeDetailPresentation.fields as field}<span>{field.label}: {field.value}</span>{/each}
          </span>
        </span>
        {#if hasNewInfo}
          <button
            bind:this={newInfoBadge}
            class="new-info-dot"
            type="button"
            aria-label="Acknowledge new information for {object.label}"
            onmouseenter={showNewInfoTooltip}
            onfocus={showNewInfoTooltip}
            onclick={(event) => {
              event.stopPropagation()
              acknowledgeNewInfo()
            }}
            onmouseleave={acknowledgeNewInfo}
            onblur={acknowledgeNewInfo}
          >
            new
          </button>
        {/if}
        {#if processDisplayAvailable}
          <IconButton
            label="Open process display for {object.label}"
            title="Open process display"
            icon={MonitorCog}
            size={13}
            variant="bare"
            onClick={() => openProcessDisplay?.(object)}
          />
        {/if}
        {#if procedureSystemAvailable}
          <IconButton
            label="Open procedures for {object.label}"
            title="Open procedures"
            icon={ClipboardList}
            size={13}
            variant="bare"
            onClick={() => openProcedureSystem?.(object)}
          />
        {/if}
        {#if processArtifactAvailable}
          {#if processCatalogAvailable}
            <IconButton
              label="Open process plant catalog"
              title="Process plant catalog"
              icon={Library}
              size={13}
              variant="bare"
              onClick={() => openProcessPlantCatalog(object)}
            />
          {/if}
          <IconButton
            label="Open plant specification source for {object.label}"
            title="Plant specification source"
            icon={FileText}
            size={13}
            variant="bare"
            onClick={() => openProcessPlantArtifact?.(object, 'authored-spec')}
          />
          <IconButton
            label="Open full component graph for {object.label}"
            title="Full component graph"
            icon={GitBranch}
            size={13}
            variant="bare"
            onClick={() => openProcessPlantArtifact?.(object, 'compiled-graph-mermaid')}
          />
          {#if processCredibilityAvailable}
            <IconButton
              label="Open credibility evidence for {object.label}"
              title="Credibility evidence"
              icon={ShieldCheck}
              size={13}
              variant="bare"
              onClick={() => openProcessPlantCredibility?.(object)}
            />
          {/if}
        {/if}
        {#if !processArtifactAvailable && processCatalogAvailable}
          <IconButton
            label="Open process plant catalog"
            title="Process plant catalog"
            icon={Library}
            size={13}
            variant="bare"
            onClick={() => openProcessPlantCatalog(object)}
          />
        {/if}
        {#if droneControlAvailable}
          <IconButton
            label="Open drone flight window for {object.label}"
            title="Drone flight window"
            icon={Gamepad2}
            size={13}
            variant="bare"
            onClick={() => openDroneControl?.(object)}
          />
        {/if}
        {#if droneProfileEditorAvailable}
          <IconButton
            label="Open drone profile editor for {object.label}"
            title="Drone profile editor"
            icon={Settings2}
            size={13}
            variant="bare"
            onClick={() => openDroneProfileEditor?.(object)}
          />
        {/if}
      </span>
    </span>
  </div>
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
  {#if proceduresVisible && procedureSystemAvailable}
    <div class="object-row-procedures">
      <span>Procedures</span>
      <ProcedureRunBadges
        summaries={procedureSummaries}
        mode="rail"
        onOpen={openProcedureSummary}
      />
    </div>
  {/if}
</div>

{#if hasNewInfo && newInfoTooltipVisible}
  <div
    class="new-info-tooltip"
    style:left="{newInfoTooltipPosition.left}px"
    style:top="{newInfoTooltipPosition.top}px"
    style:width="{newInfoTooltipPosition.width}px"
  >
    <strong>New information</strong>
    <span>{newInfoSummary}</span>
  </div>
{/if}
