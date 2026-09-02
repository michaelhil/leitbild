<script lang="ts">
  import { BookOpen, Bug, Check, ChevronLeft, ChevronRight, ExternalLink, HelpCircle, MessageSquare, Play, RefreshCw, Star, X } from 'lucide-svelte'
  import { tick, untrack } from 'svelte'
  import type { ProcedureSession } from './procedure-session.ts'
  import { procedureViewKey, procedureCategories } from './procedure-view.ts'
  import type {
    SimulationRunId,
    ObjectId,
    ProcedureAssessment,
    ProcedureCatalog,
    ProcedureBranch,
    ProcedureDocument,
    ProcedureId,
    ProcedureRunScope,
    ProcedureRunState,
    ProcedureStep,
    ProcedureStepId,
    ProcedureStepRunState,
    ProcedureTag,
    ProcedureTagId,
  } from '../../core/model/index.ts'
  import type { PackObjectStatusPresentation } from '../../core/packs/protocol.ts'
  import StatusIndicator from '../components/StatusIndicator.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import ProcedureRunBadges from './ProcedureRunBadges.svelte'
  import {
    closeProcedureRun,
    transitionProcedureRun,
    evaluateProcedureCsfs,
    readProcedureTagValue,
    resetProcedureRun,
    startProcedureRun,
    updateProcedureStep,
    validateProcedureTags,
    type ProcedureCsfEvaluation,
    type ProcedureTagValidation,
    type ProcedureTagValue,
  } from './procedure-client.ts'
  import {
    furthestTouchedStep,
    procedureCurrentStep,
    procedureBranchActionText,
    procedureFirstStep,
    procedureRunFor,
    procedureRunSummariesForScope,
    procedureRunVisualStateFor as selectedProcedureRunVisualStateFor,
    procedureStepById,
    procedureStepDisplayName,
    procedureStepHoverLabel,
    type ProcedureRunSummary,
    type ProcedureRunVisualState,
  } from './procedure-run-selectors.ts'
  import {
    floatingWindowBoundsForDrag,
    normalizeFloatingWindowBounds,
    type FloatingWindowBounds,
    type FloatingWindowDragMode,
  } from '../window-bounds.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly unitName?: string
    readonly unitStatus?: PackObjectStatusPresentation
    readonly unitContexts?: ReadonlyArray<ProcedureUnitContext>
    readonly session: ProcedureSession
    readonly initialProcedureId?: ProcedureId
    readonly windowOffsetIndex?: number
    readonly selectUnit: (objectId: ObjectId) => void
    readonly close: () => void
  }

  interface ProcedureUnitContext {
    readonly plantId: string
    readonly targetObjectId?: ObjectId
    readonly label: string
    readonly status?: PackObjectStatusPresentation
  }

  interface TextSegment {
    readonly kind: 'text' | 'tag'
    readonly text: string
  }

  type LoadStageId = 'source' | 'runs' | 'document' | 'tags' | 'csfs'
  type LoadStageStatus = 'pending' | 'running' | 'done' | 'failed'
  type ProcedureTocMode = 'detail' | 'compact' | 'collapsed'
  type ProcedureConfirmation = 'run' | 'completed' | 'reset' | 'transition'

  interface ProcedureWindowDragState {
    readonly pointerId: number
    readonly mode: FloatingWindowDragMode
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: FloatingWindowBounds
  }


  interface LoadStage {
    readonly id: LoadStageId
    readonly label: string
    readonly status: LoadStageStatus
    readonly detail?: string
  }

  interface ProcedureTransition {
    readonly sourceRunId: ProcedureRunState['runId']
    readonly fromProcedure: ProcedureDocument
    readonly fromStep: ProcedureStep
    readonly branch: ProcedureBranch
    readonly targetProcedure: ProcedureDocument
    readonly targetStep: ProcedureStep
  }

  interface ProcedureToast {
    readonly message: string
    readonly placement: 'corner' | 'center'
    readonly tone: 'notice' | 'success' | 'transition'
    readonly durationMs: number
  }

  let {
    simulationRunId,
    plantId,
    unitName = undefined,
    unitStatus = undefined,
    unitContexts = [],
    session,
    initialProcedureId = undefined,
    windowOffsetIndex = 0,
    selectUnit,
    close,
  }: Props = $props()

  const minWindowWidth = 48
  const minWindowHeight = 32
  const viewportMargin = 12
  const windowOffsetStepPx = 32
  const minProcedureFontScale = 0.65
  const maxProcedureFontScale = 1.6
  const procedureFontScaleStep = 0.1

  let loading = $state(true)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let catalog = $state<ProcedureCatalog | null>(null)
  let document = $state<ProcedureDocument | null>(null)
  let runs = $state<ReadonlyArray<ProcedureRunState>>([])
  let runDocuments = $state<ReadonlyMap<string, ProcedureDocument>>(new Map())
  let selectedProcedureId = $state<string | null>(null)
  let loadingProcedureId = $state<string | null>(null)
  let confirmation = $state<ProcedureConfirmation | null>(null)
  let tagValidation = $state<ReadonlyMap<string, ProcedureTagValidation>>(new Map())
  let csfEvaluations = $state<ReadonlyMap<string, ProcedureCsfEvaluation>>(new Map())
  let csfError = $state<string | null>(null)
  let hoveredTagId = $state<ProcedureTagId | null>(null)
  let hoveredTagValue = $state<ProcedureTagValue | null>(null)
  let hoveredTagError = $state<string | null>(null)
  let commentOpen = $state<Record<string, boolean>>({})
  let commentDrafts = $state<Record<string, string>>({})
  let pendingTransition = $state<ProcedureTransition | null>(null)
  let procedureToast = $state<ProcedureToast | null>(null)
  let loadStages = $state<Record<LoadStageId, LoadStage>>(createLoadStages())
  let procedureTocMode = $state<ProcedureTocMode>('detail')
  let procedureFontScale = $state(1)
  let windowBounds = $state<FloatingWindowBounds>({ x: 48, y: 48, width: 1500, height: 940 })
  let windowDragState = $state<ProcedureWindowDragState | null>(null)
  let transitionInProgress = $state(false)
  let boundsInitialized = false
  let csfRefreshInFlight = false
  let toastTimer: number | null = null
  let latestProcedureLoadRequest = 0
  let disposed = false
  let releasePrefetch: (() => void) | null = null
  let scrollFrame: number | null = null
  let tagRequest = 0
  let catalogRequest = 0
  let procedureDocumentBodyElement: HTMLDivElement | null = null
  const procedureScrollPositions = new Map<string, number>()

  const currentUnitContext = $derived(unitContexts.find(unit => unit.plantId === plantId) ?? {
    plantId: plantId,
    label: unitName ?? plantId,
    ...(unitStatus === undefined ? {} : { status: unitStatus }),
  } satisfies ProcedureUnitContext)
  const currentScope = $derived(procedureScopeFor(currentUnitContext))
  const procedureUnits = $derived(unitContexts.length > 0 ? unitContexts : [currentUnitContext])
  const selectedProcedureRun = $derived(document ? procedureRunFor(runs, {
    sourceId: document.source.sourceId,
    procedureId: document.procedureId,
    scope: currentScope,
  }) : null)
  const activeRun = $derived(selectedProcedureRun?.status === 'active' ? selectedProcedureRun : null)
  const completedRun = $derived(selectedProcedureRun?.status === 'completed' ? selectedProcedureRun : null)
  const selectedRun = $derived(activeRun)
  const procedureLoadPanelVisible = $derived(loading || (error !== null && (catalog === null || document === null)))
  const stepStates = $derived(new Map((selectedProcedureRun?.stepStates ?? []).map(state => [state.stepId, state])))
  const currentProcedureStep = $derived(document && selectedProcedureRun
    ? procedureCurrentStep(selectedProcedureRun, document)
    : null)
  const catalogCategories = $derived(procedureCategories(catalog?.procedures ?? []))
  const sourceLabel = $derived(catalog
    ? `${catalog.source.repository}@${catalog.source.revision.slice(0, 8)}`
    : 'Procedure source')
  const displayUnitName = $derived(currentUnitContext.label)
  const displayUnitStatus = $derived(currentUnitContext.status ?? unitStatus ?? {
    tone: 'idle',
    label: 'Unit status unavailable',
    indicator: { shape: 'dot' },
  } satisfies PackObjectStatusPresentation)
  const currentUnitProcedureSummaries = $derived(procedureRunSummariesForScope(runs, currentScope, runDocuments))
  const csfIds = $derived([...new Set(catalog?.procedures.flatMap(item => item.csfsMonitored) ?? [])])
  const primaryBlockKinds = new Set(['check', 'action', 'when', 'until', 'within', 'concurrent'])

  const procedureRunVisualStateFor = (procedureId: string): ProcedureRunVisualState => {
    return selectedProcedureRunVisualStateFor(runs, {
      ...(catalog ? { sourceId: catalog.source.sourceId } : {}),
      procedureId: procedureId as ProcedureId,
      scope: currentScope,
    })
  }

  const cycleProcedureTocMode = (): void => {
    if (procedureTocMode === 'detail') {
      procedureTocMode = 'compact'
      return
    }
    if (procedureTocMode === 'compact') {
      procedureTocMode = 'collapsed'
      return
    }
    procedureTocMode = 'detail'
  }

  const defaultWindowBounds = (): FloatingWindowBounds => {
    if (typeof window === 'undefined') return windowBounds
    const width = Math.max(minWindowWidth, Math.min(1500, window.innerWidth - 2 * viewportMargin))
    const height = Math.max(minWindowHeight, Math.min(940, window.innerHeight - 2 * viewportMargin))
    const offset = windowOffsetIndex * windowOffsetStepPx
    return {
      x: Math.max(viewportMargin, Math.round((window.innerWidth - width) / 2) + offset),
      y: Math.max(viewportMargin, Math.round((window.innerHeight - height) / 2) + offset),
      width,
      height,
    }
  }

  const clampWindowBounds = (bounds: FloatingWindowBounds): FloatingWindowBounds => {
    if (typeof window === 'undefined') return bounds
    return normalizeFloatingWindowBounds(bounds, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, {
      minWidth: minWindowWidth,
      minHeight: minWindowHeight,
      margin: viewportMargin,
    })
  }

  const nextBoundsForDrag = (
    drag: ProcedureWindowDragState,
    event: PointerEvent,
  ): FloatingWindowBounds => {
    if (typeof window === 'undefined') return drag.origin
    return floatingWindowBoundsForDrag({
      mode: drag.mode,
      origin: drag.origin,
      dx: event.clientX - drag.pointerStart.x,
      dy: event.clientY - drag.pointerStart.y,
    }, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, {
      minWidth: minWindowWidth,
      minHeight: minWindowHeight,
      margin: viewportMargin,
    })
  }

  const startWindowDrag = (event: PointerEvent, mode: FloatingWindowDragMode): void => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('button, a, textarea, input, .procedure-csf-shell, .procedure-run-badges')) return
    event.preventDefault()
    const element = event.currentTarget as Element
    element.setPointerCapture(event.pointerId)
    windowDragState = {
      pointerId: event.pointerId,
      mode,
      pointerStart: { x: event.clientX, y: event.clientY },
      origin: windowBounds,
    }
  }

  const updateWindowDrag = (event: PointerEvent): void => {
    const drag = windowDragState
    if (!drag || drag.pointerId !== event.pointerId) return
    windowBounds = nextBoundsForDrag(drag, event)
  }

  const finishWindowDrag = (event: PointerEvent): void => {
    const drag = windowDragState
    if (!drag || drag.pointerId !== event.pointerId) return
    windowBounds = nextBoundsForDrag(drag, event)
    windowDragState = null
  }

  const increaseProcedureFontSize = (): void => {
    procedureFontScale = Math.min(maxProcedureFontScale, Math.round((procedureFontScale + procedureFontScaleStep) * 10) / 10)
  }

  const decreaseProcedureFontSize = (): void => {
    procedureFontScale = Math.max(minProcedureFontScale, Math.round((procedureFontScale - procedureFontScaleStep) * 10) / 10)
  }

  const procedureTocModeLabel = (): string => {
    if (procedureTocMode === 'detail') return 'Show compact procedure list'
    if (procedureTocMode === 'compact') return 'Collapse procedure list'
    return 'Open procedure list'
  }

  function createLoadStages(): Record<LoadStageId, LoadStage> {
    return {
      source: { id: 'source', label: 'Discover procedure catalog', status: 'pending' },
      runs: { id: 'runs', label: 'Read active runs', status: 'pending' },
      document: { id: 'document', label: 'Load selected procedure', status: 'pending' },
      tags: { id: 'tags', label: 'Resolve plant tags', status: 'pending' },
      csfs: { id: 'csfs', label: 'Evaluate critical safety functions', status: 'pending' },
    }
  }

  function procedureScopeFor(unit: ProcedureUnitContext): ProcedureRunScope {
    return { plantId: unit.plantId,
      ...(unit.targetObjectId === undefined ? {} : { targetObjectId: unit.targetObjectId }), label: unit.label }
  }

  const documentRequest = (procedureId: string, sourceConfig: {
    readonly sourceId?: string; readonly sourceRevision?: string; readonly sourcePath?: string
  } = {}) => {
    const sourceId = sourceConfig.sourceId ?? catalog?.source.sourceId
    const sourceRevision = sourceConfig.sourceRevision ?? catalog?.source.revision
    if (!sourceId || !sourceRevision) throw new Error('procedure catalog is not loaded')
    const sourcePath = sourceConfig.sourcePath ?? (sourceRevision === catalog?.source.revision
      ? catalog.procedures.find(item => item.procedureId === procedureId)?.sourcePath : undefined)
    return { sourceId, sourceRevision, procedureId, ...(sourcePath === undefined ? {} : { sourcePath }) }
  }

  const readDocumentFor = (procedureId: string, sourceConfig: {
    readonly sourceId?: string; readonly sourceRevision?: string; readonly sourcePath?: string
  } = {}) => session.readDocument(documentRequest(procedureId, sourceConfig))

  const unitProcedureSummariesFor = (unit: ProcedureUnitContext): {
    readonly active: ReadonlyArray<ProcedureRunSummary>
    readonly completed: ReadonlyArray<ProcedureRunSummary>
  } =>
    procedureRunSummariesForScope(runs, procedureScopeFor(unit), runDocuments)

  const statusForUnit = (unit: ProcedureUnitContext): PackObjectStatusPresentation =>
    unit.status ?? (unit.plantId === plantId ? displayUnitStatus : {
      tone: 'idle',
      label: 'Unit status unavailable',
      indicator: { shape: 'dot' },
    })

  const setLoadStage = (id: LoadStageId, status: LoadStageStatus, detail?: string): void => {
    loadStages = {
      ...loadStages,
      [id]: {
        ...loadStages[id],
        status,
        ...(detail === undefined ? {} : { detail }),
      },
    }
  }

  const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err)

  const procedureLoadRows = $derived<ReadonlyArray<LoadStage>>([
    loadStages.source,
    loadStages.runs,
    loadStages.document,
    loadStages.tags,
    loadStages.csfs,
  ])

  const assessmentClass = (state: ProcedureStepRunState | undefined): string =>
    state?.assessment ?? 'blank'

  const loadCatalogAndRuns = async (refresh = false): Promise<void> => {
    const request = ++catalogRequest
    try {
      releasePrefetch?.()
      releasePrefetch = null
      loading = document === null
      refreshing = refresh
      error = null
      loadStages = createLoadStages()
      setLoadStage('source', 'running', refresh ? 'Refreshing manifest' : 'Reading manifest')
      setLoadStage('runs', 'running')
      const [nextCatalog] = await Promise.all([session.readCatalog(refresh), session.refreshRuns()])
      if (disposed || request !== catalogRequest) return
      catalog = nextCatalog
      setLoadStage('source', 'done', `${nextCatalog.procedures.length} procedures available`)
      setLoadStage('runs', 'done', `${runs.length} tracked runs`)
      selectedProcedureId = selectedProcedureId ?? initialProcedureId ?? nextCatalog.procedures[0]?.procedureId ?? null
      if (selectedProcedureId) await loadProcedure(selectedProcedureId, !loading)
      if (disposed || request !== catalogRequest) return
    } catch (err) {
      if (disposed || request !== catalogRequest) return
      error = errorMessage(err)
      const activeStage = procedureLoadRows.find(stage => stage.status === 'running')
      if (activeStage) setLoadStage(activeStage.id, 'failed', error)
    } finally {
      if (!disposed && request === catalogRequest) {
        loading = false
        refreshing = false
      }
    }
  }

  const refreshRuns = async (): Promise<void> => {
    try { await session.refreshRuns() }
    catch (err) { if (!disposed) error = errorMessage(err) }
  }

  const loadProcedure = async (
    procedureId: string,
    showSelectionLoading = true,
    sourceConfig: {
      readonly sourceId?: string
      readonly sourceRevision?: string
      readonly sourcePath?: string
      readonly rememberCurrentPosition?: boolean
    } = {},
  ): Promise<void> => {
    const requestId = ++latestProcedureLoadRequest
    const targetUnit = currentUnitContext
    const targetScope = procedureScopeFor(targetUnit)
    try {
      if (sourceConfig.rememberCurrentPosition !== false) rememberCurrentProcedureScroll()
      error = null
      confirmation = null
      pendingTransition = null
      hideTag()
      tagValidation = new Map()
      csfEvaluations = new Map()
      csfError = null
      selectedProcedureId = procedureId
      setLoadStage('document', 'running', procedureId)
      const sourceId = sourceConfig.sourceId ?? catalog?.source.sourceId
      const currentRun = procedureRunFor(runs, {
        ...(sourceId === undefined ? {} : { sourceId }),
        procedureId: procedureId as ProcedureId,
        scope: targetScope,
      })
      const sourceRevision = sourceConfig.sourceRevision ?? currentRun?.sourceRevision
      const sourcePath = sourceConfig.sourcePath ?? currentRun?.sourcePath
      const resolvedSourceConfig = {
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(sourceRevision === undefined ? {} : { sourceRevision }),
        ...(sourcePath === undefined ? {} : { sourcePath }),
      }
      if (showSelectionLoading && !session.cachedDocument(documentRequest(procedureId, resolvedSourceConfig))) {
        loadingProcedureId = procedureId
      }
      const nextDocument = await readDocumentFor(procedureId as ProcedureId, resolvedSourceConfig)
      if (disposed || requestId !== latestProcedureLoadRequest) return
      document = nextDocument
      loading = false
      if (catalog && !releasePrefetch) releasePrefetch = session.retainPrefetch(catalog)
      loadingProcedureId = null
      setLoadStage('document', 'done', `${nextDocument.steps.length} steps`)
      await restoreProcedurePosition(nextDocument, targetScope, requestId)
      if (disposed || requestId !== latestProcedureLoadRequest) return
      const loadTagValidation = async (): Promise<ReadonlyMap<string, ProcedureTagValidation>> => {
        try {
          setLoadStage('tags', 'running', `${nextDocument.tags.length} tags`)
          const nextTagValidation = await validateProcedureTags(simulationRunId, targetUnit.plantId, nextDocument.tags)
          const missingCount = [...nextTagValidation.values()].filter(validation => validation.status === 'missing').length
          if (!disposed && requestId === latestProcedureLoadRequest) setLoadStage('tags', 'done', missingCount === 0
            ? `${nextDocument.tags.length} tags resolved`
            : `${nextDocument.tags.length - missingCount}/${nextDocument.tags.length} tags resolved`)
          return nextTagValidation
        } catch (err) {
          if (!disposed && requestId === latestProcedureLoadRequest) setLoadStage('tags', 'failed', errorMessage(err))
          throw err
        }
      }
      const loadCsfEvaluations = async (): Promise<ReadonlyMap<string, ProcedureCsfEvaluation>> => {
        try {
          setLoadStage('csfs', 'running', `${csfIds.length} functions`)
          const nextCsfEvaluations = csfIds.length > 0
            ? await evaluateProcedureCsfs(simulationRunId, targetUnit.plantId, csfIds)
            : new Map<string, ProcedureCsfEvaluation>()
          if (!disposed && requestId === latestProcedureLoadRequest) setLoadStage('csfs', 'done', `${nextCsfEvaluations.size} functions evaluated`)
          return nextCsfEvaluations
        } catch (err) {
          if (!disposed && requestId === latestProcedureLoadRequest) setLoadStage('csfs', 'failed', errorMessage(err))
          throw err
        }
      }
      const [nextTagValidation, nextCsfEvaluations] = await Promise.all([
        loadTagValidation(),
        loadCsfEvaluations(),
      ])
      if (disposed || requestId !== latestProcedureLoadRequest) return
      tagValidation = nextTagValidation
      csfEvaluations = nextCsfEvaluations
    } catch (err) {
      if (disposed || requestId !== latestProcedureLoadRequest) return
      error = errorMessage(err)
      selectedProcedureId = document?.procedureId ?? null
    } finally {
      if (!disposed && requestId === latestProcedureLoadRequest) loadingProcedureId = null
    }
  }

  const startSelectedProcedure = async (): Promise<void> => {
    const current = document
    const request = latestProcedureLoadRequest
    if (!current) return
    try {
      await startProcedureRun(simulationRunId, {
        sourceId: current.source.sourceId,
        sourceRevision: current.source.revision,
        procedureId: current.procedureId,
        scope: currentScope,
      })
      await refreshRuns()
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    }
  }

  const closeActiveRun = async (status: 'completed' | 'abandoned'): Promise<boolean> => {
    const request = latestProcedureLoadRequest
    if (!activeRun) return false
    try {
      await closeProcedureRun(simulationRunId, { runId: activeRun.runId, status })
      await refreshRuns()
      return !disposed && request === latestProcedureLoadRequest
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
      return false
    }
  }

  const draftKey = (stepId: string): string => `${document ? procedureViewKey(document, currentScope) : ''}:${stepId}`

  const rememberCurrentProcedureScroll = (): void => {
    if (!document || !procedureDocumentBodyElement) return
    procedureScrollPositions.set(
      procedureViewKey(document, currentScope),
      procedureDocumentBodyElement.scrollTop,
    )
  }

  const scrollToProcedureStep = (
    stepId: string,
    behavior: ScrollBehavior = 'smooth',
  ): void => {
    const request = latestProcedureLoadRequest
    if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
    scrollFrame = window.requestAnimationFrame(() => {
      if (disposed || request !== latestProcedureLoadRequest) return
      const stepElement = [...(procedureDocumentBodyElement?.querySelectorAll<HTMLElement>('[data-procedure-step-id]') ?? [])]
        .find(element => element.dataset.procedureStepId === stepId)
      stepElement?.scrollIntoView({
        block: 'start',
        behavior,
      })
    })
  }

  const restoreProcedurePosition = async (
    nextDocument: ProcedureDocument,
    scope: ProcedureRunScope,
    requestId = latestProcedureLoadRequest,
  ): Promise<void> => {
    await tick()
    if (disposed || requestId !== latestProcedureLoadRequest || !procedureDocumentBodyElement) return
    const run = procedureRunFor(runs, {
      sourceId: nextDocument.source.sourceId,
      procedureId: nextDocument.procedureId,
      scope,
    })
    const sharedStep = run ? procedureCurrentStep(run, nextDocument) : null
    if (sharedStep) {
      scrollToProcedureStep(sharedStep.step.id, 'auto')
      return
    }
    procedureDocumentBodyElement.scrollTop = procedureScrollPositions.get(
      procedureViewKey(nextDocument, scope),
    ) ?? 0
  }

  const openProcedureRunSummary = async (summary: ProcedureRunSummary, unit: ProcedureUnitContext): Promise<void> => {
    const request = ++latestProcedureLoadRequest
    confirmation = null
    pendingTransition = null
    try {
      rememberCurrentProcedureScroll()
      if (unit.targetObjectId === undefined) throw new Error('procedure unit requires a target object')
      selectUnit(unit.targetObjectId)
      await tick()
      if (disposed || request !== latestProcedureLoadRequest) return
      await loadProcedure(summary.procedureId, true, {
        sourceId: summary.run.sourceId,
        sourceRevision: summary.run.sourceRevision,
        sourcePath: summary.run.sourcePath,
        rememberCurrentPosition: false,
      })
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    }
  }

  const targetDocumentForBranch = (branch: ProcedureBranch): ProcedureDocument | undefined =>
    branch.targetKind === 'procedure' && document
      ? session.cachedDocument({ sourceId: document.source.sourceId, sourceRevision: document.source.revision, procedureId: branch.target })
      : undefined

  const branchActionTextFor = (branch: ProcedureBranch): string => {
    if (!document) return branch.target
    const targetDocument = targetDocumentForBranch(branch)
    return procedureBranchActionText({ currentDocument: document, branch,
      ...(targetDocument === undefined ? {} : { targetDocument }) })
  }

  const showProcedureToast = (
    message: string,
    config: {
      readonly placement?: ProcedureToast['placement']
      readonly tone?: ProcedureToast['tone']
      readonly durationMs?: number
    } = {},
  ): void => {
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    procedureToast = {
      message,
      placement: config.placement ?? 'corner',
      tone: config.tone ?? 'notice',
      durationMs: config.durationMs ?? 10_000,
    }
    toastTimer = window.setTimeout(() => {
      procedureToast = null
      toastTimer = null
    }, procedureToast.durationMs)
  }

  const cancelConfirmation = (): void => {
    confirmation = null
    pendingTransition = null
  }

  const completeStepAndJump = async (fromStep: ProcedureStep, branch: ProcedureBranch): Promise<void> => {
    if (!selectedRun || !document || branch.targetKind !== 'step') return
    const targetStep = procedureStepById(document, branch.target)
    if (!targetStep) {
      error = `Procedure branch target step not found: ${branch.target}`
      return
    }
    const updated = await updateStep(fromStep, { assessment: 'complete', currentStepId: targetStep.id })
    if (!updated) {
      return
    }
    scrollToProcedureStep(targetStep.id)
  }

  const openProcedureTransition = async (fromStep: ProcedureStep, branch: ProcedureBranch): Promise<void> => {
    if (!selectedRun || !document || branch.targetKind !== 'procedure') return
    const sourceRunId = selectedRun.runId
    const request = latestProcedureLoadRequest
    try {
      const targetProcedure = await readDocumentFor(branch.target as ProcedureId, {
        sourceId: document.source.sourceId,
        sourceRevision: document.source.revision,
      })
      if (disposed || request !== latestProcedureLoadRequest) return
      const targetStep = procedureFirstStep(targetProcedure)
      if (!targetStep) {
        error = `Procedure ${targetProcedure.procedureId} has no steps to enter.`
        return
      }
      pendingTransition = {
        sourceRunId,
        fromProcedure: document,
        fromStep,
        branch,
        targetProcedure,
        targetStep,
      }
      confirmation = 'transition'
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    }
  }

  const activateBranch = async (fromStep: ProcedureStep, branch: ProcedureBranch): Promise<void> => {
    if (branch.targetKind === 'step') {
      await completeStepAndJump(fromStep, branch)
      return
    }
    if (branch.targetKind === 'procedure') {
      await openProcedureTransition(fromStep, branch)
    }
  }

  const transitionFromLabel = (transition: ProcedureTransition): string =>
    `${transition.fromProcedure.procedureId} (${transition.fromProcedure.title}) step ${transition.fromStep.label} (${procedureStepDisplayName(transition.fromStep)})`

  const transitionToLabel = (transition: ProcedureTransition): string =>
    `${transition.targetProcedure.procedureId} (${transition.targetProcedure.title}), step ${transition.targetStep.label} (${procedureStepDisplayName(transition.targetStep)})`

  const confirmProcedureTransition = async (): Promise<void> => {
    const transition = pendingTransition
    const request = latestProcedureLoadRequest
    if (!transition || transitionInProgress) return
    try {
      transitionInProgress = true
      await transitionProcedureRun(simulationRunId, {
        runId: transition.sourceRunId,
        stepId: transition.fromStep.id,
        branchIndex: transition.fromStep.branches.indexOf(transition.branch),
      })
      await refreshRuns()
      if (disposed || request !== latestProcedureLoadRequest) return
      await loadProcedure(transition.targetProcedure.procedureId, true, {
        sourceId: transition.targetProcedure.source.sourceId,
        sourceRevision: transition.targetProcedure.source.revision,
        sourcePath: transition.targetProcedure.sourcePath,
      })
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    } finally {
      if (!disposed) transitionInProgress = false
      if (request === latestProcedureLoadRequest) pendingTransition = null
    }
  }

  const completeActiveProcedure = async (): Promise<void> => {
    const current = document
    if (!activeRun || !current) return
    const unitLabel = displayUnitName
    if (!await closeActiveRun('completed')) return
    showProcedureToast(`${current.procedureId} completed for ${unitLabel}. Reset the procedure to run it again.`, {
      placement: 'center',
      tone: 'success',
      durationMs: 4_000,
    })
  }

  const resetSelectedProcedure = async (): Promise<void> => {
    const current = document
    const request = latestProcedureLoadRequest
    if (!current) return
    try {
      await resetProcedureRun(simulationRunId, {
        sourceId: current.source.sourceId,
        procedureId: current.procedureId,
        scope: currentScope,
      })
      await refreshRuns()
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    }
  }

  const confirmProcedureAction = async (): Promise<void> => {
    const action = confirmation
    confirmation = null
    if (action === 'run') {
      await startSelectedProcedure()
      return
    }
    if (action === 'completed') {
      await completeActiveProcedure()
      return
    }
    if (action === 'reset') {
      await resetSelectedProcedure()
      return
    }
    if (action === 'transition') {
      await confirmProcedureTransition()
    }
  }

  const confirmationTitle = (): string => {
    if (!document || !confirmation) return ''
    if (confirmation === 'transition') return 'Confirm procedure transition'
    if (confirmation === 'run') return `Run ${document.procedureId} on ${displayUnitName}?`
    if (confirmation === 'completed') return `Complete ${document.procedureId} on ${displayUnitName}?`
    return `Reset ${document.procedureId} on ${displayUnitName}?`
  }

  const confirmationBody = (): string => {
    if (!document || !confirmation) return ''
    if (confirmation === 'transition') return ''
    const currentStep = selectedProcedureRun
      ? procedureCurrentStep(selectedProcedureRun, document)?.progress ?? furthestTouchedStep(selectedProcedureRun, document)
      : null
    if (confirmation === 'run') {
      return `Confirm that you want to run ${document.procedureId} - ${document.title} on ${displayUnitName}.`
    }
    if (confirmation === 'completed') {
      return `Confirm that ${document.procedureId} on ${displayUnitName} should be marked completed on step ${currentStep?.label ?? '-'}.`
    }
    return `Reset clears the current run state, step assessments, comments, and favorites for ${document.procedureId} on ${displayUnitName}.`
  }

  const assessmentAfter = (assessment: ProcedureAssessment | undefined): ProcedureAssessment => {
    if (!assessment || assessment === 'blank') return 'complete'
    if (assessment === 'complete') return 'failed'
    if (assessment === 'failed') return 'unknown'
    return 'blank'
  }

  const updateStep = async (
    step: ProcedureStep,
    update: {
      readonly assessment?: ProcedureAssessment
      readonly comment?: string
      readonly favorite?: boolean
      readonly currentStepId?: ProcedureStepId
    },
  ): Promise<boolean> => {
    if (!selectedRun) return false
    const request = latestProcedureLoadRequest
    try {
      await updateProcedureStep(simulationRunId, {
        runId: selectedRun.runId,
        stepId: step.id,
        ...update,
      })
      await refreshRuns()
      return !disposed && request === latestProcedureLoadRequest
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
      return false
    }
  }

  const cycleStepAssessment = async (step: ProcedureStep): Promise<void> => {
    const current = stepStates.get(step.id)
    await updateStep(step, { assessment: assessmentAfter(current?.assessment), currentStepId: step.id })
  }

  const toggleFavorite = async (step: ProcedureStep): Promise<void> => {
    const current = stepStates.get(step.id)
    await updateStep(step, { favorite: !(current?.favorite ?? false) })
  }

  const saveComment = async (step: ProcedureStep): Promise<void> => {
    await updateStep(step, { comment: commentDrafts[draftKey(step.id)] ?? '' })
  }

  const tagFor = (tagId: ProcedureTagId): ProcedureTag | undefined =>
    document?.tags.find(tag => tag.id === tagId)

  const validationFor = (tagId: ProcedureTagId): ProcedureTagValidation | undefined =>
    tagValidation.get(tagId)

  const csfEvaluationFor = (csf: string): ProcedureCsfEvaluation | undefined =>
    csfEvaluations.get(csf)

  const csfSignalTone = (signal: ProcedureCsfEvaluation['signals'][number]): 'satisfied' | 'challenged' | 'unknown' => {
    if (signal.matches === true) return 'satisfied'
    if (signal.matches === false) return 'challenged'
    return 'unknown'
  }

  const csfSignalValueText = (signal: ProcedureCsfEvaluation['signals'][number]): string =>
    signal.operator === undefined
      ? signal.formatted
      : `${signal.formatted} ${signal.operator} ${String(signal.expected)}`

  const refreshCsfStatus = async (csfs = csfIds): Promise<void> => {
    if (csfs.length === 0 || csfRefreshInFlight || disposed) return
    const request = latestProcedureLoadRequest
    const unit = currentUnitContext.plantId
    try {
      csfRefreshInFlight = true
      csfError = null
      const result = await evaluateProcedureCsfs(simulationRunId, unit, csfs)
      if (!disposed && request === latestProcedureLoadRequest && unit === currentUnitContext.plantId) csfEvaluations = result
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest && unit === currentUnitContext.plantId) csfError = errorMessage(err)
    } finally {
      csfRefreshInFlight = false
    }
  }

  const showTag = async (tagId: ProcedureTagId): Promise<void> => {
    const request = ++tagRequest
    const view = latestProcedureLoadRequest
    hoveredTagId = tagId
    hoveredTagValue = null
    hoveredTagError = null
    if (validationFor(tagId)?.status === 'missing') return
    const tag = tagFor(tagId)
    if (!tag) {
      hoveredTagError = 'Procedure tag metadata not found.'
      return
    }
    try {
      const value = await readProcedureTagValue(simulationRunId, currentUnitContext.plantId, tag)
      if (!disposed && request === tagRequest && view === latestProcedureLoadRequest) hoveredTagValue = value
    } catch (err) {
      if (!disposed && request === tagRequest && view === latestProcedureLoadRequest) hoveredTagError = errorMessage(err)
    }
  }

  const hideTag = (): void => {
    tagRequest++
    hoveredTagId = null
    hoveredTagValue = null
    hoveredTagError = null
  }

  const openIssue = (step: ProcedureStep): void => {
    if (!document) return
    const body = [
      `Procedure: ${document.procedureId} - ${document.title}`,
      `Step: ${step.label} (${step.id})`,
      `Source: ${document.sourceUrl}`,
      `Source revision: ${document.source.revision}`,
      `Leitbild simulation run: ${simulationRunId}`,
      '',
      'Describe the procedure text or procedure-system problem here:',
    ].join('\n')
    const params = new URLSearchParams({
      title: `[${document.procedureId}] ${step.id}`,
      body,
      labels: 'procedure,leitbild',
    })
    window.open(`https://github.com/${document.source.repository}/issues/new?${params.toString()}`, '_blank', 'noopener,noreferrer')
  }

  const textSegments = (text: string): ReadonlyArray<TextSegment> => {
    const segments: TextSegment[] = []
    let cursor = 0
    for (const match of text.matchAll(/«([^»]+)»/g)) {
      const start = match.index ?? 0
      if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) })
      segments.push({ kind: 'tag', text: match[1] ?? '' })
      cursor = start + match[0].length
    }
    if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
    return segments
  }

  runOnMount(() => {
    if (!boundsInitialized) {
      windowBounds = clampWindowBounds(defaultWindowBounds())
      boundsInitialized = true
    }
    const unsubscribe = session.subscribe(state => { runs = state.runs; runDocuments = state.documents })
    void loadCatalogAndRuns()
    const interval = window.setInterval(() => {
      void refreshCsfStatus()
    }, 2_000)
    const handleResize = (): void => {
      windowBounds = clampWindowBounds(windowBounds)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      disposed = true
      latestProcedureLoadRequest++
      catalogRequest++
      tagRequest++
      releasePrefetch?.()
      unsubscribe()
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
      window.clearInterval(interval)
      window.removeEventListener('resize', handleResize)
      if (toastTimer !== null) window.clearTimeout(toastTimer)
    }
  })

  // Another operator may start this procedure at a different pinned revision.
  // Synchronize its document only when identity changes, never on each checkmark.
  $effect(() => {
    const run = selectedProcedureRun
    const current = document
    if (!run || !current || selectedProcedureId !== current.procedureId) return
    if (run.sourceRevision === current.source.revision && run.sourcePath === current.sourcePath) return
    untrack(() => { void loadProcedure(run.procedureId, true, run) })
  })

