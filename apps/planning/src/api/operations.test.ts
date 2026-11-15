import { afterAll, describe, expect, test } from 'bun:test'
import type { PlanningSubject } from '@leitbild/contracts'
import { planInputsSchema } from '../plan/schema.ts'
import { bundledPlanDefinitions } from '../definitions/index.ts'
import { worldSubjects } from '../plan/readiness.ts'
import { subjectsFor } from './fixtures/doubles.ts'
import { createHarness } from './fixtures/harness.ts'

const supplyRun = planInputsSchema.parse(await Bun.file(new URL('../plan/fixtures/supply-run.case2.json', import.meta.url)).json())
const trainA = planInputsSchema.parse(bundledPlanDefinitions.find(definition => definition.id === 'train-a-work-week')!.inputs)

// World values the double answers: one per fact id the Supply run names. They are World inputs, not schedules.
const factIds = [...new Set([
  ...supplyRun.jobs.flatMap(job => [...(job.duration.origin.by === 'world' ? job.duration.origin.refs : []), ...job.durationWith.flatMap(entry => 'refs' in entry ? entry.refs : [])]),
  ...supplyRun.resources.flatMap(resource => resource.attributes.flatMap(attribute => attribute.origin.by === 'world' ? attribute.origin.refs : [])),
].map(ref => ref.fact))]
let world: PlanningSubject[] = []
const valuesFor = (scale: number) => Object.fromEntries(factIds.map((id, index) => [id, id.includes('payload')
  ? { value: (index + 3) * 100 * scale, unit: 'kg', basis: 'configured' as const }
  : { value: (index + 1) * 30 * scale, unit: 's', basis: 'owner-estimate' as const }]))
// One large item: more facts than one 4 KB page holds, so it continues on the next page under its locator.
const padded = (subjects: PlanningSubject[]) => subjects.map((subject, index) => index !== 0 ? subject : {
  ...subject, facts: [...subject.facts, ...Array.from({ length: 40 }, (_, at) => ({ id: `${subject.locator}/extra/${at}`, label: `Extra value ${at}`, quantity: 'count', unit: '1', value: at, basis: 'observed' as const, at: '2026-09-03T08:00:00Z' }))],
})

const harness = await createHarness({ subjects: () => world })
afterAll(() => harness.close())
const expectSmall = (answer: { bytes: number }) => expect(answer.bytes).toBeLessThanOrEqual(4_096)

describe('every write path keeps the store\'s rule: inputs change only with the revision (child-boundary risk)', () => {
  test('create, edit, preview, refresh (new values, then only a newer read time), generate, baseline and delete all pass', async () => {
    const { inputsDigest } = await import('../plan/store.ts')
    const local = await createHarness({ subjects: () => world })
    try {
      const ok = (answer: { status: number; body: any }) => { expect([answer.status < 300, answer.body?.error?.code]).toEqual([true, undefined]); return answer }
      const stored = () => local.store.read(local.workspaceId, created.id)
      world = subjectsFor(supplyRun, valuesFor(1), '2026-09-03T08:00:00Z')
      const created = await local.create('supply-run')
      ok(await local.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', run: 'run-supply' }] }, expectedRevision: 1 }))
      ok(await local.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', title: 'Preview only' }], preview: true } }))
      ok(await local.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 2 }))
      // The same values read again later: the revision and what the solver reads both stay.
      const before = await stored()
      world = subjectsFor(supplyRun, valuesFor(1), '2026-09-03T08:05:00Z')
      ok(await local.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 3 }))
      const after = await stored()
      expect([after.revision, inputsDigest(after.inputs)]).toEqual([before.revision, inputsDigest(before.inputs)])
      const generated = ok(await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 3 }))
      ok(await local.call('planning.plan.baseline', { resource: created.id, input: { option: generated.body.result.recommended, name: 'B' }, expectedRevision: 3 }))
      expect(inputsDigest((await stored()).inputs)).toBe(inputsDigest(after.inputs))
      ok(await local.call('planning.plan.delete', { resource: created.id, expectedRevision: 3 }))
    } finally { await local.close() }
  })
})

