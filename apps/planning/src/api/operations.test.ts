import { afterAll, describe, expect, test } from 'bun:test'
import type { PlanningSubject } from '@leitbild/contracts'
import { planInputsSchema } from '../plan/schema.ts'
import { worldSubjects } from '../plan/readiness.ts'
import { subjectsFor } from './fixtures/doubles.ts'
import { createHarness } from './fixtures/harness.ts'

const supplyRun = planInputsSchema.parse(await Bun.file(new URL('../plan/fixtures/supply-run.case2.json', import.meta.url)).json())
const trainA = planInputsSchema.parse(await Bun.file(new URL('../plan/fixtures/train-a.fragment.json', import.meta.url)).json())

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

describe('the Supply run cycle through the operations', () => {
  test('create, link, refresh, edit, generate, explain, baseline and read: results within 4 KB, World only read', async () => {
    world = padded(subjectsFor(supplyRun, valuesFor(1), '2026-09-03T08:00:00Z'))
    const created = await harness.create('supply-run')
    expect(created.answer.body.createdResources).toEqual([{ workspaceId: harness.workspaceId, moduleId: 'planning', type: 'planning.plan', id: created.id }])
    expect(created.answer.body.result.attention[0].kind).toBe('world')
    expect(created.answer.body.result.problems.every((problem: { code: string }) => problem.code === 'world-unread')).toBe(true)
    expectSmall(created.answer)

    const linked = await harness.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', run: 'run-supply' }] }, expectedRevision: 1 })
    expect(linked.body.result.plan.revision).toBe(2)

    const refreshed = await harness.call('planning.sources.refresh', { input: { plan: created.id }, expectedRevision: 2 })
    expectSmall(refreshed)
    expect(refreshed.body.result.plan.revision).toBe(3)
    expect(refreshed.body.result.problems).toEqual([])
    expect(refreshed.body.result.attention.some((item: { kind: string }) => item.kind === 'world')).toBe(false)
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
    expect((await harness.store.read(harness.workspaceId, created.id)).revision).toBe(1)
    const weakening = await harness.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'remove', what: 'rule', key: trainA.rules[0]!.key }], preview: true } })
    expect(weakening.body.result.preview.weakens).toEqual([trainA.rules[0]!.key])
    expect(weakening.body.result.preview.consequence).toContain('needs authority')
  })

  test('read re-checks every status: an option the checker refuses is shown out of date, never with proof words', async () => {
    const { createCheckerDouble } = await import('./fixtures/doubles.ts')
    const refusing = new Set<string>()
    const local = await createHarness({ checker: createCheckerDouble(refusing) })
    try {
      const created = await local.create('train-a-work-week')
      const generated = await local.call('planning.plan.generate', { resource: created.id, input: {}, expectedRevision: 1 })
      const keys = generated.body.result.options.map((option: { key: string }) => option.key)
      expect(keys.length).toBe(trainA.methods[0]!.options.length)
      refusing.add(keys[0])
      const options = (await local.call('planning.plan.read', { resource: created.id, input: { section: 'options' } })).body.result.sections[0].data.items
      expect(options.find((option: { key: string }) => option.key === keys[0])).toMatchObject({ fresh: false })
      expect(options.find((option: { key: string }) => option.key === keys[1])).toMatchObject({ fresh: true, status: { word: 'validated feasible' } })
      expect((await local.call('planning.plan.baseline', { resource: created.id, input: { option: keys[0], name: 'x' }, expectedRevision: 1 })).body.error.code).toBe('option_stale')
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
