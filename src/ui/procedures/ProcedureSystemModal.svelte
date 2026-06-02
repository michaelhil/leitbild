<script lang="ts">
  import { BookOpen, Bug, Check, Circle, ExternalLink, HelpCircle, MessageSquare, Play, RefreshCw, Star, X } from 'lucide-svelte'
  import type {
    ControlInstanceId,
    ProcedureAssessment,
    ProcedureCatalog,
    ProcedureCatalogItem,
    ProcedureDocument,
    ProcedureRunState,
    ProcedureStep,
    ProcedureStepRunState,
    ProcedureTag,
    ProcedureTagId,
  } from '../../core/model/index.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import {
    closeProcedureRun,
    evaluateProcedureCsfs,
    readProcedureCatalog,
    readProcedureDocument,
    readProcedureRuns,
    readProcedureSourceStatus,
    readProcedureTagValue,
    startProcedureRun,
    updateProcedureStep,
    validateProcedureTags,
    type ProcedureCsfEvaluation,
    type ProcedureSourceLoadStatus,
    type ProcedureTagValidation,
    type ProcedureTagValue,
  } from './procedure-client.ts'

  interface Props {
    readonly controlInstanceId: ControlInstanceId
    readonly systemId: string
    readonly realtimeRevision: number
    readonly close: () => void
  }

  interface TextSegment {
    readonly kind: 'text' | 'tag'
    readonly text: string
  }

  type LoadStageId = 'source' | 'runs' | 'document' | 'tags' | 'csfs'
  type LoadStageStatus = 'pending' | 'running' | 'done' | 'failed'

  interface LoadStage {
    readonly id: LoadStageId
    readonly label: string
    readonly status: LoadStageStatus
    readonly detail?: string
  }

  let { controlInstanceId, systemId, realtimeRevision, close }: Props = $props()

  let loading = $state(true)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let catalog = $state<ProcedureCatalog | null>(null)
  let document = $state<ProcedureDocument | null>(null)
  let runs = $state<ReadonlyArray<ProcedureRunState>>([])
  let selectedProcedureId = $state<string | null>(null)
  let mode = $state<'read' | 'run'>('read')
  let tagValidation = $state<ReadonlyMap<string, ProcedureTagValidation>>(new Map())
  let csfEvaluations = $state<ReadonlyMap<string, ProcedureCsfEvaluation>>(new Map())
  let csfError = $state<string | null>(null)
  let hoveredTagId = $state<ProcedureTagId | null>(null)
  let hoveredTagValue = $state<ProcedureTagValue | null>(null)
  let hoveredTagError = $state<string | null>(null)
  let commentOpen = $state<Record<string, boolean>>({})
  let commentDrafts = $state<Record<string, string>>({})
  let procedureSourceStatus = $state<ProcedureSourceLoadStatus | null>(null)
  let loadStages = $state<Record<LoadStageId, LoadStage>>(createLoadStages())
  let lastRealtimeRevision = 0
  let csfRefreshInFlight = false

  const activeRuns = $derived(runs.filter(run => run.status === 'active'))
  const activeRun = $derived(document
    ? activeRuns.find(run => run.procedureId === document.procedureId) ?? null
    : null)
  const selectedRun = $derived(mode === 'run' ? activeRun : null)
  const procedureLoadPanelVisible = $derived(loading || (error !== null && (catalog === null || document === null)))
  const stepStates = $derived(new Map((selectedRun?.stepStates ?? []).map(state => [state.stepId, state])))
  const selectedProcedure = $derived(catalog?.procedures.find(item => item.procedureId === selectedProcedureId) ?? null)
  const procedureFamilies = $derived(groupCatalog(catalog?.procedures ?? []))
  const sourceLabel = $derived(catalog
    ? `${catalog.source.repository}@${catalog.source.ref}`
    : 'Procedure source')
  const csfIds = $derived(document?.csfsMonitored ?? [])
  const primaryBlockKinds = new Set(['check', 'action', 'when', 'until', 'within', 'concurrent'])

  function createLoadStages(): Record<LoadStageId, LoadStage> {
    return {
      source: { id: 'source', label: 'Load procedure source', status: 'pending' },
      runs: { id: 'runs', label: 'Read active runs', status: 'pending' },
      document: { id: 'document', label: 'Load selected procedure', status: 'pending' },
      tags: { id: 'tags', label: 'Resolve plant tags', status: 'pending' },
      csfs: { id: 'csfs', label: 'Evaluate critical safety functions', status: 'pending' },
    }
  }

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

  const sourceProgressDetail = (status: ProcedureSourceLoadStatus | null): string | undefined => {
    if (!status) return undefined
    if (status.stage === 'listing') return `Reading ${status.repository}/${status.path}`
    if (status.stage === 'loading-documents') {
      const count = status.totalItems === undefined
        ? `${status.loadedItems}`
        : `${status.loadedItems}/${status.totalItems}`
      return status.currentItem ? `${count} Markdown files · ${status.currentItem}` : `${count} Markdown files`
    }
    if (status.stage === 'ready') return `${status.loadedItems} procedures available`
    if (status.stage === 'failed') return status.error ?? 'Procedure source failed'
    return 'Waiting for source loader'
  }

  const sourceStageStatus = (status: ProcedureSourceLoadStatus | null): LoadStageStatus => {
    if (!status) return loadStages.source.status
    if (status.stage === 'ready') return 'done'
    if (status.stage === 'failed') return 'failed'
    if (status.stage === 'idle') return loadStages.source.status
    return 'running'
  }

  const procedureLoadRows = $derived<ReadonlyArray<LoadStage>>([
    {
      ...loadStages.source,
      status: sourceStageStatus(procedureSourceStatus),
      ...(sourceProgressDetail(procedureSourceStatus) === undefined ? {} : { detail: sourceProgressDetail(procedureSourceStatus) }),
    },
    loadStages.runs,
    loadStages.document,
    loadStages.tags,
    loadStages.csfs,
  ])

  const familyLabel = (id: string): string => {
    if (id === 'E') return 'Emergency operating procedures'
    if (id === 'ECA') return 'Emergency contingency actions'
    if (id === 'ES') return 'Emergency supplements'
    if (id === 'FR') return 'Function restoration'
    return id
  }

  const groupCatalog = (procedures: ReadonlyArray<ProcedureCatalogItem>): ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly procedures: ReadonlyArray<ProcedureCatalogItem>
  }> => {
    const groups = new Map<string, ProcedureCatalogItem[]>()
    for (const procedure of procedures) {
      const family = procedure.procedureId.split('-')[0] ?? 'Other'
      groups.set(family, [...(groups.get(family) ?? []), procedure])
    }
    return [...groups.entries()].map(([id, items]) => ({
      id,
      label: familyLabel(id),
      procedures: items,
    }))
  }

  const assessmentClass = (state: ProcedureStepRunState | undefined): string =>
    state?.assessment ?? 'blank'

  const machineStatusFor = (_step: ProcedureStep): 'met' | 'not-met' | 'unknown' =>
    'unknown'

  const machineStatusTitleFor = (step: ProcedureStep): string => {
    const status = machineStatusFor(step)
    if (status === 'met') return 'Machine evaluation: conditions met'
    if (status === 'not-met') return 'Machine evaluation: conditions not met'
    return 'Machine evaluation unavailable for this step; checkbox is the human placekeeping state'
  }

  const completedStepCount = (run: ProcedureRunState): number =>
    run.stepStates.filter(step => step.assessment === 'complete').length

  const pollProcedureSourceStatus = (sourceId?: string): (() => void) => {
    let stopped = false
    let inFlight = false
    const poll = async (): Promise<void> => {
      if (stopped || inFlight) return
      try {
        inFlight = true
        procedureSourceStatus = await readProcedureSourceStatus(controlInstanceId, { sourceId })
      } catch (err) {
        setLoadStage('source', 'failed', errorMessage(err))
      } finally {
        inFlight = false
      }
    }
    void poll()
    const interval = window.setInterval(() => {
      void poll()
    }, 500)
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }

  const loadCatalogAndRuns = async (refresh = false): Promise<void> => {
    let stopSourceStatusPolling: (() => void) | null = null
    try {
      loading = true
      refreshing = refresh
      error = null
      loadStages = createLoadStages()
      procedureSourceStatus = null
      setLoadStage('source', 'running', refresh ? 'Refreshing source files' : 'Starting source loader')
      stopSourceStatusPolling = pollProcedureSourceStatus(catalog?.source.sourceId)
      const nextCatalog = await readProcedureCatalog(controlInstanceId, { refresh })
      stopSourceStatusPolling()
      stopSourceStatusPolling = null
      procedureSourceStatus = await readProcedureSourceStatus(controlInstanceId, { sourceId: nextCatalog.source.sourceId })
      setLoadStage('source', 'done', `${nextCatalog.procedures.length} procedures available`)
      setLoadStage('runs', 'running')
      const nextRuns = await readProcedureRuns(controlInstanceId)
      catalog = nextCatalog
      runs = nextRuns.runs
      setLoadStage('runs', 'done', `${nextRuns.runs.length} tracked runs`)
      selectedProcedureId = selectedProcedureId ?? nextCatalog.procedures[0]?.procedureId ?? null
      if (selectedProcedureId && (!document || document.procedureId !== selectedProcedureId || refresh)) {
        await loadProcedure(selectedProcedureId, refresh)
      } else {
        setLoadStage('document', 'done', document ? `${document.procedureId} already loaded` : 'No procedure selected')
        setLoadStage('tags', 'done', document ? `${document.tags.length} tags already resolved` : 'No tags')
        setLoadStage('csfs', 'done', document ? `${document.csfsMonitored.length} CSFs already evaluated` : 'No CSFs')
      }
    } catch (err) {
      error = errorMessage(err)
      const activeStage = procedureLoadRows.find(stage => stage.status === 'running')
      if (activeStage) setLoadStage(activeStage.id, 'failed', error)
    } finally {
      stopSourceStatusPolling?.()
      loading = false
      refreshing = false
    }
  }

  const refreshRuns = async (): Promise<void> => {
    try {
      runs = (await readProcedureRuns(controlInstanceId)).runs
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const loadProcedure = async (procedureId: string, refresh = false): Promise<void> => {
    try {
      loading = true
      error = null
      selectedProcedureId = procedureId
      setLoadStage('document', 'running', procedureId)
      const nextDocument = await readProcedureDocument(controlInstanceId, procedureId, {
        sourceId: catalog?.source.sourceId,
        refresh,
      })
      document = nextDocument
      setLoadStage('document', 'done', `${nextDocument.steps.length} steps`)
      const loadTagValidation = async (): Promise<ReadonlyMap<string, ProcedureTagValidation>> => {
        try {
          setLoadStage('tags', 'running', `${nextDocument.tags.length} tags`)
          const nextTagValidation = await validateProcedureTags(controlInstanceId, systemId, nextDocument.tags)
          const missingCount = [...nextTagValidation.values()].filter(validation => validation.status === 'missing').length
          setLoadStage('tags', 'done', missingCount === 0
            ? `${nextDocument.tags.length} tags resolved`
            : `${nextDocument.tags.length - missingCount}/${nextDocument.tags.length} tags resolved`)
          return nextTagValidation
        } catch (err) {
          setLoadStage('tags', 'failed', errorMessage(err))
          throw err
        }
      }
      const loadCsfEvaluations = async (): Promise<ReadonlyMap<string, ProcedureCsfEvaluation>> => {
        try {
          setLoadStage('csfs', 'running', `${nextDocument.csfsMonitored.length} functions`)
          const nextCsfEvaluations = await evaluateProcedureCsfs(controlInstanceId, systemId, nextDocument.csfsMonitored)
          setLoadStage('csfs', 'done', `${nextCsfEvaluations.size} functions evaluated`)
          return nextCsfEvaluations
        } catch (err) {
          setLoadStage('csfs', 'failed', errorMessage(err))
          throw err
        }
      }
      const [nextTagValidation, nextCsfEvaluations] = await Promise.all([
        loadTagValidation(),
        loadCsfEvaluations(),
      ])
      tagValidation = nextTagValidation
      csfEvaluations = nextCsfEvaluations
    } catch (err) {
      error = errorMessage(err)
    } finally {
      loading = false
    }
  }

  const startSelectedProcedure = async (): Promise<void> => {
    const current = document
    if (!current) return
    try {
      await startProcedureRun(controlInstanceId, {
        sourceId: current.source.sourceId,
        procedureId: current.procedureId,
      })
      mode = 'run'
      await refreshRuns()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const closeActiveRun = async (status: 'completed' | 'abandoned'): Promise<void> => {
    if (!activeRun) return
    try {
      await closeProcedureRun(controlInstanceId, { runId: activeRun.runId, status })
      await refreshRuns()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const assessmentAfter = (assessment: ProcedureAssessment | undefined): ProcedureAssessment => {
    if (!assessment || assessment === 'blank') return 'complete'
    if (assessment === 'complete') return 'failed'
    if (assessment === 'failed') return 'unknown'
    return 'blank'
  }

  const updateStep = async (
    step: ProcedureStep,
    update: { readonly assessment?: ProcedureAssessment; readonly comment?: string; readonly favorite?: boolean },
  ): Promise<void> => {
    if (!selectedRun) return
    try {
      await updateProcedureStep(controlInstanceId, {
        runId: selectedRun.runId,
        stepId: step.id,
        ...update,
      })
      await refreshRuns()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const cycleStepAssessment = async (step: ProcedureStep): Promise<void> => {
    const current = stepStates.get(step.id)
    await updateStep(step, { assessment: assessmentAfter(current?.assessment) })
  }

  const toggleFavorite = async (step: ProcedureStep): Promise<void> => {
    const current = stepStates.get(step.id)
    await updateStep(step, { favorite: !(current?.favorite ?? false) })
  }

  const saveComment = async (step: ProcedureStep): Promise<void> => {
    await updateStep(step, { comment: commentDrafts[step.id] ?? '' })
  }

  const tagFor = (tagId: ProcedureTagId): ProcedureTag | undefined =>
    document?.tags.find(tag => tag.id === tagId)

  const validationFor = (tagId: ProcedureTagId): ProcedureTagValidation | undefined =>
    tagValidation.get(tagId)

  const csfEvaluationFor = (csf: string): ProcedureCsfEvaluation | undefined =>
    csfEvaluations.get(csf)

  const csfTitleFor = (csf: string): string => {
    const evaluation = csfEvaluationFor(csf)
    if (!evaluation) return 'CSF status has not been evaluated yet.'
    if (evaluation.reason) return evaluation.reason
    return `${evaluation.label}: ${evaluation.status}; ${evaluation.signalCount} plant signals read.`
  }

  const refreshCsfStatus = async (csfs = csfIds): Promise<void> => {
    if (csfs.length === 0 || csfRefreshInFlight) return
    try {
      csfRefreshInFlight = true
      csfError = null
      csfEvaluations = await evaluateProcedureCsfs(controlInstanceId, systemId, csfs)
    } catch (err) {
      csfError = err instanceof Error ? err.message : String(err)
    } finally {
      csfRefreshInFlight = false
    }
  }

  const showTag = async (tagId: ProcedureTagId): Promise<void> => {
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
      hoveredTagValue = await readProcedureTagValue(controlInstanceId, systemId, tag)
    } catch (err) {
      hoveredTagError = err instanceof Error ? err.message : String(err)
    }
  }

  const hideTag = (): void => {
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
      `Source revision: ${document.source.commitSha ?? `${document.source.repository}@${document.source.ref}`}`,
      `Leitbild control instance: ${controlInstanceId}`,
      '',
      'Describe the procedure text or procedure-system problem here:',
    ].join('\n')
    const params = new URLSearchParams({
      title: `[${document.procedureId}] ${step.id}`,
      body,
      labels: 'procedure,leitbild',
    })
    window.open(`https://github.com/samsinn-wikis/pwr-ops/issues/new?${params.toString()}`, '_blank', 'noopener,noreferrer')
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
    void loadCatalogAndRuns()
    const interval = window.setInterval(() => {
      void refreshCsfStatus()
    }, 2_000)
    return () => {
      window.clearInterval(interval)
    }
  })

  $effect(() => {
    if (realtimeRevision === lastRealtimeRevision) return
    lastRealtimeRevision = realtimeRevision
    if (!loading) {
      void refreshRuns()
      void refreshCsfStatus()
    }
  })
</script>

<div class="procedure-backdrop" role="presentation" onmousedown={close}>
  <div class="procedure-modal" role="dialog" aria-modal="true" aria-label="Computer-based procedure system" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
    <header class="procedure-header">
      <div>
        <strong>Computer-based procedures</strong>
        <span>{sourceLabel}</span>
      </div>
      <div class="procedure-header-actions">
        <button type="button" title="Refresh procedure source" aria-label="Refresh procedure source" onclick={() => void loadCatalogAndRuns(true)}>
          <RefreshCw size={18} aria-hidden="true" />
        </button>
        <button type="button" title="Close procedures" aria-label="Close procedures" onclick={close}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="procedure-csf-strip" aria-label="Critical safety functions">
      {#if csfIds.length === 0}
        <div class="procedure-csf unknown"><Circle size={12} /> CSF status unavailable until a procedure is selected</div>
      {:else}
        {#each csfIds as csf}
          {@const evaluation = csfEvaluationFor(csf)}
          <div class="procedure-csf {evaluation?.status ?? 'unknown'}" title={csfTitleFor(csf)}>
            <Circle size={12} /> {evaluation?.label ?? csf.replaceAll('-', ' ')}
          </div>
        {/each}
      {/if}
    </div>

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
      <div class="procedure-layout">
        <aside class="procedure-list" aria-label="Procedure list">
            {#each procedureFamilies as family (family.id)}
              <section>
                <h3>{family.label}</h3>
                {#each family.procedures as item (item.procedureId)}
                  <button
                    type="button"
                    class:active={selectedProcedureId === item.procedureId}
                    onclick={() => void loadProcedure(item.procedureId)}
                  >
                    <BookOpen size={15} aria-hidden="true" />
                    <span>{item.procedureId}</span>
                    <small>{item.title}</small>
                  </button>
                {/each}
              </section>
            {/each}
        </aside>

        <main class="procedure-document">
          {#if document}
          <div class="procedure-document-toolbar">
            <div>
              <h2>{document.procedureId} — {document.title}</h2>
              <p>{document.description}</p>
            </div>
            <div class="procedure-mode-actions">
              <button type="button" class:active={mode === 'read'} onclick={() => { mode = 'read' }}>Read</button>
              <button type="button" class:active={mode === 'run'} disabled={!activeRun} onclick={() => { mode = 'run' }}>Run</button>
              {#if activeRun}
                <button type="button" onclick={() => void closeActiveRun('completed')}>Complete run</button>
                <button type="button" onclick={() => void closeActiveRun('abandoned')}>Abandon</button>
              {:else}
                <button type="button" class="primary" onclick={() => void startSelectedProcedure()}>
                  <Play size={15} aria-hidden="true" /> Start
                </button>
              {/if}
              <a href={document.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={15} aria-hidden="true" /> Source
              </a>
            </div>
          </div>

          <div class="procedure-run-banner">
            {#if selectedRun}
              Active run · {selectedRun.runId} · {completedStepCount(selectedRun)} / {document.steps.length} steps completed
            {:else}
              Read-only view · start the procedure to enable synchronized placekeeping
            {/if}
          </div>

          <div class="procedure-steps">
            {#each document.steps as step (step.id)}
              {@const state = stepStates.get(step.id)}
              {@const machineStatus = machineStatusFor(step)}
              <article class="procedure-step" class:complete={state?.assessment === 'complete'} class:failed={state?.assessment === 'failed'}>
                <div class="procedure-step-main">
                  <button
                    type="button"
                    class="procedure-assessment {assessmentClass(state)} machine-{machineStatus}"
                    disabled={!selectedRun}
                    title={machineStatusTitleFor(step)}
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
                    <h3>Step {step.label}<span>{step.title}</span></h3>
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
                          <div class="procedure-branch">
                            <strong>{branch.label}</strong>
                            <span>→ {branch.targetKind === 'step' ? `Step ${branch.target}` : branch.target}</span>
                            {#if branch.because}<em>{branch.because}</em>{/if}
                          </div>
                        {/each}
                      </div>
                    </div>
                    {#if commentOpen[step.id]}
                      <div class="procedure-comment-editor">
                        <textarea
                          value={commentDrafts[step.id] ?? state?.comment ?? ''}
                          oninput={(event) => { commentDrafts = { ...commentDrafts, [step.id]: event.currentTarget.value } }}
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
                  <button type="button" class:active={commentOpen[step.id] === true} disabled={!selectedRun} title="Comment" aria-label="Comment" onclick={() => { commentOpen = { ...commentOpen, [step.id]: !commentOpen[step.id] }; commentDrafts = { ...commentDrafts, [step.id]: state?.comment ?? '' } }}>
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
  </div>
</div>
