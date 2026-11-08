import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { accessContextSchema, planningSourceBasisSchema, planningSourceRequestSchema, workspaceIdSchema, type AccessContext, type PlanningSourceBasis } from '@leitbild/contracts'
import { planningProblemSchema, type PlanningProblem } from './model.ts'
import { createStudyStore } from './study-store.ts'
import { createPlanningService } from './service.ts'
import { createPlanningModuleApi } from './module-api.ts'
import { currentProblemRevision } from './study-model.ts'
import { planningError } from './errors.ts'
import type { PlanningSourceActivation } from './source-port.ts'

const workspaceId = workspaceIdSchema.parse('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
const source = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'research-run' }
const access = accessContextSchema.parse({ workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'human', id: 'researcher' } })
const sourceRequest = planningSourceRequestSchema.parse({ source, profile: 'einsatz' })
const epoch = '2026-11-08T08:00:00.000Z'
const basis = (duration = 20, simulationAt = epoch): PlanningSourceBasis => planningSourceBasisSchema.parse({
  source, profile: 'einsatz', observedAt: '2026-11-08T12:00:00.000Z', simulationAt, sequence: 1,
  subjects: [{ locator: 'unit:a', label: 'Unit A', kind: 'unit', facts: [{ id: 'unit:a/preparation', label: 'Preparation', semantic: 'quantity', value: duration, unit: 's', basis: 'observation' }] }],
  digest: duration.toString(16).padStart(64, '0'), qualification: { audience: 'shared-research', restrictionRevision: 0, epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectIds: ['unit:a'] },
})
const problem = (): PlanningProblem => planningProblemSchema.parse({
  profile: 'elapsed-fs', axis: { run: source, unit: 'second' }, horizon: { start: 0, end: 7200 }, asOf: 0,
  supplies: [{ id: 'slot', title: 'Receiving slot', segments: [{ start: 0, end: 7200, capacity: 1 }] }],
  activities: [
    { id: 'a', title: 'A', modeId: 'chosen', durationSeconds: 20, release: 30, demands: [{ supplyId: 'slot', amount: 1 }], tardinessWeight: 1, progress: { kind: 'planned' } },
    { id: 'b', title: 'B', modeId: 'chosen', durationSeconds: 25, release: 25, due: 45, demands: [{ supplyId: 'slot', amount: 1 }], tardinessWeight: 1, progress: { kind: 'planned' } },
  ], precedences: [], priorityOrder: ['b', 'a'], objectives: [{ metric: 'activity-completion', activityId: 'a', direction: 'minimize', tolerance: 0 }, { metric: 'activity-tardiness', activityId: 'b', direction: 'minimize', tolerance: 0 }],
})
const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
const setup = async () => {
  const folder = await mkdtemp(join(tmpdir(), 'planning-backend-test-')); folders.push(folder)
  const store = createStudyStore(folder)
  await store.provision(workspaceId)
  let currentBasis = basis(), allowed = true
  const sources = {
    capture: async () => currentBasis,
    qualify: async (_basis: PlanningSourceBasis, _access: AccessContext, _activation: PlanningSourceActivation) => ({ allowed, ...(allowed ? {} : { code: 'source_deleted', reason: 'Owner unavailable' }) }),
  }
  const service = createPlanningService({ store, sources })
  return { folder, store, service, sources, setBasis: (value: PlanningSourceBasis) => { currentBasis = value }, deny: () => { allowed = false } }
}