describe('the Supply run cycle through the operations', () => {
  test('create, link, refresh, generate, explain, baseline and read: results within 4 KB, World only read by refresh', async () => {
    world = padded(subjectsFor(supplyRun, valuesFor(1), '2026-09-03T08:00:00Z'))
    const created = await harness.create('supply-run')
    expect(created.answer.body.createdResources).toEqual([{ workspaceId: harness.workspaceId, moduleId: 'planning', type: 'planning.plan', id: created.id }])
    expect(created.answer.body.result.attention[0].kind).toBe('world')
    expect(created.answer.body.result.problems.every((problem: { code: string }) => problem.code === 'world-unread')).toBe(true)
    expectSmall(created.answer)

    // A plan-scoped edit never reads World (adversary item 20): the link is saved with the values unread.
    const linked = await harness.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', run: 'run-supply' }] }, expectedRevision: 1 })
    expect(linked.body.result.plan.revision).toBe(2)
    expect(harness.journal).toEqual([])
    expect(linked.body.result.problems.every((problem: { code: string }) => problem.code === 'world-unread')).toBe(true)

    // The Workspace-scoped refresh reads them.
    const refreshed = await harness.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 2 })
    expectSmall(refreshed)
    expect(refreshed.body.result.plan.revision).toBe(3)
    expect(refreshed.body.result.problems).toEqual([])
    // One read for all subjects, followed over its pages with the same question.
    const subjects = worldSubjects(supplyRun)
    expect(harness.journal.length).toBeGreaterThan(1)
    expect(harness.journal.every(entry => entry.capabilityId === 'world.simulation-run.planning-facts' && JSON.stringify((entry.input as { subjects: string[] }).subjects) === JSON.stringify(subjects))).toBe(true)
    const stored = await harness.store.read(harness.workspaceId, created.id)
    expect(stored.inputs.world.facts.length).toBe(world.reduce((sum, subject) => sum + subject.facts.length, 0))
    expect(stored.inputs.jobs.every(job => job.duration.origin.by !== 'world' || job.duration.value === null)).toBe(true)

    // Unchanged World values refresh the read time without raising the revision.
    const again = await harness.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 3 })
    expect([again.body.result.plan.revision, again.body.result.changed.length, again.body.result.changed[0].endsWith('none changed')]).toEqual([3, 1, true])

    const generated = await harness.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 3 })
    expectSmall(generated)
    expect(generated.body.result.plan.revision).toBe(3)
    const recommended = generated.body.result.recommended
    expect(generated.body.result.options.find((option: { key: string }) => option.key === recommended).status.word).toBe('validated feasible')

    const explained = await harness.call('planning.plan.explain', { resource: created.id, input: { ask: 'finish' } })
    expectSmall(explained)
    expect(explained.body.result.items.length).toBeGreaterThan(0)

    const baselined = await harness.call('planning.plan.baseline', { resource: created.id, input: { option: recommended, name: 'Dispatch at 08:00' }, expectedRevision: 3 })
    expectSmall(baselined)
    expect(baselined.body.result.plan.revision).toBe(3)

    for (const section of [undefined, 'jobs', 'rules', 'crews', 'sources', 'options', 'schedule', 'history']) {
      const read = await harness.call('planning.plan.read', { resource: created.id, input: section === undefined ? {} : { section } })
      expect(read.status).toBe(200)
      expectSmall(read)
    }
    const summary = (await harness.call('planning.plan.read', { resource: created.id })).body.result
    expect(summary.sections.map((section: { id: string }) => section.id)).toEqual(['summary'])
    expect(summary.sections[0].data.plan).toMatchObject({ id: created.id, revision: 3 })
    const history = (await harness.call('planning.plan.read', { resource: created.id, input: { section: 'history' } })).body.result.sections[0].data.items
    expect(history[0].summary).toBe("Baseline 'Dispatch at 08:00' from " + generated.body.result.options.find((option: { key: string }) => option.key === recommended).label)

    // A changed World value raises the revision and makes the options out of date.
    world = padded(subjectsFor(supplyRun, valuesFor(2), '2026-09-03T08:01:00Z'))
    const changed = await harness.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 3 })
    expect([changed.body.result.plan.revision, changed.body.result.attention.some((item: { kind: string; about: string[] }) => item.kind === 'stale' && item.about.includes(recommended)), changed.body.result.changed.length > 1]).toEqual([4, true, true])
    expectSmall(changed)
  })

  test('a refresh with an unknown locator is refused as World named it, and nothing is saved', async () => {
    world = []
    const created = await harness.create('supply-run')
    await harness.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', run: 'run-other' }] }, expectedRevision: 1 })
    const refused = await harness.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 2 })
    expect([refused.status, refused.body.error.code, refused.body.error.details.subjects.length]).toEqual([404, 'unknown_subject', worldSubjects(supplyRun).length])
    expect((await harness.store.read(harness.workspaceId, created.id)).revision).toBe(2)
  })
})

