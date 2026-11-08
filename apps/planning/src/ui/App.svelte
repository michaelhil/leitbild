<script lang="ts">
  import { onMount } from 'svelte'
  import { resourceCatalogChangedMessageSchema, type ModuleResourceDescriptor } from '@leitbild/contracts'
  import { currentProblemRevision, type Study, type Candidate, type SourceBinding } from '../study-model.ts'
  import { planningProblemSchema, type PlanningProblem, type PlanningActivity } from '../model.ts'
  import { createPlanningClient, sourceUnavailable, type Demo, type Comparison } from './api.ts'
  import { barPosition, elapsed, fittedHorizon, movePriority, optionalSecond } from './presentation.ts'

  const match = location.pathname.match(/^\/workspaces\/([^/]+)\/planning$/)
  if (!match?.[1]) throw new Error('Planning requires a Workspace route')
  const workspaceId = decodeURIComponent(match[1])
  const client = createPlanningClient(workspaceId)
  const studyId = new URLSearchParams(location.search).get('study')
  let study = $state<Study | null>(null)
  let demos = $state<Demo[]>([])
  let saved = $state<ModuleResourceDescriptor[]>([])
  let loading = $state(true)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let notice = $state('')
  let selectedActivityId = $state('')
  let selectedCandidateId = $state('')
  let comparedIds = $state<string[]>([])
  let comparison = $state<Comparison | null>(null)
  let fullHorizon = $state(false)
  let duration = $state('')
  let remaining = $state('')
  let release = $state('')
  let due = $state('')
  let latestFinish = $state('')
  let weight = $state('')
  let method = $state('')
  let demands = $state<Record<string, string>>({})
  let rationale = $state('')
  let selectedSupplyId = $state('')
  let capacitySegments = $state<Array<{ start: string; end: string; capacity: string }>>([])
  let objectiveText = $state('')

  const revision = $derived(study ? currentProblemRevision(study) : null)
  const problem = $derived(revision?.problem ?? null)
  const candidate = $derived(study?.candidates.find(item => item.id === selectedCandidateId) ?? null)
  const candidateRevision = $derived(candidate ? study?.revisions.find(item => item.id === candidate.problemRevisionId) ?? null : null)
  const displayedProblem = $derived(candidateRevision?.problem ?? problem)
  const baseline = $derived(study?.candidates.find(item => item.id === study?.baselineCandidateId) ?? null)
  const activity = $derived(problem?.activities.find(item => item.id === selectedActivityId) ?? null)
  const stale = $derived(candidate !== null && candidate.problemRevisionId !== study?.currentProblemRevisionId)
  const selectedFacts = $derived(revision?.basis?.subjects.filter(subject => !activity?.subject || subject.locator === activity.subject.locator) ?? [])
  const selectedAssumptions = $derived(revision?.assumptions.filter(item => item.activityId === undefined || item.activityId === selectedActivityId) ?? [])
  const activityObjectives = $derived(problem?.objectives.filter(objective => 'activityId' in objective) ?? [])
  const timelineHorizon = $derived(displayedProblem ? fullHorizon ? displayedProblem.horizon : fittedHorizon(displayedProblem.horizon, [...candidate?.result.placements ?? [], ...baseline?.result.placements ?? []]) : null)
  const hostHref = (id?: string) => `/workspaces/${encodeURIComponent(workspaceId)}?planning=${encodeURIComponent(id ?? 'library')}`
  const notifyCatalog = (): void => {
    if (!studyId || window.parent === window) return
    window.parent.postMessage(resourceCatalogChangedMessageSchema.parse({
      type: 'leitbild:resource-catalog-changed',
      resource: { workspaceId, moduleId: 'planning', type: 'planning.study', id: studyId },
    }), location.origin)
  }
  const candidateLabel = (item: Candidate) => `Candidate ${(study?.candidates.findIndex(value => value.id === item.id) ?? 0) + 1}`
  const bindingTargetLabel = (binding: SourceBinding): string => {
    const target = binding.target
    return target.kind === 'capacity'
      ? problem?.supplies.find(supply => supply.id === target.supplyId)?.title ?? target.supplyId
      : problem?.activities.find(item => item.id === target.activityId)?.title ?? target.activityId
  }
  const hydrateActivity = (item: PlanningActivity | undefined): void => {
    duration = item ? String(item.durationSeconds) : ''
    remaining = item?.progress.kind === 'started' && item.progress.remainingSeconds !== null ? String(item.progress.remainingSeconds) : ''
    release = item?.release === undefined ? '' : String(item.release)
    due = item?.due === undefined ? '' : String(item.due)
    latestFinish = item?.latestFinish === undefined ? '' : String(item.latestFinish)
    weight = item ? String(item.tardinessWeight) : ''
    method = item?.modeId ?? ''
    demands = Object.fromEntries(item?.demands.map(demand => [demand.supplyId, String(demand.amount)]) ?? [])
    rationale = ''
  }
  const selectActivity = (id: string): void => {
    selectedActivityId = id
    hydrateActivity(problem?.activities.find(item => item.id === id))
  }
  const hydrateSupply = (id: string): void => {
    selectedSupplyId = id
    capacitySegments = problem?.supplies.find(item => item.id === id)?.segments.map(segment => ({ start: String(segment.start), end: String(segment.end), capacity: String(segment.capacity) })) ?? []
  }
  const acceptStudy = (next: Study): void => {
    study = next
    const current = currentProblemRevision(next)
    const id = current.problem.activities.some(item => item.id === selectedActivityId) ? selectedActivityId : current.problem.priorityOrder[0] ?? ''
    selectedActivityId = id
    hydrateActivity(current.problem.activities.find(item => item.id === id))
    hydrateSupply(current.problem.supplies.some(item => item.id === selectedSupplyId) ? selectedSupplyId : current.problem.supplies[0]?.id ?? '')
    objectiveText = JSON.stringify(current.problem.objectives, null, 2)
    notifyCatalog()
  }
  const action = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    busy = true
    error = null
    notice = ''
    try { await work() } catch (cause) {
      if (sourceUnavailable(cause)) { study = null; comparison = null; notifyCatalog() }
      error = cause instanceof Error ? cause.message : String(cause)
    }
    finally { busy = false }
  }
  const openStudy = (id: string): void => { window.parent.location.assign(hostHref(id)) }
  const startDemo = (id: Demo['id']) => action(async () => {
    const result = await client.demo(id)
    openStudy(result.study.id)
  })
  const retryStudy = () => action(async () => {
    if (!studyId) return
    const next = await client.study(studyId)
    acceptStudy(next)
    selectedCandidateId = next.candidates.at(-1)?.id ?? ''
  })
  const solve = () => action(async () => {
    if (!study) return
    const result = await client.solve(study.id, study.revision)
    acceptStudy(result.study)
    selectedCandidateId = result.candidate.id
    notice = result.candidate.result.status === 'feasible' ? 'A feasible candidate was calculated and independently checked. No optimum is claimed.' : `Calculation returned ${result.candidate.result.status}. Inspect its issues below.`
  })
  const refresh = () => action(async () => {
    if (!study) return
    const id = study.id
    try {
      const result = await client.refresh(id, study.revision)
      acceptStudy(result.study)
      notice = result.changed ? 'Source evidence changed. Earlier candidates are retained; calculate a candidate for the new inputs.' : 'Source evidence is unchanged.'
    } catch (cause) {
      // Re-read through the same qualification gate before retaining source-backed UI.
      // A source refusal must not leave newly disallowed retained evidence on screen.
      try { acceptStudy(await client.study(id)) } catch { study = null; notifyCatalog() }
      throw cause
    }
  })
  const revise = async (next: PlanningProblem, extra?: { sourceBindings?: NonNullable<typeof revision>['sourceBindings']; assumptions?: NonNullable<typeof revision>['assumptions'] }): Promise<void> => {
    if (!study || !revision) return
    const result = await client.revise(study.id, { expectedRevision: study.revision, problem: planningProblemSchema.parse(next), sourceBindings: extra?.sourceBindings ?? revision.sourceBindings, assumptions: extra?.assumptions ?? revision.assumptions })
    acceptStudy(result)
    comparison = null
    notice = 'Inputs saved as a new problem revision. Calculate a candidate to see their effect.'
  }
  const saveActivity = () => action(async () => {
    if (!problem || !activity || !revision) return
    const durationSeconds = optionalSecond(duration)
    const tardinessWeight = optionalSecond(weight)
    if (durationSeconds === undefined || tardinessWeight === undefined) throw new Error('Duration and weight are required.')
    const next: PlanningActivity = { ...activity, modeId: method.trim(), durationSeconds, tardinessWeight,
      demands: Object.entries(demands).filter(([, amount]) => amount.trim() !== '' && Number(amount) !== 0).map(([supplyId, amount]) => ({ supplyId, amount: optionalSecond(amount) ?? 0 })),
    }
    delete next.release; delete next.due; delete next.latestFinish
    const start = optionalSecond(release), target = optionalSecond(due), end = optionalSecond(latestFinish)
    if (start !== undefined) next.release = start
    if (target !== undefined) next.due = target
    if (end !== undefined) next.latestFinish = end
    const durationChanged = durationSeconds !== activity.durationSeconds
    const remainingSeconds = activity.progress.kind === 'started' ? optionalSecond(remaining) ?? null : null
    const remainingChanged = activity.progress.kind === 'started' && remainingSeconds !== activity.progress.remainingSeconds
    if (activity.progress.kind === 'started') next.progress = { ...activity.progress, remainingSeconds }
    if ((durationChanged || remainingChanged) && !rationale.trim()) throw new Error('Name the reason for the authored timing override.')
    const assumptionId = `duration.${activity.id}`
    const assumptions = durationChanged ? [...revision.assumptions.filter(item => item.id !== assumptionId && item.id !== `${activity.id}-duration` && item.id !== `${activity.id}-rounding`), { id: assumptionId, label: `${activity.title}: authored duration`, value: durationSeconds, unit: 'second', activityId: activity.id, rationale: rationale.trim(), ...(activity.subject ? { subject: activity.subject } : {}) }] : revision.assumptions
    await revise({ ...problem, activities: problem.activities.map(item => item.id === next.id ? next : item) }, {
      sourceBindings: durationChanged ? revision.sourceBindings.filter(binding => !(binding.target.kind === 'duration' && binding.target.activityId === activity.id)) : revision.sourceBindings,
      assumptions: remainingChanged ? [...assumptions.filter(item => item.id !== `remaining.${activity.id}`), { id: `remaining.${activity.id}`, label: `${activity.title}: remaining forecast`, value: remainingSeconds ?? 'unknown', unit: 'second', activityId: activity.id, rationale: rationale.trim() }] : assumptions,
    })
  })
  const move = (direction: -1 | 1) => action(async () => {
    if (!problem) return
    await revise({ ...problem, priorityOrder: movePriority(problem.priorityOrder, selectedActivityId, direction) })
  })
  const saveCapacity = () => action(async () => {
    if (!problem || !revision) return
    const segments = capacitySegments.map(segment => {
      const start = optionalSecond(segment.start), end = optionalSecond(segment.end), capacity = optionalSecond(segment.capacity)
      if (start === undefined || end === undefined || capacity === undefined) throw new Error('Every capacity interval requires start, end and capacity.')
      return { start, end, capacity }
    })
    if (!rationale.trim()) throw new Error('Name the reason for the authored capacity override.')
    const assumptionId = `capacity.${selectedSupplyId}`
    await revise({ ...problem, supplies: problem.supplies.map(supply => supply.id === selectedSupplyId ? { ...supply, segments } : supply) }, {
      sourceBindings: revision.sourceBindings.filter(binding => !(binding.target.kind === 'capacity' && binding.target.supplyId === selectedSupplyId)),
      assumptions: [...revision.assumptions.filter(item => item.id !== assumptionId), { id: assumptionId, label: `Capacity override: ${selectedSupplyId}`, value: JSON.stringify(segments), rationale: rationale.trim() }],
    })
  })
  const saveObjectives = () => action(async () => {
    if (!problem) return
    await revise({ ...problem, objectives: JSON.parse(objectiveText) })
  })
  const saveBaseline = () => action(async () => {
    if (!study || !candidate) return
    acceptStudy(await client.baseline(study.id, study.revision, candidate.id))
    notice = `${candidateLabel(candidate)} saved as baseline. Its inputs and result are retained.`
  })
  const compare = () => action(async () => {
    if (study) comparison = await client.compare(study.id, comparedIds)
  })
  const toggleComparison = (id: string, checked: boolean): void => {
    comparedIds = checked ? [...comparedIds, id] : comparedIds.filter(item => item !== id)
    comparison = null
  }
  onMount(() => {
    void (async () => {
      try {
        if (studyId) {
          const next = await client.study(studyId)
          acceptStudy(next)
          selectedCandidateId = next.candidates.at(-1)?.id ?? ''
        } else {
          const [catalogue, resources] = await Promise.all([client.demos(), client.resources()])
          demos = catalogue.demos
          saved = resources.filter(resource => resource.ref.moduleId === 'planning' && resource.ref.type === 'planning.study')
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        if (sourceUnavailable(cause)) notifyCatalog()
      }
      finally { loading = false }
    })()
  })
</script>

<svelte:head><title>{study?.title ?? 'Planning laboratory'} · Leitbild</title></svelte:head>

<main aria-busy={loading || busy}>
  {#if loading}
    <p class="loading" role="status">Opening the planning laboratory…</p>
  {:else if !study}
    <div class="library">
      <p class="eyebrow">Planning · Research and demonstration</p>
      <h1>Project-planning laboratory</h1>
      <p class="intro">Explore how timing, shared resources and priorities change a plan. Each Study keeps its source evidence, authored assumptions and calculated alternatives together.</p>
      {#if error}<div class="error" role="alert">{error}</div>{/if}
      {#if studyId}<div class="actions"><button disabled={busy} onclick={retryStudy}>Retry opening Study</button><a href={hostHref()} target="_parent">Return to Planning</a></div>{/if}
      {#if demos.length}
        <h2>Start a research use case</h2>
        <div class="demo-grid">
          {#each demos as demo}
            <article class="demo-card"><p class="eyebrow">{demo.id === 'response' ? 'Response & handover' : 'Plant & shared capacity'}</p><h3>{demo.title}</h3><p>{demo.description}</p><button class="primary" disabled={busy} onclick={() => startDemo(demo.id)}>Start use case <span aria-hidden="true">→</span></button></article>
          {/each}
        </div>
        <p class="hint">Starting a use case creates a real World Run and a Planning Study in this Workspace. Planning calculations retain research results; they do not execute the schedule.</p>
      {/if}
      {#if saved.length}
        <h2>Saved Studies <span class="count">{saved.length}</span></h2>
        <ul class="study-list">{#each saved as item}<li><a href={hostHref(item.ref.id)} target="_parent"><strong>{item.title}</strong><span>Open Study →</span></a></li>{/each}</ul>
      {:else if demos.length}<p class="hint">Your saved Studies will appear here and in Workspace Continue.</p>{/if}
    </div>
  {:else if revision && problem && displayedProblem && timelineHorizon}
    <header class="study-header">
      <div><a class="back" href={hostHref()} target="_parent">← Planning</a><div class="title-line"><h1>{study.title}</h1><span class="tag">Research Study</span></div><p class="subtle">Inputs r{revision.id} · As of {elapsed(problem.asOf)} elapsed · {problem.activities.length} activities · {problem.supplies.length} resources</p></div>
      <div class="actions"><button disabled={busy || !revision.basis} onclick={refresh}>Refresh source</button><button class="primary" disabled={busy} onclick={solve}>{busy ? 'Working…' : 'Calculate candidate'}</button></div>
    </header>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    <p class="announcement" role="status" aria-live="polite">{notice}</p>
    <section class="candidate-strip" aria-label="Candidate selection">
      <label>Viewing <select value={selectedCandidateId} onchange={event => { selectedCandidateId = event.currentTarget.value }} disabled={!study.candidates.length || busy}><option value="">Current inputs · no schedule</option>{#each study.candidates as item}<option value={item.id}>{candidateLabel(item)} · r{item.problemRevisionId} · {item.result.status}{item.id === study.baselineCandidateId ? ' · baseline' : ''}</option>{/each}</select></label>
      {#if candidate}<span class:stale class="tag">{stale ? `Earlier inputs r${candidate.problemRevisionId}` : 'Current inputs'} · {candidate.result.status}</span><button disabled={busy || candidate.result.status !== 'feasible' || candidate.id === study.baselineCandidateId} onclick={saveBaseline}>{candidate.id === study.baselineCandidateId ? 'Saved baseline' : 'Save baseline'}</button>{/if}
      {#if candidate?.result.metrics}<div class="metrics"><span><small>Makespan</small><strong>{elapsed(candidate.result.metrics.makespan)}</strong></span><span><small>Weighted tardiness</small><strong>{candidate.result.metrics.weightedTardiness}</strong></span></div>{/if}
    </section>
    {#if stale}<p class="warning">This candidate retains its original inputs. The inspector edits current inputs r{revision.id}; calculate again to schedule those changes.</p>{/if}
    {#if candidate && candidate.result.status !== 'feasible'}<div class="warning"><strong>{candidate.result.status === 'unknown' ? 'No complete feasible candidate was found within this calculation.' : `This candidate is ${candidate.result.status}.`}</strong><ul>{#each candidate.result.issues as issue}<li>{issue.message}</li>{/each}</ul></div>{/if}
    <div class="workbench">
      <div class="schedule-column">
        <section class="panel schedule" aria-labelledby="schedule-title">
          <div class="panel-heading"><h2 id="schedule-title">Schedule</h2><a class="inspector-link" href="#activity-inspector">Inspect selected activity →</a><label class="horizon-toggle"><input type="checkbox" bind:checked={fullHorizon} /> Full planning horizon</label><span class="subtle">{revision.sourceEpochAt ? 'Elapsed from Study source epoch · seconds' : 'Authored elapsed seconds'}</span></div>
          <div class="legend"><span><i class="planned"></i>Forecast</span><span><i class="actual"></i>Actual / started</span>{#if baseline}<span><i class="baseline"></i>Saved baseline</span>{/if}</div>
          <div class="timeline-scroll" role="region" aria-label="Activity timeline; horizontally scrollable on narrow screens">
            <div class="timeline">
              <div class="timeline-axis"><span>Activity</span><div><span>{elapsed(timelineHorizon.start)}</span><span>{elapsed(Math.round((timelineHorizon.start + timelineHorizon.end) / 2))}</span><span>{elapsed(timelineHorizon.end)}</span></div></div>
              {#each displayedProblem.priorityOrder as id}
                {@const item = displayedProblem.activities.find(value => value.id === id)}
                {@const placement = candidate?.result.placements.find(value => value.activityId === id)}
                {@const basePlacement = baseline?.result.placements.find(value => value.activityId === id)}
                {#if item}<button class="timeline-row" class:selected={selectedActivityId === id} onclick={() => selectActivity(id)} aria-pressed={selectedActivityId === id} aria-label={`${item.title}${placement ? `, ${elapsed(placement.start)} to ${elapsed(placement.end)}` : ', not scheduled'}`}><span class="row-title" title={item.title}><strong>{item.id}</strong><span>{item.title}</span></span><span class="track">{#if basePlacement}{@const position = barPosition(timelineHorizon, basePlacement)}<span class="baseline-bar" style:left={`${position.left}%`} style:width={`${position.width}%`}></span>{/if}{#if placement}{@const position = barPosition(timelineHorizon, placement)}<span class="bar" class:actual={placement.kind !== 'planned'} class:milestone={placement.start === placement.end} style:left={`${position.left}%`} style:width={`${position.width}%`}></span><span class="sr-only">{placement.start} to {placement.end} seconds</span>{:else}<span class="unscheduled">Not scheduled</span>{/if}</span></button>{/if}
              {/each}
            </div>
          </div>
          <div class="table-scroll"><table><caption class="sr-only">Activities in priority order. Select an activity to inspect or edit it.</caption><thead><tr><th scope="col">Activity</th><th scope="col">Duration</th><th scope="col">Start → finish</th><th scope="col">Resource demand</th></tr></thead><tbody>{#each displayedProblem.priorityOrder as id}{@const item = displayedProblem.activities.find(value => value.id === id)}{@const placement = candidate?.result.placements.find(value => value.activityId === id)}{#if item}<tr class:selected={selectedActivityId === id}><th scope="row"><button onclick={() => selectActivity(id)} aria-pressed={selectedActivityId === id}>{item.title}<small>{item.progress.kind} · {item.modeId}</small></button></th><td>{elapsed(item.durationSeconds)}</td><td>{placement ? `${elapsed(placement.start)} → ${elapsed(placement.end)}` : '—'}</td><td>{item.demands.map(demand => `${displayedProblem.supplies.find(value => value.id === demand.supplyId)?.title ?? demand.supplyId} × ${demand.amount}`).join(', ') || 'Milestone / no capacity'}</td></tr>{/if}{/each}</tbody></table></div>
          <p class="footnote">Serial heuristic · elapsed time · finish-to-start links · renewable capacity. A feasible result is checked against these inputs; it is not a proof of optimality.</p>
        </section>
        <section class="panel" aria-labelledby="alternatives-title">
          <div class="panel-heading"><h2 id="alternatives-title">Candidates & trade-offs</h2><button disabled={busy || comparedIds.length < 2} onclick={compare}>Compare selected ({comparedIds.length})</button></div>
          {#if !study.candidates.length}<p class="hint">Calculate a candidate, then change priorities or assumptions and calculate another alternative.</p>{:else}<div class="table-scroll"><table><thead><tr><th scope="col">Compare</th><th scope="col">Candidate</th><th scope="col">Input revision</th><th scope="col">Makespan (s)</th><th scope="col">Weighted tardiness</th>{#each activityObjectives as objective}{#if 'activityId' in objective}<th scope="col">{problem.activities.find(item => item.id === objective.activityId)?.title ?? objective.activityId}<br />{objective.metric === 'activity-completion' ? 'Completion (s)' : 'Tardiness (s)'}</th>{/if}{/each}</tr></thead><tbody>{#each study.candidates as item}<tr><td><input type="checkbox" aria-label={`Compare ${candidateLabel(item)}`} checked={comparedIds.includes(item.id)} onchange={event => toggleComparison(item.id, event.currentTarget.checked)} /></td><th scope="row"><button onclick={() => { selectedCandidateId = item.id }}>{candidateLabel(item)}{item.id === study.baselineCandidateId ? ' · baseline' : ''}<small>{item.result.status}</small></button></th><td>r{item.problemRevisionId}{item.problemRevisionId !== revision.id ? ' · earlier' : ''}</td><td>{item.result.metrics?.makespan ?? '—'}</td><td>{item.result.metrics?.weightedTardiness ?? '—'}</td>{#each activityObjectives as objective}{#if 'activityId' in objective}<td>{(objective.metric === 'activity-completion' ? item.result.metrics?.completionTimes[objective.activityId] : item.result.metrics?.tardiness[objective.activityId]) ?? '—'}</td>{/if}{/each}</tr>{/each}</tbody></table></div>{/if}
          {#if comparison}<div class="comparison"><p>{comparison.comparable ? 'The selected candidates share a mathematical problem. Objective order and tolerances determine ranking.' : 'These candidates use different input problems. Compare raw metrics with their assumptions; no dominance is asserted.'}</p>{#each comparison.pairs as pair}<p><strong>{candidateLabel(study.candidates.find(item => item.id === pair.left)!)} ↔ {candidateLabel(study.candidates.find(item => item.id === pair.right)!)}</strong>: {pair.warning ?? (pair.lexicographic === 0 ? 'tied within objective tolerances' : pair.lexicographic === -1 ? 'left ranks first' : 'right ranks first')}{pair.leftDominates ? ' · left dominates selected objectives' : pair.rightDominates ? ' · right dominates selected objectives' : ''}</p>{/each}</div>{/if}
          {#if candidate?.result.metrics}<details><summary>All raw objective metrics</summary><pre>{JSON.stringify(candidate.result.metrics, null, 2)}</pre></details>{/if}
        </section>
        <section class="panel" aria-labelledby="basis-title"><div class="panel-heading"><h2 id="basis-title">Source & research basis</h2>{#if revision.basis}<a target="_parent" href={`/workspaces/${encodeURIComponent(workspaceId)}?world=${encodeURIComponent(revision.basis.source.id)}`}>Open source World →</a>{/if}</div>{#if revision.basis}<p>Study source epoch: <time datetime={revision.sourceEpochAt}>{revision.sourceEpochAt}</time>.<br />Captured at simulation {new Date(revision.basis.simulationAt).toLocaleString()}; observed {new Date(revision.basis.observedAt).toLocaleString()}. Inputs and candidates retain this evidence.</p><p class="hint">Refresh explicitly to read current World facts. Authored overrides stay visible as assumptions. Planning does not dispatch activities or change the World.</p>{:else}<p>This Study has authored inputs and no captured World basis.</p>{/if}<details><summary>Retained source facts ({revision.basis?.subjects.reduce((sum, subject) => sum + subject.facts.length, 0) ?? 0})</summary>{#each revision.basis?.subjects ?? [] as subject}<h3>{subject.label}</h3><dl class="facts">{#each subject.facts as fact}<div><dt>{fact.label}<small>{fact.basis} · {fact.semantic}</small></dt><dd>{String(fact.value)} {fact.unit ?? ''}</dd></div>{/each}</dl>{/each}</details><details><summary>Explicit temporal bindings ({revision.sourceBindings.length})</summary><p class="hint">These bindings give owner facts a planning meaning. Refresh updates bound values; an authored override removes the corresponding binding.</p><ul>{#each revision.sourceBindings as binding}<li>{revision.basis?.subjects.flatMap(subject => subject.facts).find(fact => fact.id === binding.factId)?.label ?? binding.factId} → {bindingTargetLabel(binding)} · {binding.target.kind}</li>{/each}</ul></details><details><summary>All authored assumptions ({revision.assumptions.length})</summary>{#each revision.assumptions as assumption}<p><strong>{assumption.label}</strong>: {String(assumption.value)} {assumption.unit ?? ''}<br /><span class="subtle">{assumption.rationale ?? 'No rationale supplied.'}</span></p>{/each}</details></section>
      </div>
      <aside id="activity-inspector" class="inspector panel" aria-label="Activity and input inspector"><a class="inspector-link" href="#schedule-title">← Back to schedule</a>
        {#if activity}<p class="eyebrow">Current inputs · r{revision.id}</p><h2>{activity.title}</h2><p class="subtle">{activity.progress.kind} · {activity.id}</p>
          <div class="priority-controls"><span>Priority {problem.priorityOrder.indexOf(activity.id) + 1} of {problem.activities.length}</span><button aria-label="Move activity earlier in priority order" disabled={busy || problem.priorityOrder.indexOf(activity.id) === 0} onclick={() => move(-1)}>↑ Earlier</button><button aria-label="Move activity later in priority order" disabled={busy || problem.priorityOrder.indexOf(activity.id) === problem.activities.length - 1} onclick={() => move(1)}>↓ Later</button></div>
          <p class="hint">Priority selects the next eligible activity. Dependencies and capacity still constrain its start.</p>
          <form onsubmit={event => { event.preventDefault(); void saveActivity() }}>
            <fieldset disabled={busy}><legend>Activity inputs</legend><label>Chosen method <input disabled={activity.progress.kind !== 'planned'} bind:value={method} required /></label><div class="field-pair"><label>Duration (seconds)<input disabled={activity.progress.kind !== 'planned'} type="number" min="0" step="1" value={duration} oninput={event => { duration = event.currentTarget.value } } required /></label><label>Tardiness weight<input type="number" min="0" step="1" value={weight} oninput={event => { weight = event.currentTarget.value } } required /></label></div><label>Earliest start (seconds)<input type="number" min="0" step="1" value={release} oninput={event => { release = event.currentTarget.value } } placeholder="Horizon start" /></label><div class="field-pair"><label>Due (seconds)<input type="number" min="0" step="1" value={due} oninput={event => { due = event.currentTarget.value } } placeholder="No due date" /></label><label>Latest finish (seconds)<input type="number" min="0" step="1" value={latestFinish} oninput={event => { latestFinish = event.currentTarget.value } } placeholder="Horizon end" /></label></div><p class="hint">Due dates measure tardiness; latest finish is a hard limit. Overriding a bound duration makes it an authored assumption; refresh will preserve it.</p>{#if activity.progress.kind === 'started'}<label>Remaining forecast (seconds)<input type="number" min="0" step="1" value={remaining} oninput={event => { remaining = event.currentTarget.value }} placeholder="Unknown remaining work" /></label><p class="hint">Actual start and committed resources are preserved. Blank remaining work means unknown.</p>{/if}<h3>Chosen resources</h3><p class="hint">Enter demand for each resource; 0 or blank removes it.</p>{#each problem.supplies as supply}<label class="demand-label">{supply.title}<input disabled={activity.progress.kind !== 'planned'} type="number" min="0" step="1" value={demands[supply.id] ?? ''} oninput={event => { demands = { ...demands, [supply.id]: event.currentTarget.value } }} aria-label={`${supply.title} demand`} /></label>{/each}<label>Reason for authored override<textarea bind:value={rationale} rows="2" placeholder="Required when overriding timing or capacity"></textarea></label><button class="primary" type="submit">Save activity inputs</button></fieldset>
          </form>
          <details open><summary>Dependencies & actual history</summary><ul>{#each problem.precedences.filter(link => link.successorId === activity.id) as link}<li>After {problem.activities.find(item => item.id === link.predecessorId)?.title ?? link.predecessorId} finishes{link.lagSeconds ? ` + ${elapsed(link.lagSeconds)}` : ''}</li>{:else}<li>No predecessor links.</li>{/each}</ul>{#if activity.progress.kind !== 'planned'}<p>Actual start: {elapsed(activity.progress.actualStart)}.{#if activity.progress.kind === 'completed'} Actual finish: {elapsed(activity.progress.actualFinish)}.{:else} Remaining forecast: {activity.progress.remainingSeconds === null ? 'unknown' : elapsed(activity.progress.remainingSeconds)} at {elapsed(activity.progress.asOf)}.{/if}</p>{/if}</details>
          <details><summary>Evidence for this activity</summary>{#each selectedFacts as subject}<h3>{subject.label}</h3><dl class="facts">{#each subject.facts as fact}<div><dt>{fact.label}<small>{fact.basis}</small></dt><dd>{String(fact.value)} {fact.unit ?? ''}</dd></div>{/each}</dl>{/each}{#each selectedAssumptions as assumption}<p><strong>{assumption.label}</strong>: {String(assumption.value)} {assumption.unit ?? ''}<br /><span class="subtle">{assumption.rationale ?? ''}</span></p>{/each}</details>
        {/if}
        <details><summary>Resource capacity windows</summary><form onsubmit={event => { event.preventDefault(); void saveCapacity() }}><fieldset disabled={busy}><label>Resource<select value={selectedSupplyId} onchange={event => hydrateSupply(event.currentTarget.value)}>{#each problem.supplies as supply}<option value={supply.id}>{supply.title}</option>{/each}</select></label>{#each capacitySegments as segment, index}<div class="capacity-fields"><label>Start (s)<input type="number" min="0" step="1" value={segment.start} oninput={event => { segment.start = event.currentTarget.value } } required /></label><label>End (s)<input type="number" min="0" step="1" value={segment.end} oninput={event => { segment.end = event.currentTarget.value } } required /></label><label>Capacity<input type="number" min="0" step="1" value={segment.capacity} oninput={event => { segment.capacity = event.currentTarget.value } } required /></label><button type="button" aria-label={`Remove capacity window ${index + 1}`} onclick={() => { capacitySegments = capacitySegments.filter((_, item) => item !== index) }}>×</button></div>{/each}<button type="button" onclick={() => { capacitySegments = [...capacitySegments, { start: String(problem.horizon.start), end: String(problem.horizon.end), capacity: '1' }] }}>Add window</button><p class="hint">Capacity is zero outside these half-open windows. Windows may not overlap.</p><label>Reason for override<textarea bind:value={rationale} rows="2" required></textarea></label><button type="submit" class="primary">Save capacity inputs</button></fieldset></form></details>
        <details><summary>Objectives & tolerances</summary><p class="hint">Objectives are ranked in array order. This research editor accepts the published objective schema; values remain separate from activity priority.</p><form onsubmit={event => { event.preventDefault(); void saveObjectives() }}><label>Objective definitions<textarea class="code" bind:value={objectiveText} rows="12" spellcheck="false"></textarea></label><p class="hint">Metrics: makespan, weighted-tardiness, activity-completion or activity-tardiness. Each requires direction and tolerance; activity metrics also require activityId.</p><button disabled={busy} type="submit">Save objectives</button></form></details>
        <details><summary>Retained revisions & storage</summary><p>{study.revisions.length} immutable input revisions; {study.candidates.length} retained candidates. Saved in this Workspace until the Study is deleted. A baseline selects a retained candidate.</p><ul>{#each study.revisions as item}<li>r{item.id} · {new Date(item.createdAt).toLocaleString()} · as of {elapsed(item.problem.asOf)}</li>{/each}</ul></details>
      </aside>
    </div>
  {/if}
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; color: #203b36; background: #f6f7f3; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; }
  :global(button), :global(input), :global(select), :global(textarea) { font: inherit; }
  :global(button), :global(a), :global(input), :global(select), :global(textarea), :global(summary) { -webkit-tap-highlight-color: transparent; }
  :global(button:focus-visible), :global(a:focus-visible), :global(input:focus-visible), :global(select:focus-visible), :global(textarea:focus-visible), :global(summary:focus-visible), .timeline-scroll:focus-visible { outline: 3px solid #cc8055; outline-offset: 2px; }
  main { max-width: 1800px; margin: 0 auto; padding: 24px; }
  h1, h2, h3, p { margin-top: 0; } h1 { font-size: clamp(23px, 2.2vw, 32px); line-height: 1.2; letter-spacing: -.025em; margin-bottom: 8px; font-weight: 600; } h2 { font-size: 17px; margin-bottom: 12px; font-weight: 600; } h3 { font-size: 14px; margin-bottom: 8px; } p { margin-bottom: 12px; }
  a { color: #236354; text-underline-offset: 3px; } button { cursor: pointer; min-height: 36px; padding: 6px 11px; color: #244b40; background: #fff; border: 1px solid #cbd7ce; border-radius: 6px; font-weight: 500; line-height: 1.3; } button:hover:not(:disabled) { background: #edf4ed; border-color: #94b3a1; } button:disabled { opacity: .5; cursor: default; } button.primary { background: #285e4d; color: #fff; border-color: #285e4d; } button.primary:hover:not(:disabled) { background: #1f4e3e; } input, select, textarea { width: 100%; min-width: 0; padding: 7px 9px; border: 1px solid #cbd7ce; border-radius: 5px; background: #fff; color: #203b36; } textarea { resize: vertical; } label { display: grid; gap: 5px; font-size: 12px; font-weight: 500; } small { display: block; font-size: 11px; font-weight: 400; color: #687b70; }
  .library { max-width: 1060px; margin: 24px auto; } .eyebrow { color: #527363; text-transform: uppercase; letter-spacing: .09em; font-size: 10px; font-weight: 700; margin-bottom: 9px; } .intro { font-size: 17px; max-width: 720px; color: #5a6e62; margin-bottom: 36px; } .demo-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 12px; } .demo-card { background: #fff; border: 1px solid #d9e2d8; border-radius: 10px; padding: 24px; display: flex; flex-direction: column; align-items: flex-start; box-shadow: 0 2px 4px #203b3603; } .demo-card h3 { font-size: 20px; } .demo-card p:not(.eyebrow) { color: #5a6e62; flex: 1; } .demo-card button span { padding-left: 20px; } .library > h2 { margin-top: 32px; } .count { color: #738276; font-size: 12px; margin-left: 6px; } .study-list { list-style: none; padding: 0; } .study-list li { border-top: 1px solid #d9e2d8; } .study-list a { padding: 16px 0; display: flex; justify-content: space-between; gap: 20px; text-decoration: none; }
  .study-header { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 12px; } .back { font-size: 12px; text-decoration: none; display: inline-block; margin-bottom: 12px; } .title-line { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; } .title-line h1 { margin: 0; } .subtle, .hint { color: #687b70; } .study-header p { margin: 6px 0 0; font-size: 12px; } .actions { display: flex; gap: 8px; flex-shrink: 0; } .tag { display: inline-block; white-space: nowrap; font-size: 10px; padding: 3px 7px; border-radius: 4px; color: #526f5d; background: #eaf0e5; border: 1px solid #d8e2d4; } .tag.stale { color: #8a5a26; background: #fff1d8; border-color: #ead7b5; } .announcement { font-size: 12px; color: #386b4e; min-height: 0; margin: 0; } .announcement:not(:empty) { padding: 10px 0; } .error, .warning { padding: 12px 14px; border-radius: 6px; margin: 12px 0; border: 1px solid #e5c9bc; background: #fff0e9; color: #854c39; } .warning { background: #fff7e7; border-color: #e8d9b9; color: #806638; font-size: 12px; } .error { overflow-wrap: anywhere; } .warning ul { margin-bottom: 0; } .candidate-strip { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; padding: 14px 16px; background: #eef2ea; border: 1px solid #d9e2d3; border-radius: 8px; margin: 12px 0 20px; } .candidate-strip label { min-width: 240px; max-width: 100%; } .candidate-strip .tag { margin-bottom: 7px; } .metrics { display: flex; gap: 24px; margin-left: auto; } .metrics strong { font-size: 20px; font-weight: 600; } .metrics small { margin-bottom: 0; }
  .workbench { display: grid; grid-template-columns: minmax(0, 1fr) 338px; gap: 20px; align-items: start; } .schedule-column { display: grid; gap: 20px; min-width: 0; } .panel { background: #fff; border: 1px solid #d9e2d8; border-radius: 8px; padding: 18px; min-width: 0; } .panel-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; } .panel-heading h2 { margin: 0; } .panel-heading > span, .panel-heading a { font-size: 11px; } .horizon-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; margin-left: auto; } .horizon-toggle input { width: 13px; height: 13px; min-height: 0; } .legend { display: flex; gap: 16px; flex-wrap: wrap; color: #708174; font-size: 10px; margin-bottom: 12px; } .legend span { display: inline-flex; align-items: center; gap: 5px; } .legend i { width: 16px; height: 7px; background: #76a98c; border-radius: 2px; } .legend i.actual { background: #385e5e; } .legend i.baseline { background: #d4b38d; height: 3px; } .timeline-scroll { overflow-x: auto; margin: 0 -2px 16px; } .timeline { min-width: 530px; } .timeline-axis, .timeline-row { display: grid; grid-template-columns: 170px 1fr; gap: 10px; align-items: center; } .timeline-axis { padding: 0 8px 8px; color: #738477; font-size: 10px; border-bottom: 1px solid #dce5da; } .timeline-axis > div { display: flex; justify-content: space-between; } .timeline-row { width: 100%; padding: 5px 8px; border: 0; border-bottom: 1px solid #edf1eb; border-radius: 0; background: transparent; text-align: left; min-height: 39px; } .timeline-row.selected { background: #edf5ec; box-shadow: inset 3px 0 #458367; } .row-title strong { display: block; font-size: 10px; font-weight: 600; line-height: 1.2; } .row-title > span { display: block; overflow: hidden; text-overflow: ellipsis; font-size: 10px; font-weight: 400; line-height: 1.3; } .inspector-link { display: none; } .row-title { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #3c5949; } .track { position: relative; display: block; height: 26px; background-image: linear-gradient(to right, #e4eae2 1px, transparent 1px); background-size: 25% 100%; border-right: 1px solid #e4eae2; } .bar { position: absolute; top: 5px; height: 15px; min-width: 3px; background: #76a98c; border: 1px solid #60967a; border-radius: 3px; } .bar.actual { background: #385e5e; border-color: #385e5e; } .bar.milestone { height: 10px; min-width: 10px; max-width: 10px; top: 8px; transform: translateX(-5px) rotate(45deg); border-radius: 1px; } .baseline-bar { position: absolute; top: 22px; height: 3px; min-width: 3px; background: #d4b38d; } .unscheduled { display: block; color: #a1aca0; font-size: 10px; padding: 4px 8px; }
  .table-scroll { overflow-x: auto; } table { width: 100%; border-collapse: collapse; text-align: left; font-size: 11px; } th, td { padding: 8px; border-bottom: 1px solid #e7ece3; vertical-align: top; } thead th { color: #758576; font-size: 10px; font-weight: 500; white-space: nowrap; } tbody th { font-weight: 500; } td { color: #5f7264; } th button { background: transparent; border: 0; padding: 0; min-height: 25px; text-align: left; font-size: 11px; font-weight: 500; } th button small { margin-top: 3px; font-size: 10px; } tr.selected { background: #f0f6ed; } input[type='checkbox'] { width: 17px; height: 17px; min-height: 0; accent-color: #39735b; } .footnote, .hint { font-size: 11px; } .footnote { color: #839080; margin: 12px 0 0; } .comparison { margin-top: 12px; padding: 12px; border-left: 3px solid #a4bda4; background: #f5f8f0; font-size: 12px; } .comparison p:last-child { margin-bottom: 0; }
  .inspector { font-size: 12px; } .inspector h2 { font-size: 19px; line-height: 1.3; margin-bottom: 3px; } .inspector > .eyebrow { margin-bottom: 7px; } .priority-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 16px; } .priority-controls span { width: 100%; color: #6e806f; font-size: 11px; } .priority-controls button { font-size: 11px; min-height: 30px; } .inspector .hint { margin: 8px 0 12px; } fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 10px; min-width: 0; } legend { font-size: 12px; font-weight: 600; margin-bottom: 12px; padding: 0; } .field-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; } fieldset h3 { margin: 4px 0 -8px; } fieldset > .hint { margin: 2px 0; } .demand-label { grid-template-columns: minmax(0, 1fr) 68px; align-items: center; } .capacity-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) 26px; gap: 4px; align-items: end; } .capacity-fields button { padding: 0; width: 26px; } details { border-top: 1px solid #e1e8db; margin-top: 16px; padding-top: 12px; } summary { cursor: pointer; font-size: 12px; font-weight: 500; } details[open] > summary { margin-bottom: 12px; } details h3 { margin-top: 14px; } details p { font-size: 12px; overflow-wrap: anywhere; } details ul { padding-left: 18px; color: #687b70; font-size: 11px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f5f7f1; padding: 10px; font-size: 10px; } .facts { margin: 0; } .facts > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; border-bottom: 1px solid #edf0e8; padding: 7px 0; font-size: 11px; } .facts dt { color: #526c57; } .facts dd { margin: 0; color: #304b3d; text-align: right; overflow-wrap: anywhere; } .code { font-family: ui-monospace, monospace; font-size: 11px; } .loading { margin: 24px; color: #6d8070; } .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 1100px) { main { padding: 18px; } .workbench { grid-template-columns: minmax(0, 1fr) 300px; gap: 14px; } .panel { padding: 14px; } .metrics { margin-left: 0; } }
  @media (max-width: 820px) { .inspector-link { display: inline; font-size: 11px; } .workbench { grid-template-columns: minmax(0, 1fr); } .inspector { max-width: none; } .study-header { align-items: flex-start; flex-direction: column; gap: 12px; } .actions { width: 100%; } .actions button { flex: 1; } .candidate-strip { align-items: center; } .candidate-strip label { flex: 1; } .demo-grid { grid-template-columns: 1fr; } .library { margin: 12px auto; } .field-pair { max-width: 480px; } .demand-label { max-width: 480px; } }
  @media (max-width: 480px) { main { padding: 12px; } .panel { padding: 12px; } .candidate-strip { padding: 12px; gap: 10px; } .candidate-strip label { width: 100%; min-width: 0; flex-basis: 100%; } .metrics { width: 100%; } .metrics strong { font-size: 18px; } .title-line .tag { font-size: 9px; } .study-list a { flex-direction: column; gap: 4px; } button, input, select { min-height: 40px; } .timeline-row { min-height: 42px; } .demo-card { padding: 20px; } .panel-heading > button { width: 100%; } th, td { padding: 8px 6px; } }
</style>