describe('Study persistence and revision semantics', () => {
  test('retains immutable inputs, candidates and baseline across save/reload; stale CAS cannot overwrite', async () => {
    const { service, store, folder } = await setup()
    let study = await service.create(workspaceId, { title: 'Handover research', problem: problem() })
    const firstProblem = structuredClone(currentProblemRevision(study).problem)
    const solved = await service.solve(workspaceId, study.id, study.revision, access)
    expect(solved.candidate.result.status).toBe('feasible'); study = solved.study
    study = await service.baseline(workspaceId, study.id, solved.candidate.id, study.revision, access)
    const revised = structuredClone(firstProblem); revised.priorityOrder.reverse()
    study = await service.revise(workspaceId, study.id, { expectedRevision: study.revision, problem: revised }, access)
    expect(study.revisions[0]?.problem).toEqual(firstProblem)
    expect(study.candidates[0]).toEqual(solved.candidate)
    await expect(service.solve(workspaceId, study.id, 1, access)).rejects.toMatchObject({ code: 'study_revision_conflict' })
    expect((await store.read(workspaceId, study.id)).candidates.length).toBe(1)
    const reopened = createStudyStore(folder)
    expect((await reopened.read(workspaceId, study.id)).baselineCandidateId).toBe(solved.candidate.id)
    expect((await reopened.read(workspaceId, study.id)).currentProblemRevisionId).toBe(2)
  })

  test('concurrent edits have one winner and do not lose a retained revision', async () => {
    const { service } = await setup()
    const study = await service.create(workspaceId, { title: 'Concurrent edit', problem: problem() })
    const results = await Promise.allSettled([1, 2].map(() => service.revise(workspaceId, study.id, { expectedRevision: 1, problem: problem() }, access)))
    expect(results.filter(result => result.status === 'fulfilled').length).toBe(1)
    expect((await service.read(workspaceId, study.id, access)).revisions.length).toBe(2)
  })

  test('explicit source binding gives an arbitrary seconds quantity duration meaning; refresh stales prior candidates', async () => {
    const fixture = await setup()
    let study = await fixture.service.createFromBasis(workspaceId, { title: 'Live source', problem: problem(), basis: basis(), request: sourceRequest, sourceBindings: [{ factId: 'unit:a/preparation', target: { kind: 'duration', activityId: 'a' } }] }, access)
    study = (await fixture.service.solve(workspaceId, study.id, study.revision, access)).study
    fixture.setBasis(basis(35))
    const refreshed = await fixture.service.refresh(workspaceId, { studyId: study.id, expectedRevision: study.revision }, access)
    expect(refreshed.changed).toBe(true)
    expect(currentProblemRevision(refreshed.study).problem.activities[0]?.durationSeconds).toBe(35)
    expect(refreshed.study.candidates[0]?.problemRevisionId).toBe(1)
    expect(refreshed.study.currentProblemRevisionId).toBe(2)
    expect(refreshed.study.revisions[0]?.basis?.subjects[0]?.facts[0]?.value).toBe(20)
    const unchanged = await fixture.service.refresh(workspaceId, { studyId: study.id, expectedRevision: refreshed.study.revision }, access)
    expect(unchanged.changed).toBe(false)
    expect(unchanged.study.revision).toBe(refreshed.study.revision)
  })

  test('refresh retains original epoch and never changes total duration into remaining work', async () => {
    const fixture = await setup()
    let study = await fixture.service.createFromBasis(workspaceId, { title: 'Progress', problem: problem(), basis: basis(), request: sourceRequest, sourceBindings: [{ factId: 'unit:a/preparation', target: { kind: 'duration', activityId: 'a' } }] }, access)
    const started = problem(); started.asOf = 10
    const activity = started.activities[0]; if (!activity) throw new Error('Activity absent')
    activity.release = 0; activity.progress = { kind: 'started', actualStart: 0, asOf: 10, remainingSeconds: 20 }
    study = await fixture.service.revise(workspaceId, study.id, { expectedRevision: study.revision, problem: started }, access)
    fixture.setBasis(basis(45, '2026-11-08T08:00:20.000Z'))
    const refreshed = await fixture.service.refresh(workspaceId, { studyId: study.id, expectedRevision: study.revision }, access)
    const current = currentProblemRevision(refreshed.study)
    expect(current.sourceEpochAt).toBe(epoch); expect(current.problem.asOf).toBe(20)
    expect(current.problem.activities[0]?.progress).toEqual({ kind: 'started', actualStart: 0, asOf: 20, remainingSeconds: null })
    expect(current.problem.activities[0]?.durationSeconds).toBe(20)
    const result = await fixture.service.solve(workspaceId, study.id, refreshed.study.revision, access)
    expect(result.candidate.result.status).toBe('unknown')
  })

  test('declared duration bindings reject contradictory creation and revision; an explicit unbind permits an override', async () => {
    const { service, store } = await setup()
    const sourceBindings = [{ factId: 'unit:a/preparation', target: { kind: 'duration' as const, activityId: 'a' } }]
    await expect(service.createFromBasis(workspaceId, { title: 'Contradiction', problem: problem(), basis: basis(30), request: sourceRequest, sourceBindings }, access)).rejects.toMatchObject({ code: 'source_binding_value_mismatch' })
    expect(await store.list(workspaceId)).toEqual([])
    const study = await service.createFromBasis(workspaceId, { title: 'Bound estimate', problem: problem(), basis: basis(), request: sourceRequest, sourceBindings }, access)
    const revised = problem(); revised.activities[0]!.durationSeconds = 19
    await expect(service.revise(workspaceId, study.id, { expectedRevision: 1, problem: revised }, access)).rejects.toMatchObject({ code: 'source_binding_value_mismatch' })
    expect((await store.read(workspaceId, study.id)).revision).toBe(1)
    const override = await service.revise(workspaceId, study.id, { expectedRevision: 1, problem: revised, sourceBindings: [], assumptions: [{ id: 'override', label: 'Authored preparation estimate', value: 19, unit: 's' }] }, access)
    expect(currentProblemRevision(override).sourceBindings).toEqual([])
    expect(currentProblemRevision(override).problem.activities[0]?.durationSeconds).toBe(19)
  })

  test('capacity binding requires identical explicit units at creation, revision and refresh', async () => {
    const fixture = await setup()
    const makeBasis = (value: number, unit?: string) => {
      const valueBasis = basis(value)
      valueBasis.subjects[0]!.facts = [{ id: 'unit:a/capacity', label: 'Capacity', semantic: 'capacity', value, basis: 'observation', ...(unit === undefined ? {} : { unit }) }]
      return valueBasis
    }
    const capacityProblem = problem(); capacityProblem.supplies[0]!.unit = '1'; capacityProblem.supplies[0]!.segments[0]!.capacity = 2
    const sourceBindings = [{ factId: 'unit:a/capacity', target: { kind: 'capacity' as const, supplyId: 'slot' } }]
    for (const ownerBasis of [makeBasis(2, 'kg/s'), makeBasis(2)]) {
      await expect(fixture.service.createFromBasis(workspaceId, { title: 'Invalid units', problem: capacityProblem, basis: ownerBasis, request: sourceRequest, sourceBindings }, access)).rejects.toMatchObject({ code: 'source_binding_unit_mismatch' })
    }
    const noSupplyUnit = structuredClone(capacityProblem); delete noSupplyUnit.supplies[0]!.unit
    await expect(fixture.service.createFromBasis(workspaceId, { title: 'Missing supply unit', problem: noSupplyUnit, basis: makeBasis(2, '1'), request: sourceRequest, sourceBindings }, access)).rejects.toMatchObject({ code: 'source_binding_unit_mismatch' })
    const study = await fixture.service.createFromBasis(workspaceId, { title: 'Crew count', problem: capacityProblem, basis: makeBasis(2, '1'), request: sourceRequest, sourceBindings }, access)
    const incompatible = structuredClone(capacityProblem); incompatible.supplies[0]!.unit = 'kg/s'
    await expect(fixture.service.revise(workspaceId, study.id, { expectedRevision: 1, problem: incompatible }, access)).rejects.toMatchObject({ code: 'source_binding_unit_mismatch' })
    fixture.setBasis(makeBasis(3, 'kg/s'))
    await expect(fixture.service.refresh(workspaceId, { studyId: study.id, expectedRevision: 1 }, access)).rejects.toMatchObject({ code: 'source_binding_unit_mismatch' })
    expect((await fixture.store.read(workspaceId, study.id)).revision).toBe(1)
  })

  test('a scalar capacity binding cannot erase authored unavailable windows; gaps survive refresh', async () => {
    const fixture = await setup()
    const makeBasis = (value: number) => {
      const valueBasis = basis(value)
      valueBasis.subjects[0]!.facts = [{ id: 'unit:a/capacity', label: 'Capacity', semantic: 'capacity', value, unit: '1', basis: 'observation' }]
      return valueBasis
    }
    const capacityProblem = problem(); capacityProblem.supplies[0]!.unit = '1'
    capacityProblem.supplies[0]!.segments = [{ start: 0, end: 100, capacity: 2 }, { start: 100, end: 200, capacity: 0 }, { start: 200, end: 7200, capacity: 2 }]
    const sourceBindings = [{ factId: 'unit:a/capacity', target: { kind: 'capacity' as const, supplyId: 'slot' } }]
    await expect(fixture.service.createFromBasis(workspaceId, { title: 'Ambiguous blackout', problem: capacityProblem, basis: makeBasis(2), request: sourceRequest, sourceBindings }, access)).rejects.toMatchObject({ code: 'source_binding_value_mismatch' })
    capacityProblem.supplies[0]!.segments.splice(1, 1)
    const study = await fixture.service.createFromBasis(workspaceId, { title: 'Explicit windows', problem: capacityProblem, basis: makeBasis(2), request: sourceRequest, sourceBindings }, access)
    const changedCapacity = structuredClone(capacityProblem); changedCapacity.supplies[0]!.segments[0]!.capacity = 5
    await expect(fixture.service.revise(workspaceId, study.id, { expectedRevision: 1, problem: changedCapacity }, access)).rejects.toMatchObject({ code: 'source_binding_value_mismatch' })
    fixture.setBasis(makeBasis(3))
    const refreshed = await fixture.service.refresh(workspaceId, { studyId: study.id, expectedRevision: 1 }, access)
    expect(currentProblemRevision(refreshed.study).problem.supplies[0]?.segments).toEqual([{ start: 0, end: 100, capacity: 3 }, { start: 200, end: 7200, capacity: 3 }])
  })

  test.each(['started', 'completed'] as const)('a revision preserves the exact subject of %s work', async kind => {
    const { service, store } = await setup()
    const committed = problem(); committed.asOf = 10
    const activity = committed.activities[0]!
    activity.release = 0; activity.subject = { resource: committed.axis.run, locator: 'unit:a' }
    activity.progress = kind === 'started' ? { kind, actualStart: 0, asOf: 10, remainingSeconds: 20 } : { kind, actualStart: 0, actualFinish: 10 }
    const study = await service.create(workspaceId, { title: 'Committed identity', problem: committed })
    for (const locator of ['unit:b', undefined]) {
      const changed = structuredClone(committed)
      if (locator === undefined) delete changed.activities[0]!.subject
      else changed.activities[0]!.subject = { resource: changed.axis.run, locator }
      await expect(service.revise(workspaceId, study.id, { expectedRevision: 1, problem: changed }, access)).rejects.toMatchObject({ code: 'committed_history_changed' })
    }
    expect((await store.read(workspaceId, study.id)).revision).toBe(1)
    const correction = structuredClone(committed); correction.activities[0]!.title = 'Corrected description'
    expect((await service.revise(workspaceId, study.id, { expectedRevision: 1, problem: correction }, access)).revision).toBe(2)
    const absentSubject = structuredClone(committed); delete absentSubject.activities[0]!.subject
    const anonymous = await service.create(workspaceId, { title: 'No committed subject', problem: absentSubject })
    await expect(service.revise(workspaceId, anonymous.id, { expectedRevision: 1, problem: committed }, access)).rejects.toMatchObject({ code: 'committed_history_changed' })
  })

  test('a source refresh cannot rewind manually authored progress or accept a new Run epoch', async () => {
    const fixture = await setup()
    let study = await fixture.service.createFromBasis(workspaceId, { title: 'Clock conflict', problem: problem(), basis: basis(), request: sourceRequest }, access)
    const started = problem(); started.asOf = 10; started.activities[0]!.release = 0
    started.activities[0]!.progress = { kind: 'started', actualStart: 0, asOf: 10, remainingSeconds: 20 }
    study = await fixture.service.revise(workspaceId, study.id, { expectedRevision: 1, problem: started }, access)
    await expect(fixture.service.refresh(workspaceId, { studyId: study.id, expectedRevision: study.revision }, access)).rejects.toMatchObject({ code: 'source_frame_behind_progress' })
    expect(currentProblemRevision(await fixture.store.read(workspaceId, study.id)).problem).toEqual(started)
    const replaced = basis(30, '2026-11-08T08:00:20.000Z'); replaced.qualification.epoch = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    fixture.setBasis(replaced)
    await expect(fixture.service.refresh(workspaceId, { studyId: study.id, expectedRevision: study.revision }, access)).rejects.toMatchObject({ code: 'source_epoch_changed' })
    expect((await fixture.store.read(workspaceId, study.id)).revision).toBe(study.revision)
  })

  test('source denial hides derived content and metadata but retains archive bytes', async () => {
    const fixture = await setup()
    const study = await fixture.service.createFromBasis(workspaceId, { title: 'Source sensitive label', problem: problem(), basis: basis(), request: sourceRequest }, access)
    fixture.deny()
    await expect(fixture.service.read(workspaceId, study.id, access)).rejects.toMatchObject({ code: 'planning_source_unavailable' })
    const api = createPlanningModuleApi({ service: fixture.service })
    const path = `http://planning/internal/workspaces/${workspaceId}/resources`
    const response = await api(new Request(path), new URL(path))
    const text = await response?.text()
    expect(text).not.toContain('Source sensitive label'); expect(text).not.toContain('research-run')
    expect(text).toContain('Unavailable planning Study')
    expect((await fixture.store.read(workspaceId, study.id)).title).toBe('Source sensitive label')
  })

  test.each([
    { status: 404, code: 'simulation_run_not_found' },
    { status: 409, code: 'simulation_run_not_loaded' },
    { status: 503, code: 'source_transport_unavailable' },
  ])('a thrown $code qualification leaves a healthy catalogue and no retained evidence disclosure', async ({ status, code }) => {
    const fixture = await setup()
    const unavailable = await fixture.service.createFromBasis(workspaceId, { title: 'Sensitive source title', problem: problem(), basis: basis(), request: sourceRequest }, access)
    const healthy = await fixture.service.create(workspaceId, { title: 'Healthy standalone Study', problem: problem() })
    fixture.sources.qualify = async () => { throw planningError(status, code, 'Private owner diagnostics and research-run') }
    await expect(fixture.service.read(workspaceId, unavailable.id, access)).rejects.toMatchObject({ code: 'planning_source_unavailable', message: 'The retained Study source is unavailable or no longer qualified for this shared audience' })
    expect((await fixture.service.list(workspaceId, access)).map(item => ({ id: item.study.id, available: item.available }))).toContainEqual({ id: healthy.id, available: true })
    const api = createPlanningModuleApi({ service: fixture.service })
    const url = new URL(`http://planning/internal/workspaces/${workspaceId}/resources`)
    const response = await api(new Request(url), url)
    expect(response?.status).toBe(200)
    const body = await response?.text()
    expect(body).toContain('Healthy standalone Study'); expect(body).toContain('Unavailable planning Study')
    expect(body).not.toContain('Sensitive source title'); expect(body).not.toContain('research-run'); expect(body).not.toContain('Private owner diagnostics')
  })

  test('malformed qualification contracts and unexpected defects remain visible', async () => {
    const fixture = await setup()
    await fixture.service.createFromBasis(workspaceId, { title: 'Contract check', problem: problem(), basis: basis(), request: sourceRequest }, access)
    fixture.sources.qualify = async () => ({ allowed: 'yes' } as never)
    await expect(fixture.service.list(workspaceId, access)).rejects.toMatchObject({ name: 'ZodError' })
    fixture.sources.qualify = async () => { throw planningError(502, 'invalid_host_response', 'Malformed Host JSON') }
    await expect(fixture.service.list(workspaceId, access)).rejects.toMatchObject({ code: 'invalid_host_response' })
    fixture.sources.qualify = async () => { throw new Error('Unexpected internal defect') }
    await expect(fixture.service.list(workspaceId, access)).rejects.toThrow('Unexpected internal defect')
  })

  test('catalogue qualification stays loaded-only while an explicit Study open may load its retained source', async () => {
    const fixture = await setup()
    const activations: PlanningSourceActivation[] = []
    fixture.sources.qualify = async (_basis, _access, activation) => { activations.push(activation); return { allowed: true } }
    const study = await fixture.service.createFromBasis(workspaceId, { title: 'Open archived evidence', problem: problem(), basis: basis(), request: sourceRequest }, access)
    expect(activations.splice(0)).toEqual(['load-if-needed'])
    await fixture.service.list(workspaceId, access)
    expect(activations.splice(0)).toEqual(['loaded-only'])
    await fixture.service.read(workspaceId, study.id, access)
    expect(activations).toEqual(['load-if-needed'])
  })

  test('a cold Study read restores its catalogue title without changing saved data or revealing a revoked source', async () => {
    const fixture = await setup()
    const study = await fixture.service.createFromBasis(workspaceId, { title: 'Restored Study', problem: problem(), basis: basis(), request: sourceRequest }, access)
    let loaded = false, revoked = false
    fixture.sources.qualify = async (_basis, _access, activation) => {
      if (revoked) return { allowed: false, code: 'source_not_qualified' }
      if (activation === 'load-if-needed') loaded = true
      return loaded ? { allowed: true } : { allowed: false, code: 'simulation_run_not_loaded' }
    }
    const api = createPlanningModuleApi({ service: fixture.service })
    const url = new URL(`http://planning/internal/workspaces/${workspaceId}/resources`)
    const catalogue = async () => (await api(new Request(url), url))!.text()
    expect(await catalogue()).not.toContain('Restored Study')
    expect(loaded).toBe(false)
    expect(await fixture.service.read(workspaceId, study.id, access)).toEqual(study)
    expect(await catalogue()).toContain('Restored Study')
    revoked = true
    await expect(fixture.service.read(workspaceId, study.id, access)).rejects.toMatchObject({ code: 'planning_source_unavailable' })
    expect(await catalogue()).not.toContain('Restored Study')
    expect(await catalogue()).toContain('Unavailable planning Study')
    expect(await fixture.store.read(workspaceId, study.id)).toEqual(study)
  })

  test('a capture completing after deletion cannot resurrect its Study or Workspace', async () => {
    const fixture = await setup()
    const study = await fixture.service.createFromBasis(workspaceId, { title: 'Deletion race', problem: problem(), basis: basis(), request: sourceRequest }, access)
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    fixture.sources.capture = async () => { entered(); await waiting; return basis(40) }
    const refresh = fixture.service.refresh(workspaceId, { studyId: study.id, expectedRevision: study.revision }, access)
    await started; await fixture.store.removeWorkspace(workspaceId); release()
    await expect(refresh).rejects.toMatchObject({ code: 'workspace_not_found' })
    expect(await fixture.store.hasWorkspace(workspaceId)).toBe(false)
  })

  test('alternative priority orders share a mathematical comparison, changed durations do not', async () => {
    const { service } = await setup()
    let study = await service.create(workspaceId, { title: 'Tradeoff', problem: problem() })
    const first = await service.solve(workspaceId, study.id, study.revision, access); study = first.study
    const reordered = problem(); reordered.priorityOrder.reverse()
    study = await service.revise(workspaceId, study.id, { expectedRevision: study.revision, problem: reordered }, access)
    const second = await service.solve(workspaceId, study.id, study.revision, access); study = second.study
    const compared = await service.compare(workspaceId, study.id, [first.candidate.id, second.candidate.id], access)
    expect(compared.sameProblem).toBe(false); expect(compared.comparable).toBe(true)
    expect(compared.pairs[0]).toMatchObject({ leftDominates: false, rightDominates: false })
    const changed = structuredClone(reordered); changed.activities[0]!.durationSeconds = 10
    study = await service.revise(workspaceId, study.id, { expectedRevision: study.revision, problem: changed }, access)
    const third = await service.solve(workspaceId, study.id, study.revision, access)
    expect((await service.compare(workspaceId, study.id, [first.candidate.id, third.candidate.id], access)).comparable).toBe(false)
  })
})