describe('Train A: preview, read and status on the generic operations', () => {
  test('a lock preview shows the violation and the nearest allowed time and saves nothing (T20)', async () => {
    const created = await harness.create('train-a-work-week')
    await harness.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
    const job = trainA.jobs[0]!
    const before = new Date(Date.parse(trainA.settings.window!.start) - 3_600_000).toISOString()
    const preview = await harness.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'job', key: job.key, lock: before }], preview: true } })
    expectSmall(preview)
    expect(preview.body.result.preview).toMatchObject({ saved: false, nearestAllowed: trainA.settings.window!.start })
    expect(preview.body.result.preview.violations.length).toBe(1)
    // What moved carries the edit as its cause: the locked job moves, because of edit 0.
    expect(preview.body.result.preview.moved).toContainEqual(expect.objectContaining({ job: job.key, because: [0] }))
    expect((await harness.store.read(harness.workspaceId, created.id)).revision).toBe(1)
    const weakening = await harness.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'remove', what: 'rule', key: trainA.rules[0]!.key }], preview: true } })
    expect(weakening.body.result.preview.weakens).toEqual([trainA.rules[0]!.key])
    expect(weakening.body.result.preview.consequence).toContain("needs a named person's agreement")
  })

  test('a read runs no checker: a stored status stands only on its revision and formulation, else it is out of date (memory decision, 11 Nov)', async () => {
    const { createSolverDouble } = await import('./fixtures/doubles.ts')
    const inner = createSolverDouble()
    let version = 'f1'
    const formulation = (grid: Parameters<typeof inner.formulation>[0]) => `${inner.formulation(grid)} ${version}`
    const local = await createHarness({ solver: { ...inner, formulation, generate: async request => {
      const set = await inner.generate(request)
      return { ...set, options: set.options.map(option => 'run' in option.status ? { ...option, status: { ...option.status, run: { ...option.status.run, formulation: formulation(request.inputs.settings.grid) } } } : option) }
    } } })
    try {
      const created = await local.create('train-a-work-week')
      const generated = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      const key = generated.body.result.recommended
      const options = async () => (await local.call('planning.plan.read', { resource: created.id, input: { section: 'options' } })).body.result.sections[0].data.items as Array<{ key: string; fresh: boolean; status: { word: string; goals: Array<{ word: string }> } }>
      // On its revision and formulation the stored status is shown as stored.
      const stored = (await local.store.read(local.workspaceId, created.id)).options!.options.find(option => option.key === key)!
      expect((await options()).find(option => option.key === key)).toMatchObject({ fresh: true, status: { word: stored.status.word } })
      // A new solver formulation: out of date, no proof, no baseline.
      version = 'f2'
      expect((await options()).every(option => !option.fresh)).toBe(true)
      expect((await local.call('planning.plan.baseline', { resource: created.id, input: { option: key, name: 'x' }, expectedRevision: 1 })).body.error.message).toContain('the solver changed')
      version = 'f1'
      // An input change: out of date as well, shown without proof words.
      await local.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', title: 'Week 47' }] }, expectedRevision: 1 })
      const after = await options()
      expect(after.every(option => !option.fresh && option.status.goals.every(goal => goal.word !== 'proven optimal'))).toBe(true)
      expect((await local.call('planning.plan.baseline', { resource: created.id, input: { option: key, name: 'x' }, expectedRevision: 2 })).body.error.code).toBe('option_stale')
    } finally { await local.close() }
  })

  test('the plan Resource shows its status and option count without proof words', async () => {
    const created = await harness.create('train-a-work-week')
    const resource = (await harness.request(`/internal/workspaces/${harness.workspaceId}/resources`)).body.resources.find((entry: { ref: { id: string } }) => entry.ref.id === created.id)
    expect(resource.summary).toEqual([
      { key: 'status', label: 'Status', kind: 'status', value: 'Not linked yet' },
      { key: 'option-count', label: 'Options', kind: 'count', value: 0 },
      { key: 'updated-at', label: 'Updated', kind: 'timestamp', value: resource.summary[2].value },
    ])
  })
})

