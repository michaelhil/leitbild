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
    readProcedureTagValue,
    startProcedureRun,
    updateProcedureStep,
    validateProcedureTags,
    type ProcedureCsfEvaluation,
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
  let lastRealtimeRevision = 0
  let csfRefreshInFlight = false

  const activeRuns = $derived(runs.filter(run => run.status === 'active'))
  const activeRun = $derived(document
    ? activeRuns.find(run => run.procedureId === document.procedureId) ?? null
    : null)
  const selectedRun = $derived(mode === 'run' ? activeRun : null)
  const stepStates = $derived(new Map((selectedRun?.stepStates ?? []).map(state => [state.stepId, state])))
  const selectedProcedure = $derived(catalog?.procedures.find(item => item.procedureId === selectedProcedureId) ?? null)
  const procedureFamilies = $derived(groupCatalog(catalog?.procedures ?? []))
  const sourceLabel = $derived(catalog
    ? `${catalog.source.repository}@${catalog.source.ref}`
    : 'Procedure source')
  const csfIds = $derived(document?.csfsMonitored ?? [])
  const primaryBlockKinds = new Set(['check', 'action', 'when', 'until', 'within', 'concurrent'])

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

  const completedStepCount = (run: ProcedureRunState): number =>
    run.stepStates.filter(step => step.assessment === 'complete').length

  const loadCatalogAndRuns = async (refresh = false): Promise<void> => {
    try {
      refreshing = refresh
      error = null
      const nextCatalog = await readProcedureCatalog(controlInstanceId, { refresh })
      const nextRuns = await readProcedureRuns(controlInstanceId)
      catalog = nextCatalog
      runs = nextRuns.runs
      selectedProcedureId = selectedProcedureId ?? nextCatalog.procedures[0]?.procedureId ?? null
      if (selectedProcedureId && (!document || document.procedureId !== selectedProcedureId || refresh)) {
        await loadProcedure(selectedProcedureId, refresh)
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
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
      const nextDocument = await readProcedureDocument(controlInstanceId, procedureId, {
        sourceId: catalog?.source.sourceId,
        refresh,
      })
      document = nextDocument
      const [nextTagValidation, nextCsfEvaluations] = await Promise.all([
        validateProcedureTags(controlInstanceId, systemId, nextDocument.tags),
        evaluateProcedureCsfs(controlInstanceId, systemId, nextDocument.csfsMonitored),
      ])
      tagValidation = nextTagValidation
      csfEvaluations = nextCsfEvaluations
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
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
    try {
      hoveredTagValue = await readProcedureTagValue(controlInstanceId, systemId, tagId)
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

    <div class="procedure-layout">
      <aside class="procedure-list" aria-label="Procedure list">
        {#if loading && !catalog}
          <div class="procedure-loading">Loading procedures...</div>
        {:else}
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
        {/if}
      </aside>

      <main class="procedure-document">
        {#if loading && !document}
          <div class="procedure-loading">Loading procedure...</div>
        {:else if document}
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
              <article class="procedure-step" class:complete={state?.assessment === 'complete'} class:failed={state?.assessment === 'failed'}>
                <div class="procedure-step-main">
                  <button
                    type="button"
                    class="procedure-condition unknown"
                    title="Machine evaluation unavailable for this step"
                    aria-label="Machine evaluation unavailable"
                  ></button>
                  <button
                    type="button"
                    class="procedure-assessment {assessmentClass(state)}"
                    disabled={!selectedRun}
                    title="Cycle human assessment"
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
