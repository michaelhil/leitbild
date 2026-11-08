import assert from 'node:assert/strict'
import { workspaceIdSchema, workspaceResourceReferenceSchema, type WorkspaceRoomScope, type WorkspaceResourceReference } from '../packages/contracts/src/index.ts'
import { createWorkspaceCapabilityTools } from '../apps/agents/src/tools/built-in/workspace-capability-tools.ts'
import { studySchema, currentProblemRevision, type Study } from '../apps/planning/src/study-model.ts'

/** Real public-Host integration exercise. No provider, browser, maps or fake owner data. */
export const exercisePlanningLab = async (origin: string, keep = false) => {
  const url = new URL(origin)
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:', 'Use an isolated local stack; this exercise creates and deletes Workspaces')
  const startedAt = new Date().toISOString(), elapsedStart = performance.now()
  const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) })
    const text = await response.text()
    const value = text ? JSON.parse(text) as any : undefined
    return { status: response.status, value }
  }
  const created = await request('/api/workspaces', { name: 'Planning laboratory acceptance' })
  assert.equal(created.status, 201)
  const workspace = created.value.workspace
  const workspaceId = workspaceIdSchema.parse(workspace.id), base = `/api/workspaces/${workspaceId}`
  const actor = { kind: 'human', id: 'planning-operations', displayName: 'Planning operations review' }
  const rawCall = (id: string, input: unknown, resource?: WorkspaceResourceReference) => request(`${base}/capabilities/${id}/invoke`, { input, actor, ...(resource ? { resource } : {}) })
  const call = async (id: string, input: unknown, resource?: WorkspaceResourceReference): Promise<any> => {
    const response = await rawCall(id, input, resource)
    assert(response.status >= 200 && response.status < 300, `${id}: ${response.status} ${JSON.stringify(response.value)}`)
    assert(Object.hasOwn(response.value, 'result'), `${id}: omitted result`)
    return response.value.result
  }
  const cases: any[] = []
  const agentEvidence: any[] = []
  let complete = false
  try {
    assert.deepEqual(workspace.modules.map((entry: any) => entry.moduleId).sort(), ['agents', 'planning', 'world'])
    assert(workspace.modules.every((entry: any) => entry.status === 'ready'))
    const catalog = await request(`${base}/capabilities`)
    assert.equal(catalog.status, 200)
    for (const id of ['planning.demo.start', 'planning.study.read', 'planning.study.solve', 'planning.sources.refresh', 'world.einsatz.planning-basis', 'world.process-plant.planning-basis']) assert(catalog.value.capabilities.some((entry: any) => entry.id === id), `Missing discovery ${id}`)

    for (const name of ['response', 'component-work'] as const) {
      const caseStart = performance.now()
      const result = await call('planning.demo.start', { case: name })
      let study = studySchema.parse(result.study)
      const studyRef = workspaceResourceReferenceSchema.parse(result.resource)
      const revision = currentProblemRevision(study), basis = revision.basis!
      const run = basis.source
      assert.equal(study.candidates.length, 2)
      assert.equal(study.baselineCandidateId, study.candidates[0]!.id)
      assert(study.candidates.every(candidate => candidate.result.status === 'feasible'))
      assert.equal(revision.problem.axis.run.id, run.id)
      assert(basis.subjects.length > 0 && basis.subjects.every(subject => subject.facts.length > 0))
      for (const candidate of study.candidates) assert.equal((await call('planning.candidate.check', { candidateId: candidate.id }, studyRef)).check.status, 'satisfied')
      const compared = await call('planning.study.compare', { candidateIds: study.candidates.map(candidate => candidate.id) }, studyRef)
      assert.equal(compared.comparable, true)
      assert.equal(compared.pairs.length, 1)
      if (name === 'response') {
        assert.equal(compared.pairs[0].leftDominates, false)
        assert.equal(compared.pairs[0].rightDominates, false)
        assert.equal(compared.pairs[0].lexicographic, 1)
      } else {
        assert.equal(study.candidates[0]!.result.metrics!.makespan, 11100)
        assert.equal(study.candidates[1]!.result.metrics!.makespan, 9600)
        assert.equal(compared.pairs[0].rightDominates, true)
      }
      const reloaded = studySchema.parse(await call('planning.study.read', { section: 'all' }, studyRef))
      assert.deepEqual(reloaded, study)
      const evidence: any = { case: name, studyId: study.id, runId: run.id, studyUrl: `${origin}/workspaces/${workspaceId}?planning=${study.id}`, basis: { profile: basis.profile, digest: basis.digest, simulationAt: basis.simulationAt, sequence: basis.sequence, subjects: basis.subjects.map(subject => ({ locator: subject.locator, label: subject.label, kind: subject.kind, facts: subject.facts })) }, assumptions: revision.assumptions, initialCandidates: study.candidates, initialComparison: compared }

      const tools = (scope: WorkspaceRoomScope) => createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: origin, getRoomScope: roomId => roomId === 'acceptance-room' ? scope : undefined })
      const context = { callerId: 'acceptance-assistant', callerName: 'Acceptance assistant', roomId: 'acceptance-room' }
      const [explore, agentCall] = tools({ kind: 'workspace' })
      const discovery = await explore!.execute({ view: 'operations', target: { kind: 'resource', ref: studyRef }, operationIds: ['planning.study.read', 'planning.study.solve', 'planning.study.compare'], includeInputSchema: true, includeOutputSchema: true }, context)
      assert.equal(discovery.success, true)
      const operations = (discovery.data as any).operations
      assert.equal(operations.length, 3)
      assert(operations.every((entry: any) => entry.inputSchema && entry.outputSchema))
      const solveOutput = operations.find((entry: any) => entry.operationId === 'planning.study.solve').outputSchema
      assert(solveOutput.properties?.study && solveOutput.properties?.candidate, 'Agent discovery must describe actual solve output, not an empty object schema')
      const read = await agentCall!.execute({ calls: [{ key: 'problem', operationId: 'planning.study.read', target: { kind: 'resource', ref: studyRef }, input: { section: 'problem' } }] }, context)
      assert.equal((read.data as any).results[0].success, true)
      assert.equal((read.data as any).results[0].data.problemRevision.problem.axis.run.id, run.id)
      const [, studyOnly] = tools({ kind: 'resource', resource: studyRef })
      const outside = await studyOnly!.execute({ calls: [{ key: 'forbidden-refresh', operationId: 'planning.sources.refresh', input: { studyId: study.id, expectedRevision: study.revision } }] }, { ...context, focusedSubjects: [run] })
      assert.equal((outside.data as any).results[0].success, false)
      assert.equal(outside.effects?.[0]?.outcome, 'not-dispatched')
      const scopedRead = await studyOnly!.execute({ calls: [{ key: 'retained', operationId: 'planning.study.read', target: { kind: 'resource', ref: studyRef }, input: { section: 'evidence' } }] }, context)
      assert.equal((scopedRead.data as any).results[0].success, true)
      agentEvidence.push({ case: name, discovered: operations.map((entry: any) => entry.operationId), retainedRead: 'returned', studyOnlyRefresh: (outside.data as any).results[0].error, studyOnlyRefreshEffect: outside.effects?.[0] })

      if (name === 'response') {
        assert(revision.sourceBindings.some(binding => binding.factId.endsWith('/property/preparationSeconds')))
        assert.equal(revision.problem.activities.find(activity => activity.id === 'a-prepare')!.durationSeconds, 180)
        const changed = await call('world.einsatz.unit.adjust', { unitId: 'unit:planning-a', properties: { preparationSeconds: 420 }, reason: 'Planning acceptance: explicit owner temporal quantity change' }, run)
        evidence.ownerPropertyReceipt = changed
        const refreshed = await call('planning.sources.refresh', { studyId: study.id, expectedRevision: study.revision })
        assert.equal(refreshed.changed, true)
        study = studySchema.parse(refreshed.study)
        assert.notEqual(currentProblemRevision(study).basis!.digest, basis.digest)
        assert.equal(currentProblemRevision(study).problem.activities.find(activity => activity.id === 'a-prepare')!.durationSeconds, 420)
        assert(study.candidates.every(candidate => candidate.problemRevisionId !== study.currentProblemRevisionId))
        evidence.ownerPropertyRefresh = { durationSeconds: 420, problemRevisionId: study.currentProblemRevisionId, digest: currentProblemRevision(study).basis!.digest, priorCandidatesStale: true }

        await call('world.simulation-run.execution.advance', { minutes: 1, onComplete: 'pause' }, run)
        await waitForPause(call, run)
        study = studySchema.parse((await call('planning.sources.refresh', { studyId: study.id, expectedRevision: study.revision })).study)
        assert.equal(currentProblemRevision(study).problem.asOf, 60)
        const observed = currentProblemRevision(study)
        const actualProblem = structuredClone(observed.problem)
        actualProblem.activities.find(activity => activity.id === 'a-prepare')!.progress = { kind: 'started', actualStart: 0, asOf: 60, remainingSeconds: 240 }
        study = studySchema.parse(await call('planning.study.revise', { expectedRevision: study.revision, problem: actualProblem, assumptions: [...observed.assumptions, { id: 'manual-start-evidence', label: 'Researcher-recorded planning progress', value: 'Preparation actual start 0; remaining 240 at 60', rationale: 'Manual research evidence for the authored preparation activity, not an Einsatz preparation mechanic or inferred clinical event.' }] }, studyRef))
        const firstRepair = await call('planning.study.solve', { expectedRevision: study.revision }, studyRef)
        study = studySchema.parse(firstRepair.study)
        assert.equal(firstRepair.candidate.result.status, 'feasible')
        assert.equal(firstRepair.candidate.result.placements.find((placement: any) => placement.activityId === 'a-prepare').end, 300)
        await call('world.simulation-run.execution.advance', { minutes: 1, onComplete: 'pause' }, run)
        await waitForPause(call, run)
        study = studySchema.parse((await call('planning.sources.refresh', { studyId: study.id, expectedRevision: study.revision })).study)
        const latest = currentProblemRevision(study)
        const actual = latest.problem.activities.find(activity => activity.id === 'a-prepare')!.progress
        assert.deepEqual(actual, { kind: 'started', actualStart: 0, asOf: 120, remainingSeconds: null })
        const unresolved = await call('planning.study.solve', { expectedRevision: study.revision }, studyRef)
        study = studySchema.parse(unresolved.study)
        assert.equal(unresolved.candidate.result.status, 'unknown')
        const repaired = structuredClone(currentProblemRevision(study).problem)
        repaired.activities.find(activity => activity.id === 'a-prepare')!.progress = { kind: 'started', actualStart: 0, asOf: 120, remainingSeconds: 240 }
        study = studySchema.parse(await call('planning.study.revise', { expectedRevision: study.revision, problem: repaired }, studyRef))
        const secondRepair = await call('planning.study.solve', { expectedRevision: study.revision }, studyRef)
        study = studySchema.parse(secondRepair.study)
        const repairedPlacement = secondRepair.candidate.result.placements.find((placement: any) => placement.activityId === 'a-prepare')
        assert.equal(secondRepair.candidate.result.status, 'feasible')
        assert.deepEqual(repairedPlacement, { activityId: 'a-prepare', start: 0, end: 360, kind: 'started' })
        assert.equal(study.baselineCandidateId, result.study.baselineCandidateId)
        evidence.remainingRepair = { manualActualStart: 0, firstForecastEnd: 300, afterRefreshRemaining: null, unresolvedStatus: unresolved.candidate.result.status, repairedPlacement, retainedBaseline: study.baselineCandidateId }
      } else {
        assert.equal(revision.sourceBindings.length, 0)
        assert(revision.problem.activities.every(activity => activity.subject && basis.subjects.some(subject => subject.locator === activity.subject!.locator && subject.kind === 'pump')))
        const problem = structuredClone(revision.problem)
        const target = problem.activities.find(activity => activity.id === 'a-inspect')!
        target.durationSeconds = 2100
        const assumption = { id: 'research-inspection-estimate', label: 'Longer pump inspection estimate', value: 2100, unit: 's', activityId: target.id, subject: target.subject, rationale: 'Authored method estimate added without modifying plant schema or scheduler.' }
        const [, scopedCall] = tools({ kind: 'resource', resource: studyRef })
        const authored = await scopedCall!.execute({ calls: [{ key: 'revise', operationId: 'planning.study.revise', target: { kind: 'resource', ref: studyRef }, input: { expectedRevision: study.revision, problem, assumptions: [...revision.assumptions.filter(item => item.id !== `${target.id}-duration`), assumption] } }] }, context)
        assert.equal((authored.data as any).results[0].success, true)
        study = studySchema.parse((authored.data as any).results[0].data)
        const solved = await scopedCall!.execute({ calls: [{ key: 'solve', operationId: 'planning.study.solve', target: { kind: 'resource', ref: studyRef }, input: { expectedRevision: study.revision } }] }, context)
        assert.equal((solved.data as any).results[0].success, true)
        const solvedData = (solved.data as any).results[0].data
        study = studySchema.parse(solvedData.study)
        assert.equal(solvedData.candidate.result.status, 'feasible')
        const cross = await call('planning.study.compare', { candidateIds: [study.candidates[0]!.id, solvedData.candidate.id] }, studyRef)
        assert.equal(cross.comparable, false)
        assert(cross.pairs[0].warning)
        evidence.authoredEstimate = { durationSeconds: 2100, candidate: solvedData.candidate, comparisonWarning: cross.pairs[0].warning, agentReviseAndSolve: 'returned' }
      }
      const staleWrite = await rawCall('planning.study.solve', { expectedRevision: 1 }, studyRef)
      assert.equal(staleWrite.status, 409)
      assert.equal(staleWrite.value.error.code, 'study_revision_conflict')
      const finalRead = studySchema.parse(await call('planning.study.read', { section: 'all' }, studyRef))
      assert.deepEqual(finalRead, study)
      evidence.finalRevision = study.revision
      evidence.saveReload = 'exact'
      evidence.elapsedMs = Math.round(performance.now() - caseStart)
      cases.push(evidence)
    }
    // Deletion must fail closed for retained derived data, while a catalogue stays usable.
    const deniedCase = cases[1]!
    const deniedRun = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: deniedCase.runId })
    const deniedStudy = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'planning', type: 'planning.study', id: deniedCase.studyId })
    // Let the actual 30 s idle-close policy run. A catalogue must not restore a
    // World; opening this exact Study may deliberately restore it for permission.
    const beforeIdle = studySchema.parse(await call('planning.study.read', { section: 'all' }, deniedStudy))
    console.log('Checking the real 30-second World idle-close boundary…')
    await Bun.sleep(31_000)
    const coldQualification = await call('world.planning-source.qualify', { profile: 'process-plant', qualification: currentProblemRevision(beforeIdle).basis!.qualification, activation: 'loaded-only' }, deniedRun)
    assert.equal(coldQualification.allowed, false)
    assert.equal(coldQualification.code, 'source_unloaded')
    const passiveCatalog = await request(`${base}/resources`)
    assert.equal(passiveCatalog.status, 200)
    const coldDescriptor = passiveCatalog.value.resources.find((entry: any) => entry.ref.id === deniedStudy.id)
    assert.equal(coldDescriptor.title, 'Unavailable planning Study')
    assert.deepEqual(coldDescriptor.links, [])
    const stillCold = await call('world.planning-source.qualify', { profile: 'process-plant', qualification: currentProblemRevision(beforeIdle).basis!.qualification, activation: 'loaded-only' }, deniedRun)
    assert.equal(stillCold.code, 'source_unloaded')
    const explicitRead = studySchema.parse(await call('planning.study.read', { section: 'all' }, deniedStudy))
    assert.deepEqual(explicitRead, beforeIdle)
    deniedCase.idleRecovery = { waitedMs: 31_000, coldQualification: coldQualification.code, catalogue: 'redacted without loading', explicitStudyRead: 'retained inputs identical after permission-only source restoration' }
    if (!keep) {
      await call('world.simulation-run.delete', {}, deniedRun)
      const denied = await rawCall('planning.study.read', { section: 'all' }, deniedStudy)
      assert.equal(denied.status, 403)
      assert.equal(denied.value.error.code, 'planning_source_unavailable')
      const resources = await request(`${base}/resources`)
      assert.equal(resources.status, 200)
      const descriptor = resources.value.resources.find((entry: any) => entry.ref.id === deniedStudy.id)
      assert.equal(descriptor.title, 'Unavailable planning Study')
      assert.deepEqual(descriptor.links, [])
      deniedCase.deletedSource = 'retained content denied; catalogue redacted'
    }
    complete = true
    return { startedAt, completedAt: new Date().toISOString(), workspaceId, retained: keep, elapsedMs: Math.round(performance.now() - elapsedStart), cases, agentEvidence, limits: ['HTTP + real Agent tool adapters; no model inference test', 'Manual planning-progress evidence is explicit; no simulated preparation mechanic', 'Browser usability/screenshots require separate UI walkthrough', ...(keep ? ['Source deletion check skipped for retained screenshot Workspace'] : [])] }
  } finally {
    if (complete && !keep) {
      const deleted = await request(base, undefined, 'DELETE')
      assert.equal(deleted.status, 204)
    } else console.log(`Retained acceptance Workspace: ${origin}/workspaces/${workspaceId}`)
  }
}

const waitForPause = async (call: (id: string, input: unknown, resource: WorkspaceResourceReference) => Promise<any>, run: WorkspaceResourceReference) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const execution = await call('world.simulation-run.execution.read', {}, run)
    if (execution.playback === 'paused' && execution.acceleration?.status === 'completed') return
    if (execution.acceleration?.status === 'failed') throw new Error(execution.acceleration.error ?? 'World advancement failed')
    await Bun.sleep(50)
  }
  throw new Error('World did not finish its explicit advancement within 20 seconds')
}

if (import.meta.main) {
  const origin = process.argv[2]
  if (!origin) throw new Error('Usage: bun --no-env-file scripts/planning-lab-acceptance.ts http://127.0.0.1:PORT [report.json] [--keep]')
  const report = await exercisePlanningLab(origin, process.argv.includes('--keep'))
  const destination = process.argv[3]
  if (destination && destination !== '--keep') await Bun.write(destination, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ workspaceId: report.workspaceId, elapsedMs: report.elapsedMs, cases: report.cases.map((entry: any) => ({ case: entry.case, studyId: entry.studyId, candidates: entry.initialCandidates.map((candidate: any) => ({ id: candidate.id, metrics: candidate.result.metrics })) })), limits: report.limits }, null, 2))
}