describe('ai fixes: the plan target in results, refresh batches', () => {
  test('every write result names the plan as the next call targets it', async () => {
    const created = await harness.create('blank')
    const target = { kind: 'resource', ref: { workspaceId: harness.workspaceId, moduleId: 'planning', type: 'planning.plan', id: created.id } }
    expect(created.answer.body.result.target).toEqual(target)
    const edited = await harness.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', title: 'Week 48' }] }, expectedRevision: 1 })
    expect(edited.body.result.target).toEqual(target)
    expect((await harness.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 2 })).body.result.target).toEqual(target)
  })

  test('a refresh reads at most 32 subjects per request, per Pack, and refuses more than 32 Einsatz items in words', async () => {
    const many = (pack: string, count: number) => Array.from({ length: count }, (_, index) => ({ edit: 'equipment', key: `E${pack}${index}`, label: `${pack} item ${index}`, locator: `${pack}/item/${index}` }))
    const subjects = (pack: string, count: number): PlanningSubject[] => Array.from({ length: count }, (_, index) => ({ locator: `${pack}/item/${index}`, label: `${pack} item ${index}`, kind: 'item', facts: [{ id: `${pack}/${index}/state`, label: 'State', quantity: 'state', value: 'on', basis: 'observed', at: '2026-11-12T09:00:00Z' }] }))
    world = [...subjects('process-plant', 40), ...subjects('einsatz', 33)]
    const local = await createHarness({ subjects: () => world })
    try {
      const plant = await local.create('blank', { edits: [...many('process-plant', 40), { edit: 'plan', run: 'run-many' }] })
      const read = await local.call('planning.sources.refresh', { input: { plan: plant.id }, expectedRevision: 1 })
      expect(read.status).toBe(200)
      // Each request names at most 32 subjects; a batch's later pages repeat its question with a cursor.
      const asked = local.journal.map(entry => (entry.input as { subjects: string[] }).subjects)
      expect(asked.every(batch => batch.length <= 32)).toBe(true)
      expect([...new Set(asked.map(batch => JSON.stringify(batch)))].map(batch => JSON.parse(batch).length)).toEqual([32, 8])
      expect((await local.store.read(local.workspaceId, plant.id)).inputs.world.facts.length).toBe(40)
      // One deadline covers every batch: each answer alone is in time, together they are not, and nothing is saved.
      const slow = await createHarness({ subjects: () => world, worldAnswerAfterMs: 60, refreshDeadlineMs: 100 })
      try {
        const late = await slow.create('blank', { edits: [...many('process-plant', 40), { edit: 'plan', run: 'run-many' }] })
        const refusedLate = await slow.call('planning.sources.refresh', { input: { plan: late.id }, expectedRevision: 1 })
        expect([refusedLate.status, refusedLate.body.error.code, slow.journal.length > 1]).toEqual([503, 'world_unavailable', true])
        expect((await slow.store.read(slow.workspaceId, late.id)).inputs.world.facts).toEqual([])
      } finally { await slow.close() }
      const einsatz = await local.create('blank', { edits: [...many('einsatz', 33), { edit: 'plan', run: 'run-many' }] })
      const refused = await local.call('planning.sources.refresh', { input: { plan: einsatz.id }, expectedRevision: 1 })
      expect([refused.status, refused.body.error.code, refused.body.error.message]).toEqual([400, 'world_read_limit', 'This plan names 33 Einsatz items; their arrival times are read together, at most 32 at once. Remove the items the plan does not need.'])
    } finally { await local.close() }
  })
})