</script>

<div class="procedure-window-layer">
  <div
    class="procedure-modal procedure-window"
    role="dialog"
    aria-modal="true"
    aria-label="Computer-based procedure system"
    tabindex="-1"
    style={`left: ${windowBounds.x}px; top: ${windowBounds.y}px; width: ${windowBounds.width}px; height: ${windowBounds.height}px; --procedure-font-scale: ${procedureFontScale};`}
    onmousedown={(event) => event.stopPropagation()}
  >
    <header class="procedure-header">
      <div
        class="procedure-header-top"
        role="toolbar"
        tabindex="0"
        aria-label="Procedure system window controls"
        onpointerdown={(event) => startWindowDrag(event, 'move')}
        onpointermove={updateWindowDrag}
        onpointerup={finishWindowDrag}
        onpointercancel={finishWindowDrag}
      >
        <div class="procedure-current-unit-line">
          <StatusIndicator tone={displayUnitStatus.tone} label={displayUnitStatus.label} indicator={displayUnitStatus.indicator} />
          <strong>{displayUnitName}</strong>
          <ProcedureRunBadges
            summaries={currentUnitProcedureSummaries}
            openProcedureId={document?.procedureId ?? null}
            onOpen={(summary) => openProcedureRunSummary(summary, currentUnitContext)}
          />
        </div>
        <div class="procedure-header-actions">
          <button class="procedure-font-button large" type="button" title="Increase procedure font size" aria-label="Increase procedure font size" onclick={increaseProcedureFontSize}>
            A
          </button>
          <button class="procedure-font-button small" type="button" title="Decrease procedure font size" aria-label="Decrease procedure font size" onclick={decreaseProcedureFontSize}>
            A
          </button>
          <button type="button" title="Refresh procedure source" aria-label="Refresh procedure source" onclick={() => void loadCatalogAndRuns(true)}>
            <RefreshCw size={18} aria-hidden="true" />
          </button>
          <button type="button" title="Close procedures" aria-label="Close procedures" onclick={close}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div class="procedure-cross-unit-strip" aria-label="Cross-unit procedure status">
        {#each procedureUnits as unit (unit.plantId)}
          {@const unitStatusPresentation = statusForUnit(unit)}
          {@const unitSummaries = unitProcedureSummariesFor(unit)}
          <div class="procedure-cross-unit" class:current={unit.plantId === plantId}>
            <StatusIndicator tone={unitStatusPresentation.tone} label={unitStatusPresentation.label} indicator={unitStatusPresentation.indicator} />
            <span class="procedure-cross-unit-name">{unit.label}</span>
            <ProcedureRunBadges
              summaries={unitSummaries}
              openProcedureId={unit.plantId === plantId ? document?.procedureId ?? null : null}
              onOpen={(summary) => openProcedureRunSummary(summary, unit)}
            />
          </div>
        {/each}
      </div>

      <div class="procedure-csf-strip" aria-label="Critical safety functions">
        {#each csfIds as csf}
          {@const evaluation = csfEvaluationFor(csf)}
          <div class="procedure-csf-shell">
            <button type="button" class="procedure-csf {evaluation?.status ?? 'unknown'}">
              <span>{evaluation?.label ?? csf.replaceAll('-', ' ')}</span>
            </button>
            <div class="procedure-csf-popover" role="tooltip">
              {#if evaluation}
                <strong>
                  {evaluation.label}:
                  <span class="procedure-csf-status-text {evaluation.status}">{evaluation.status}</span>
                </strong>
                {#if evaluation.reason}
                  <p>{evaluation.reason}</p>
                {/if}
                <small>Read {evaluation.signalCount} plant signal{evaluation.signalCount === 1 ? '' : 's'}.</small>
                <div class="procedure-csf-signals">
                  {#each evaluation.signals as signal (signal.id)}
                    <div class="procedure-csf-signal {csfSignalTone(signal)}">
                      <span>{signal.label}</span>
                      <b>{csfSignalValueText(signal)}</b>
                      {#if signal.path}<code>{signal.path}</code>{/if}
                    </div>
                  {/each}
                </div>
              {:else}
                <strong>{csf.replaceAll('-', ' ')}: <span class="procedure-csf-status-text unknown">unknown</span></strong>
                <small>CSF status has not been evaluated yet.</small>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </header>

    {#if csfError}
      <div class="procedure-error">{csfError}</div>
    {/if}

    {#if error}
      <div class="procedure-error">{error}</div>
    {/if}

    {#if procedureLoadPanelVisible}
      <section class="procedure-loading-panel" aria-live="polite" aria-label="Procedure system loading status">
        <div>
          <h2>{refreshing ? 'Refreshing procedure system' : 'Loading procedure system'}</h2>
          <p>{sourceLabel}</p>
        </div>
        <div class="procedure-load-steps">
          {#each procedureLoadRows as stage (stage.id)}
            <div class="procedure-load-step {stage.status}">
              <span class="procedure-load-dot" aria-hidden="true"></span>
              <strong>{stage.label}</strong>
              <small>{stage.detail ?? (stage.status === 'pending' ? 'Pending' : stage.status)}</small>
            </div>
          {/each}
        </div>
      </section>
    {:else}
      <div class="procedure-layout toc-{procedureTocMode}">
        {#if procedureTocMode !== 'collapsed'}
        <aside class="procedure-list" aria-label="Procedure list">
            {#each catalogCategories as category (category.id)}
              <section>
                <h3>{category.label}</h3>
                {#each category.procedures as item (item.procedureId)}
                  {@const runState = procedureRunVisualStateFor(item.procedureId)}
                  <button
                    type="button"
                    class:active={selectedProcedureId === item.procedureId}
                    class:run-active={runState === 'active'}
                    class:run-completed={runState === 'completed'}
                    aria-busy={loadingProcedureId === item.procedureId}
                    onclick={() => void loadProcedure(item.procedureId)}
                  >
                    <span class="procedure-book-icon {runState}">
                      <BookOpen size={15} aria-hidden="true" />
                    </span>
                    <span>{item.procedureId}</span>
                    <small>{item.title}</small>
                  </button>
                {/each}
              </section>
            {/each}
        </aside>
        {/if}

        <button
          type="button"
          class="procedure-toc-handle"
          title={procedureTocModeLabel()}
          aria-label={procedureTocModeLabel()}
          onclick={cycleProcedureTocMode}
        >
          {#if procedureTocMode === 'collapsed'}
            <ChevronRight size={17} aria-hidden="true" />
          {:else}
            <ChevronLeft size={17} aria-hidden="true" />
          {/if}
        </button>

        <main
          class="procedure-document"
          class:completed-run={selectedProcedureRun?.status === 'completed'}
          aria-busy={loadingProcedureId !== null}
        >
          {#if document}
          <div class="procedure-document-toolbar">
            <div class="procedure-document-title">
              <h2>{document.procedureId} — {document.title}</h2>
              {#if document.description}
                <button type="button" class="procedure-summary-help" aria-label="Procedure summary">
                  <HelpCircle size={17} aria-hidden="true" />
                  <span class="procedure-summary-popover">{document.description}</span>
                </button>
              {/if}
              <a class="procedure-source-icon" href={document.sourceUrl} target="_blank" rel="noreferrer" title="Open procedure source" aria-label="Open procedure source">
                <ExternalLink size={15} aria-hidden="true" />
              </a>
              <button
                type="button"
                class="procedure-step-counter"
                disabled={currentProcedureStep === null}
                title={currentProcedureStep ? `Scroll to ${procedureStepHoverLabel(currentProcedureStep.step)}` : 'No active procedure step'}
                onclick={() => currentProcedureStep && scrollToProcedureStep(currentProcedureStep.step.id)}
              >Step {currentProcedureStep?.step.label ?? '-'}/{document.steps.length}</button>
            </div>
            <div class="procedure-mode-actions">
              {#if completedRun}
                <button type="button" class="completed" disabled>Completed</button>
                <button type="button" class="reset" onclick={() => { confirmation = 'reset' }}>Reset</button>
              {:else if activeRun}
                <button type="button" class="run running" onclick={() => { confirmation = 'completed' }}>
                  <Play size={13} aria-hidden="true" /> Active
                </button>
                <button type="button" class="reset" onclick={() => { confirmation = 'reset' }}>Reset</button>
              {:else}
                <button type="button" class="run" onclick={() => { confirmation = 'run' }}>
                  <Play size={13} aria-hidden="true" /> Run
                </button>
              {/if}
            </div>
          </div>

          <div
            class="procedure-document-body"
            bind:this={procedureDocumentBodyElement}
            onscroll={rememberCurrentProcedureScroll}
          >
            <div class="procedure-steps">
              {#each document.steps as step (step.id)}
                {@const state = stepStates.get(step.id)}
                <article data-procedure-step-id={step.id} class="procedure-step" class:complete={state?.assessment === 'complete'} class:failed={state?.assessment === 'failed'}>
                  <div class="procedure-step-main">
                    <button
                      type="button"
                      class="procedure-assessment {assessmentClass(state)}"
                      disabled={!selectedRun}
                      title="Human placekeeping assessment; not an automatic equipment check"
                      aria-label="Cycle human assessment"
                      onclick={() => void cycleStepAssessment(step)}
                    >
                      {#if state?.assessment === 'complete'}
                        <Check size={17} aria-hidden="true" />
                      {:else if state?.assessment === 'failed'}
                        <X size={17} aria-hidden="true" />
                      {:else if state?.assessment === 'unknown'}
                        <HelpCircle size={17} aria-hidden="true" />
                      {/if}
                    </button>
                    <div class="procedure-step-content">
                      <h3>Step {step.label}<span>{procedureStepDisplayName(step)}</span></h3>
                      <div class="procedure-two-column">
                        <div class="procedure-column">
                          {#each step.blocks.filter(block => primaryBlockKinds.has(block.kind)) as block}
                            <p class="block-{block.kind}"><b>{block.kind}</b> {#each textSegments(block.text) as segment}{#if segment.kind === 'tag'}<button type="button" class="procedure-tag" onmouseenter={() => void showTag(segment.text as ProcedureTagId)} onmouseleave={hideTag}>«{segment.text}»</button>{:else}{segment.text}{/if}{/each}</p>
                          {/each}
                        </div>
                        <div class="procedure-column response">
                          {#each step.blocks.filter(block => !primaryBlockKinds.has(block.kind)) as block}
                            <p class="block-{block.kind}"><b>{block.kind}</b> {#each textSegments(block.text) as segment}{#if segment.kind === 'tag'}<button type="button" class="procedure-tag" onmouseenter={() => void showTag(segment.text as ProcedureTagId)} onmouseleave={hideTag}>«{segment.text}»</button>{:else}{segment.text}{/if}{/each}</p>
                          {/each}
                          {#each step.branches as branch}
                            <button
                              type="button"
                              class="procedure-branch"
                              disabled={!selectedRun || (branch.targetKind !== 'step' && branch.targetKind !== 'procedure')}
                              title={selectedRun ? branchActionTextFor(branch) : 'Start the procedure to use branch actions'}
                              onclick={() => void activateBranch(step, branch)}
                            >
                              <strong>{branch.label}</strong>
                              <span>{branchActionTextFor(branch)}</span>
                              {#if branch.because}<em>{branch.because}</em>{/if}
                            </button>
                          {/each}
                        </div>
                      </div>
                      {#if commentOpen[draftKey(step.id)]}
                        <div class="procedure-comment-editor">
                          <textarea
                            value={commentDrafts[draftKey(step.id)] ?? state?.comment ?? ''}
                            oninput={(event) => { commentDrafts = { ...commentDrafts, [draftKey(step.id)]: event.currentTarget.value } }}
                            placeholder="Add handling annotation..."
                          ></textarea>
                          <button type="button" onclick={() => void saveComment(step)}>Save comment</button>
                        </div>
                      {/if}
                      {#if state?.comment}
                        <div class="procedure-comment">{state.comment}</div>
                      {/if}
                    </div>
                  </div>
                  <div class="procedure-step-actions">
                    <button type="button" class:active={commentOpen[draftKey(step.id)] === true} disabled={!selectedRun} title="Comment" aria-label="Comment" onclick={() => { commentOpen = { ...commentOpen, [draftKey(step.id)]: !commentOpen[draftKey(step.id)] }; commentDrafts = { ...commentDrafts, [draftKey(step.id)]: state?.comment ?? '' } }}>
                      <MessageSquare size={16} aria-hidden="true" />
                    </button>
                    <button type="button" class:active={state?.favorite === true} disabled={!selectedRun} title="Favorite" aria-label="Favorite" onclick={() => void toggleFavorite(step)}>
                      <Star size={16} aria-hidden="true" />
                    </button>
                    <button type="button" title="Report procedure issue" aria-label="Report procedure issue" onclick={() => openIssue(step)}>
                      <Bug size={16} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              {/each}
            </div>
          </div>
          {#if loadingProcedureId !== null}
            <div class="procedure-document-loading" role="status" aria-live="polite" aria-label="Loading procedure {loadingProcedureId}">
              <span class="procedure-document-spinner" aria-hidden="true"></span>
              <strong>Loading {loadingProcedureId}</strong>
            </div>
          {/if}
        {:else}
          <div class="procedure-loading">No procedure selected.</div>
        {/if}
        </main>
      </div>
    {/if}

    {#if hoveredTagId}
      <div class="procedure-tag-popover">
        <strong>{hoveredTagId}</strong>
        {#if tagFor(hoveredTagId)?.description}<span>{tagFor(hoveredTagId)?.description}</span>{/if}
        {#if hoveredTagValue}
          <b>{hoveredTagValue.formatted}</b>
          {#if hoveredTagValue.path}<small>{hoveredTagValue.path}</small>{/if}
        {:else if validationFor(hoveredTagId)?.status === 'missing'}
          <em>Not resolved to a Leitbild signal.</em>
        {:else if hoveredTagError}
          <em>{hoveredTagError}</em>
        {:else}
          <small>Reading live value...</small>
        {/if}
        {#if validationFor(hoveredTagId)?.status !== 'missing' && validationFor(hoveredTagId)?.warnings.length}
          <em>{validationFor(hoveredTagId)?.warnings.join('; ')}</em>
        {/if}
      </div>
    {/if}

    {#if refreshing}
      <div class="procedure-refreshing">Refreshing procedure source...</div>
    {/if}

    {#if confirmation}
      <div class="procedure-confirm-backdrop" role="presentation" onmousedown={cancelConfirmation}>
        <div class="procedure-confirm" role="dialog" aria-modal="true" aria-label={confirmationTitle()} tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
          <h2>{confirmationTitle()}</h2>
          {#if confirmation === 'transition' && pendingTransition}
            <p>
              Transition from {transitionFromLabel(pendingTransition)} to
              <br />
              <strong>{transitionToLabel(pendingTransition)}</strong>
            </p>
          {:else}
            <p>{confirmationBody()}</p>
          {/if}
          <div class="procedure-confirm-actions">
            <button type="button" onclick={cancelConfirmation}>Cancel</button>
            <button type="button" class="primary" disabled={transitionInProgress} onclick={() => void confirmProcedureAction()}>Confirm</button>
          </div>
        </div>
      </div>
    {/if}

    {#if procedureToast}
      <div
        class="procedure-toast {procedureToast.placement} {procedureToast.tone}"
        style={`--procedure-toast-duration: ${procedureToast.durationMs}ms;`}
        role="status"
      >
        {procedureToast.message}
      </div>
    {/if}
    <div
      class="procedure-resize-handle north"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize procedure system from top"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle east"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize procedure system from right"
      onpointerdown={(event) => startWindowDrag(event, 'resize-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle south"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize procedure system from bottom"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle west"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize procedure system from left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle corner north-east"
      role="separator"
      aria-label="Resize procedure system from top right"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle corner north-west"
      role="separator"
      aria-label="Resize procedure system from top left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle corner south-east"
      role="separator"
      aria-label="Resize procedure system from bottom right"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle corner south-west"
      role="separator"
      aria-label="Resize procedure system from bottom left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
  </div>
</div>