test('Module scope, canonical inspection, created Resources and query purity', async () => {
  const { service, store } = await setup()
  const api = createPlanningModuleApi({ service })
  const invoke = async (capabilityId: string, input: unknown, studyId?: string) => {
    const url = new URL(`http://planning/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`)
    const response = await api(new Request(url, { method: 'POST', body: JSON.stringify({ workspaceId, capabilityId, input, access, ...(studyId ? { resource: { workspaceId, moduleId: 'planning', type: 'planning.study', id: studyId } } : {}) }) }), url)
    if (!response) throw new Error('Module did not handle request')
    return { status: response.status, value: await response.json() }
  }
  const created = await invoke('planning.study.create', { title: 'API Study', problem: problem() })
  expect(created.status).toBe(200)
  const id = created.value.result.study.id as string
  expect(created.value.createdResources[0].id).toBe(id)
  const inspected = await invoke('planning.study.inspect', {}, id)
  expect(inspected.value.result.target.resource.id).toBe(id)
  expect(inspected.value.result.sections.map((section: { id: string }) => section.id)).toEqual(['problem', 'evidence', 'candidates'])
  expect((await store.read(workspaceId, id)).revision).toBe(1)
  const scoped = await invoke('planning.sources.capture', { studyId: id, expectedRevision: 1, request: sourceRequest }, id)
  expect(scoped.status).toBe(400); expect(scoped.value.error.code).toBe('capability_scope_mismatch')
  const sourceBody = { source: { ...source, workspaceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, profile: 'einsatz' }
  const cross = await invoke('planning.sources.capture', { studyId: id, expectedRevision: 1, request: sourceBody })
  expect(cross.status).toBe(400); expect(cross.value.error.code).toBe('workspace_scope_mismatch')
})