describe('ops fixes: option identity, one Generate at a time, baseline bound, refresh deadline, stopping', () => {
  test('option keys are unique per generated set, so a baseline names only an option its caller saw', async () => {
    const created = await harness.create('train-a-work-week')
    const first = await harness.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
    // The same options again keep their keys (they are what the caller saw); a different set gets new keys.
    const again = await harness.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
    const keys = (answer: typeof first) => answer.body.result.options.map((option: { key: string }) => option.key)
    expect(keys(again)).toEqual(keys(first))
    const second = await harness.call('planning.plan.generate', { resource: created.id, input: { variants: [{ label: 'Second look' }] }, expectedRevision: 1 })
    expect(keys(first).some((key: string) => keys(second).includes(key))).toBe(false)
    expect(keys(second)).toContain(second.body.result.recommended)
    const stale = await harness.call('planning.plan.baseline', { resource: created.id, input: { option: first.body.result.recommended, name: 'Seen before' }, expectedRevision: 1 })
    expect([stale.status, stale.body.error.code]).toEqual([400, 'unknown_reference'])
    expect((await harness.call('planning.plan.baseline', { resource: created.id, input: { option: second.body.result.recommended, name: 'Seen now' }, expectedRevision: 1 })).status).toBe(200)
  })

  test('a second Generate on the same plan while one runs is refused with 409; stopping keeps the running one\'s result', async () => {
    const { createSolverDouble } = await import('./fixtures/doubles.ts')
    const inner = createSolverDouble()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    // A solve that runs until it is stopped, then returns its best, as lane S's engine does on abort.
    const local = await createHarness({ solver: { ...inner, generate: async request => {
      entered()
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      return inner.generate(request)
    } } })
    try {
      const created = await local.create('train-a-work-week')
      const running = local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      await started
      const second = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      expect([second.status, second.body.error.code, second.body.error.message]).toEqual([409, 'generate_running', 'Generate is already working on this plan; wait for it to finish, then read the options'])
      await local.operations.shutdown()
      const finished = await running
      expect(finished.status).toBe(200)
      expect((await local.store.read(local.workspaceId, created.id)).options?.options.length).toBe(trainA.methods[0]!.options.length)
    } finally { await local.close() }
  })

  test('a plan keeps at most 8 baselines', async () => {
    const { maxBaselines } = await import('./operations.ts')
    const created = await harness.create('train-a-work-week')
    const generated = await harness.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
    for (let index = 0; index < maxBaselines; index += 1) {
      expect((await harness.call('planning.plan.baseline', { resource: created.id, input: { option: generated.body.result.recommended, name: `B${index}` }, expectedRevision: 1 })).status).toBe(200)
    }
    const refused = await harness.call('planning.plan.baseline', { resource: created.id, input: { option: generated.body.result.recommended, name: 'One too many' }, expectedRevision: 1 })
    expect([refused.status, refused.body.error.code, maxBaselines]).toEqual([409, 'baseline_limit', 8])
  })

  test('a refresh has one deadline for all its pages; past it nothing is saved and it says so', async () => {
    const slow = await createHarness({ subjects: () => world, worldAnswerAfterMs: 400, refreshDeadlineMs: 100 })
    try {
      world = padded(subjectsFor(supplyRun, valuesFor(1), '2026-09-03T08:00:00Z'))
      const created = await slow.create('supply-run')
      await slow.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', run: 'run-slow' }] }, expectedRevision: 1 })
      const refused = await slow.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 2 })
      expect([refused.status, refused.body.error.code, refused.body.error.retryable, refused.body.error.message]).toEqual([503, 'world_unavailable', true, 'World did not answer within 0.1 s; nothing was saved. Try again.'])
      const stored = await slow.store.read(slow.workspaceId, created.id)
      expect([stored.revision, stored.inputs.world]).toEqual([2, { refreshedAt: null, facts: [] }])
    } finally { await slow.close() }
  })
})

describe('the time step chosen at create (walk fix 18)', () => {
  test('create stores the requested grid; without one a Definition keeps its own', async () => {
    const chosen = await harness.create('blank', { grid: '30s' })
    expect((await harness.store.read(harness.workspaceId, chosen.id)).inputs.settings.grid).toBe('30s')
    const blank = await harness.create('blank')
    expect((await harness.store.read(harness.workspaceId, blank.id)).inputs.settings.grid).toBe('30min')
    const supply = await harness.create('supply-run')
    expect((await harness.store.read(harness.workspaceId, supply.id)).inputs.settings.grid).toBe(supplyRun.settings.grid)
  })
})

describe('a plan-scoped edit never reads World; preview names what the re-timing breaks (adversary items 20, 22)', () => {
  test('adding World items and linking a Run make no World call; refresh then reads them', async () => {
    world = [{ locator: 'einsatz/unit/unit%3Atruck-9', label: 'Truck 9', kind: 'unit', facts: [{ id: 'unit:truck-9/property/payloadKg', label: 'Payload', quantity: 'payloadKg', unit: 'kg', value: 900, basis: 'configured', at: '2026-09-03T08:00:00Z' }] }]
    const local = await createHarness({ subjects: () => world })
    try {
      const plan = await local.create('blank', { edits: [{ edit: 'calendar', key: 'duty', label: 'On duty', periods: [{ start: '2026-09-03T08:00:00Z', end: '2026-09-03T08:30:00Z' }] }] })
      const added = await local.call('planning.plan.edit', { resource: plan.id, expectedRevision: 1, input: { edits: [
        { edit: 'plan', run: 'run-any' },
        { edit: 'resource', key: 'truck-9', label: 'Truck 9', kind: 'tool', count: 1, calendar: 'duty', locator: 'einsatz/unit/unit%3Atruck-9', attributes: [{ key: 'payloadKg', label: 'Payload', unit: 'kg', fromWorld: { locator: 'einsatz/unit/unit%3Atruck-9', fact: 'unit:truck-9/property/payloadKg' } }] },
        // The payload is used: a job asks for at least 500 kg (walk 3, R3-2: only a used value is required).
        { edit: 'job', key: 'haul', title: 'Haul water', kind: 'work', isolation: 'none', duration: { value: 10, unit: 'min', calendar: 'working' }, needs: [{ anyOf: ['truck-9'], amount: 1, where: { attribute: 'payloadKg', atLeast: 500, unit: 'kg' } }] },
      ] } })
      expect([added.status, local.journal.length]).toEqual([200, 0])
      expect(added.body.result.problems.map((problem: { code: string }) => problem.code)).toEqual(['world-unread'])
      const read = await local.call('planning.sources.refresh', { input: { plan: plan.id }, expectedRevision: 2 })
      expect([read.status, read.body.result.problems, local.journal.length]).toEqual([200, [], 1])
    } finally { await local.close() }
  })

  test('a preview whose re-timing breaks a rule names it with its limit; the same edit saves and the option goes out of date', async () => {
    const { createSolverDouble } = await import('./fixtures/doubles.ts')
    const inner = createSolverDouble()
    const rule = trainA.rules.find(entry => entry.kind === 'span-limit')!
    const local = await createHarness({ solver: { ...inner, preview: async request => ({ rows: request.option.rows, violations: [{ code: 'span-limit', about: [rule.key, 'group'], words: rule.words }] }) } })
    try {
      const created = await local.create('train-a-work-week')
      await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      const job = trainA.jobs.find(entry => entry.kind === 'work')!
      const preview = await local.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'job', key: job.key, duration: { value: job.duration.value! + 6 } }], preview: true } })
      const limit = rule.kind === 'span-limit' ? `${rule.limit.value} ${rule.limit.unit}` : ''
      // A valid change saves even so: the preview says what this option would break and asks for new options (walk 2, R2-4).
      // The rule by what it says, never by its key (walk 3, R3-6, R2-4-01).
      const group = rule.kind === 'span-limit' ? trainA.groups.find(entry => entry.key === rule.group)!.label : ''
      expect(preview.body.result.preview.consequence).toBe(`Not saved yet. This option would break the ${limit} limit on ${group}; generate new options after saving.`)
      expect(preview.body.result.preview.consequence).not.toContain(rule.key)
      expect(preview.body.result.preview.violations).toEqual([rule.words])
      const saved = await local.call('planning.plan.edit', { resource: created.id, expectedRevision: 1, input: { edits: [{ edit: 'job', key: job.key, duration: { value: job.duration.value! + 6 } }] } })
      expect(saved.status).toBe(200)
      expect(saved.body.result.plan.revision).toBe(2)
      expect(saved.body.result.attention.some((item: { kind: string }) => item.kind === 'stale')).toBe(true)
    } finally { await local.close() }
  })
})

describe('the linked simulation against the plan window (walk 2, R2-6)', () => {
  test('a refresh says, with dates, when the simulation time lies outside the window, and not when inside', async () => {
    world = [{ locator: 'einsatz/unit/unit%3Atruck-9', label: 'Truck 9', kind: 'unit', facts: [{ id: 'unit:truck-9/property/payloadKg', label: 'Payload', quantity: 'payloadKg', unit: 'kg', value: 900, basis: 'configured', at: '2026-09-03T08:00:00Z' }] }]
    const local = await createHarness({ subjects: () => world })
    try {
      const truck = { edit: 'resource', key: 'truck-9', label: 'Truck 9', kind: 'tool', count: 1, calendar: 'duty', locator: 'einsatz/unit/unit%3Atruck-9', attributes: [{ key: 'payloadKg', label: 'Payload', unit: 'kg', fromWorld: { locator: 'einsatz/unit/unit%3Atruck-9', fact: 'unit:truck-9/property/payloadKg' } }] }
      const plan = await local.create('blank', { edits: [
        { edit: 'plan', timeZone: 'Europe/Oslo', window: { start: '2026-11-12T08:00:00Z', end: '2026-11-17T08:00:00Z' }, run: 'run-any' },
        { edit: 'calendar', key: 'duty', label: 'On duty', periods: [{ start: '2026-11-12T08:00:00Z', end: '2026-11-13T08:00:00Z' }] }, truck,
      ] })
      const read = await local.call('planning.sources.refresh', { input: { plan: plan.id }, expectedRevision: 1 })
      expect(read.body.result.changed.slice(0, 2)).toEqual([
        'Read 1 World value describing Thu 3 Sep 10:00 (simulation time): 1 new or changed',
        "The simulation's time, Thu 3 Sep 10:00, is outside the plan window (Thu 12 Nov 09:00 to Tue 17 Nov 09:00): align the window to it.",
      ])
      const aligned = await local.call('planning.plan.edit', { resource: plan.id, expectedRevision: 2, input: { edits: [{ edit: 'plan', window: { start: '2026-09-03T08:00:00Z', end: '2026-09-08T08:00:00Z' } }] } })
      expect(aligned.status).toBe(200)
      const again = await local.call('planning.sources.refresh', { input: { plan: plan.id }, expectedRevision: 3 })
      expect(again.body.result.changed).toEqual(['Read 1 World value describing Thu 3 Sep 10:00 (simulation time): none changed'])
    } finally { await local.close() }
  })
})

describe('a lock is measured against the saved plan (walk 2, R2-5)', () => {
  test("the preview shows lane K's findings for the locked job against the saved option, and the nearest allowed start", async () => {
    const { createSolverDouble } = await import('./fixtures/doubles.ts')
    const inner = createSolverDouble()
    const link = trainA.links.find(entry => entry.type === 'FS')!
    const [pull, install] = [trainA.jobs.find(job => job.key === link.from)!, trainA.jobs.find(job => job.key === link.to)!]
    const saved = `'${install.title}' must start after '${pull.title}' finishes; it is 8 h too early.`
    const local = await createHarness({ solver: { ...inner, preview: async request => ({
      rows: request.option.rows,
      // The re-timed option moved the pull: its finding about the locked job is replaced by the saved-plan one.
      violations: [{ code: 'link', about: [pull.key, install.key], words: `'${install.title}' must start after '${pull.title}' finishes; it is 28 h too early.` }],
      lockFindings: [{ code: 'link', about: [pull.key, install.key], words: saved }],
      nearestAllowed: { job: install.key, at: '2026-11-17T15:00:00Z' },
    }) } })
    try {
      const created = await local.create('train-a-work-week')
      await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      const preview = await local.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'job', key: install.key, lock: '2026-11-17T07:00:00Z' }], preview: true } })
      expect(preview.status).toBe(200)
      expect(preview.body.result.preview.violations).toEqual([saved])
      expect(preview.body.result.preview.nearestAllowed).toBe('2026-11-17T15:00:00Z')
      expect(preview.body.result.preview.consequence).toBe(`Not saved yet. This option would break the link '${pull.title}' before '${install.title}'; generate new options after saving. The nearest allowed start for ${install.title} is Tue 16:00.`)
    } finally { await local.close() }
  })
})

describe("Generate stores lane K's verdict from the solver child as it came, validated (memory decision, 11 Nov)", () => {
  test('the statuses the solver returns are stored and shown unchanged; a set that breaks the status schema is refused, nothing saved', async () => {
    const { createSolverDouble } = await import('./fixtures/doubles.ts')
    const inner = createSolverDouble()
    // As lane S's child returns it after lane K's verifyBound: goal 0 confirmed, the later goals best found.
    let claim: Array<'proven optimal' | 'best found under budget'> = ['proven optimal', 'best found under budget', 'best found under budget']
    const solver = { ...inner, generate: async (request: Parameters<typeof inner.generate>[0]) => {
      const set = await inner.generate(request)
      return { ...set, options: set.options.map(option => option.status.word !== 'validated feasible' ? option
        : { ...option, status: { ...option.status, goals: option.status.goals.map(goal => claim[goal.goal] === 'proven optimal'
          ? { word: 'proven optimal' as const, goal: goal.goal, value: goal.value, unit: goal.unit, bound: { value: goal.value, source: 'logic+calendars' as const, certificate: { kind: 'zero' as const } } }
          : { word: 'best found under budget' as const, goal: goal.goal, value: goal.value, unit: goal.unit }) } }) }
    } }
    const local = await createHarness({ solver })
    try {
      const created = await local.create('train-a-work-week')
      const words = (goals: ReadonlyArray<{ word: string }>) => goals.map(goal => goal.word)
      const generated = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      expect(words(generated.body.result.options[0].status.goals)).toEqual(claim)
      const stored = await local.store.read(local.workspaceId, created.id)
      expect(words(stored.options!.options[0]!.status.word === 'validated feasible' ? stored.options!.options[0]!.status.goals : [])).toEqual(claim)
      const read = await local.call('planning.plan.read', { resource: created.id, input: { section: 'options' } })
      expect(words(read.body.result.sections[0].data.items[0].status.goals)).toEqual(claim)
      // "Proven optimal" after a goal that is not proven breaks the status schema: refused, the stored set kept.
      claim = ['best found under budget', 'proven optimal', 'proven optimal']
      const refused = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      expect([refused.status, refused.body.error.code]).toEqual([500, 'invalid_planning_result'])
      expect((await local.store.read(local.workspaceId, created.id)).options).toEqual(stored.options)
    } finally { await local.close() }
  })
})

describe('an option solved above the certified size says so beside its status (size decision, 15 Nov)', () => {
  test('the caution travels as a warning on Generate and on the options read; an option without it has none', async () => {
    const { createSolverDouble, testCertifiedSize } = await import('./fixtures/doubles.ts')
    const inner = createSolverDouble()
    let caution = true
    // Lane S's Generate marks each option of a solve above the certified size; the double's options are marked here.
    const solver = { ...inner, generate: async (request: Parameters<typeof inner.generate>[0]) => {
      const set = await inner.generate(request)
      return caution ? { ...set, options: set.options.map(option => ({ ...option, sizeCaution: true as const })) } : set
    } }
    const local = await createHarness({ solver })
    try {
      const created = await local.create('train-a-work-week')
      const words = `Above the certified size (${testCertifiedSize.maxJobs} jobs). This plan keeps every hard rule, but it may not be near the best.`
      const generated = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      expect(generated.status).toBe(200)
      for (const option of generated.body.result.options) expect(option.warnings).toContainEqual({ kind: 'above-certified-size', text: words, about: [] })
      const read = await local.call('planning.plan.read', { resource: created.id, input: { section: 'options' } })
      for (const option of read.body.result.sections[0].data.items) expect(option.warnings).toContainEqual({ kind: 'above-certified-size', text: words, about: [] })
      caution = false
      const again = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      for (const option of again.body.result.options) expect(option.warnings.some((warning: { kind: string }) => warning.kind === 'above-certified-size')).toBe(false)
    } finally { await local.close() }
  })
})
