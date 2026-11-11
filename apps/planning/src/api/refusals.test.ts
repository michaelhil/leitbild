import { afterAll, describe, expect, test } from 'bun:test'
import { planInputsSchema } from '../plan/schema.ts'
import { bundledPlanDefinitions } from '../definitions/index.ts'
import { createSolverDouble, testCertifiedSize } from './fixtures/doubles.ts'
import { jobsPerSolve } from '../plan/summary.ts'
import { createHarness } from './fixtures/harness.ts'

const harness = await createHarness()
afterAll(() => harness.close())
// The Train A Definition's own inputs: its plans are what these refusals are made on.
const trainA = planInputsSchema.parse(bundledPlanDefinitions.find(definition => definition.id === 'train-a-work-week')!.inputs)
const protectedRule = trainA.rules.find(rule => rule.kind === 'protected')!
const supported = trainA.equipment.find(item => item.supportedBy.length > 0)!
const workJob = trainA.jobs.find(job => job.kind === 'work' && job.isolation === 'inside')!
const minimumTest = trainA.jobs.find(job => job.kind === 'test' && job.minimum !== undefined)!
const error = (answer: { status: number; body: any }) => [answer.status, answer.body.error?.code]

describe('refusals name their cause and stay within 4 KB', () => {
  test('a write without a revision gets the current one; a stale one gets what changed since', async () => {
    const plan = await harness.create('train-a-work-week')
    const edit = { edits: [{ edit: 'plan', title: 'Train A, week 47' }] }
    const missing = await harness.call('planning.plan.edit', { resource: plan.id, input: edit })
    expect([...error(missing), missing.body.error.details.currentRevision]).toEqual([400, 'plan_revision_required', 1])
    expect((await harness.call('planning.plan.edit', { resource: plan.id, input: edit, expectedRevision: 1 })).status).toBe(200)
    const stale = await harness.call('planning.plan.edit', { resource: plan.id, input: edit, expectedRevision: 1 })
    expect([...error(stale), stale.body.error.details.currentRevision, stale.body.error.details.since.length]).toEqual([409, 'plan_revision_conflict', 2, 1])
    for (const operation of ['planning.plan.generate', 'planning.plan.baseline'] as const) {
      expect(error(await harness.call(operation, { resource: plan.id, input: operation === 'planning.plan.baseline' ? { option: 'O1', name: 'B' } : {} }))).toEqual([400, 'plan_revision_required'])
    }
    expect(error(await harness.call('planning.sources.refresh', { input: { plan: plan.id } }))).toEqual([400, 'plan_revision_required'])
  })

  test('an unknown key, protected equipment, and each weakening without authority', async () => {
    const plan = await harness.create('train-a-work-week')
    const edit = (edits: unknown[], extra: Record<string, unknown> = {}) => harness.call('planning.plan.edit', { resource: plan.id, input: { edits, ...extra }, expectedRevision: 1 })
    expect(error(await edit([{ edit: 'job', key: workJob.key, needs: [{ anyOf: ['nobody'] }] }]))).toEqual([400, 'unknown_reference'])
    const protectedItem = protectedRule.kind === 'protected' ? protectedRule.equipment[0]! : ''
    const touched = await edit([{ edit: 'job', key: workJob.key, equipment: [protectedItem] }])
    expect(error(touched)).toEqual([409, 'protected_equipment'])
    for (const weakening of [
      [{ edit: 'equipment', key: supported.key, supportedBy: [] }],
      [{ edit: 'remove', what: 'rule', key: protectedRule.key }],
      [{ edit: 'job', key: minimumTest.key, minimum: null }],
    ]) {
      const refused = await edit(weakening)
      expect(error(refused)).toEqual([409, 'needs_authority'])
      expect(refused.body.error.message).toEndWith('Name the person who agreed and their reason, as authority. Ask them; never fill this in yourself.')
      expect(refused.bytes).toBeLessThanOrEqual(4_096)
    }
    expect(error(await edit([{ edit: 'job', key: minimumTest.key, duration: { value: minimumTest.minimum!.value / 2, unit: minimumTest.minimum!.unit } }]))).toEqual([409, 'below_minimum'])
    // A due rule is added without authority; moving it later or removing it is refused without one.
    const window = trainA.settings.window!
    const at = (fraction: number) => new Date(Date.parse(window.start) + (Date.parse(window.end) - Date.parse(window.start)) * fraction).toISOString()
    const due = await edit([{ edit: 'rule', key: 'D1', kind: 'due', job: minimumTest.key, finishBy: at(0.5), words: 'Surveillance due', source: { by: 'reference', note: 'Technical specification surveillance' } }])
    expect([due.status, due.body.result.plan.revision]).toEqual([200, 2])
    const later = await harness.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'rule', key: 'D1', finishBy: at(0.75) }] }, expectedRevision: 2 })
    expect([...error(later), later.body.error.details.about]).toEqual([409, 'needs_authority', ['D1']])
    expect(error(await harness.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'remove', what: 'rule', key: 'D1' }] }, expectedRevision: 2 }))).toEqual([409, 'needs_authority'])
    const agreed = await harness.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'equipment', key: supported.key, supportedBy: [] }], authority: { name: 'Shift supervisor', reason: 'Support restored by a temporary line' }, reason: 'Temporary cooling' }, expectedRevision: 2 })
    expect(agreed.status).toBe(200)
    const history = (await harness.call('planning.plan.read', { resource: plan.id, input: { section: 'history' } })).body.result.sections[0].data.items[0]
    expect(history).toMatchObject({ revision: 3, authority: { name: 'Shift supervisor', reason: 'Support restored by a temporary line' }, reason: 'Temporary cooling' })
  })

  test('refusals carry the rule in words and the authority needed; preview violations are words with no keys (walk fix 11)', async () => {
    const plan = await harness.create('train-a-work-week')
    const edit = (edits: unknown[], extra: Record<string, unknown> = {}) => harness.call('planning.plan.edit', { resource: plan.id, input: { edits, ...extra }, expectedRevision: 1 })
    const loosened = await edit([{ edit: 'remove', what: 'rule', key: protectedRule.key }])
    expect(loosened.body.error.details).toMatchObject({ rule: protectedRule.words, authority: { needed: true, ask: 'Name the person who agreed and their reason, as authority. Ask them; never fill this in yourself.' } })
    const protectedItem = protectedRule.kind === 'protected' ? protectedRule.equipment[0]! : ''
    const touched = await edit([{ edit: 'job', key: workJob.key, equipment: [protectedItem] }])
    expect(touched.body.error.details.rule).toBe(protectedRule.words)
    expect(touched.body.error.details.authority).toBeUndefined()
    expect(touched.body.error.message).toContain(`'${trainA.equipment.find(item => item.key === protectedItem)!.label}' (${protectedItem})`)
    const minimum = await edit([{ edit: 'job', key: minimumTest.key, duration: { value: minimumTest.minimum!.value / 2, unit: minimumTest.minimum!.unit } }])
    expect(minimum.body.error.details).toMatchObject({ rule: expect.stringContaining(minimumTest.minimum!.words), authority: { needed: true } })
    // Who could lift it, in words with no plan key (walk 2, T20-04).
    expect(touched.body.error.details.lift).toBe('Only removing this protection rule lifts it, and removing the rule needs a named person\'s agreement.')
    // An edit invalid in itself is refused in a preview exactly as on save: the same 409, never preview violations (walk 2, R2-4).
    const preview = await harness.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'job', key: workJob.key, equipment: [protectedItem] }], preview: true } })
    expect([preview.status, preview.body.error.code, preview.body.error.details.rule]).toEqual([409, 'protected_equipment', protectedRule.words])
  })

  test('an Assistant never supplies authority: a loosening edit from an agent is a person\'s to make (adversary item 19)', async () => {
    const plan = await harness.create('train-a-work-week')
    // The adversary's probe: the Assistant removes the protected-train rule with an authority it typed itself.
    const typed = await harness.call('planning.plan.edit', { resource: plan.id, actor: 'ai', expectedRevision: 1, input: { edits: [{ edit: 'remove', what: 'rule', key: protectedRule.key }], authority: { name: 'Shift supervisor', reason: 'Agreed on the phone' } } })
    expect([...error(typed), typed.body.error.message]).toEqual([409, 'needs_person', 'A person must make this change in the plan screen: ask them.'])
    expect(error(await harness.call('planning.plan.edit', { resource: plan.id, actor: 'ai', expectedRevision: 1, input: { edits: [{ edit: 'remove', what: 'rule', key: protectedRule.key }] } }))).toEqual([409, 'needs_person'])
    expect((await harness.store.read(harness.workspaceId, plan.id)).inputs.rules.some(rule => rule.key === protectedRule.key)).toBe(true)
    // The same edit by a person with a named authority is saved; an Assistant's edit that loosens nothing is too.
    expect((await harness.call('planning.plan.edit', { resource: plan.id, actor: 'ai', expectedRevision: 1, input: { edits: [{ edit: 'plan', title: 'Train A, week 47' }] } })).status).toBe(200)
    expect((await harness.call('planning.plan.edit', { resource: plan.id, expectedRevision: 2, input: { edits: [{ edit: 'remove', what: 'rule', key: protectedRule.key }], authority: { name: 'Shift supervisor', reason: 'Train B work moved' } } })).status).toBe(200)
  })

  test('an Assistant deletes only at the revision it read; a person\'s delete card needs none (adversary item 24)', async () => {
    const plan = await harness.create('blank')
    const blind = await harness.call('planning.plan.delete', { resource: plan.id, actor: 'ai' })
    expect([...error(blind), blind.body.error.message]).toEqual([409, 'read_plan_first', 'Read the plan first: an Assistant deletes a plan only at the revision it has read; pass it as the expected revision.'])
    expect((await harness.call('planning.plan.delete', { resource: plan.id, actor: 'ai', expectedRevision: 1 })).body).toEqual({ result: { deleted: true } })
    const other = await harness.create('blank')
    expect((await harness.call('planning.plan.delete', { resource: other.id })).body).toEqual({ result: { deleted: true } })
  })

  test('a second item with the protected pump\'s World locator cannot take a tag-out', async () => {
    const plan = await harness.create('train-a-work-week')
    const protectedItem = protectedRule.kind === 'protected' ? protectedRule.equipment[0]! : ''
    const locator = trainA.equipment.find(item => item.key === protectedItem)!.locator!
    const refused = await harness.call('planning.plan.edit', { resource: plan.id, expectedRevision: 1, input: { edits: [
      { edit: 'equipment', key: 'SWB2', label: 'Spare name for the same pump', locator },
      { edit: 'job', key: 'TAG-TWIN', title: 'Tag out the twin', kind: 'tag-out', equipment: ['SWB2'], duration: { value: 1, unit: 'h', calendar: 'working' } },
    ] } })
    expect([...error(refused), refused.body.error.details.about]).toEqual([400, 'invalid_request', [protectedItem, 'SWB2']])
  })

  test('a malformed edit names the failing field with its schema and the kind\'s fields', async () => {
    const plan = await harness.create('blank')
    const refused = await harness.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'job', key: 'J1', duration: { value: 2, unit: 'weeks' } }] }, expectedRevision: 1 })
    expect(error(refused)).toEqual([400, 'invalid_request'])
    expect(refused.body.error.details.expected).toMatchObject({ edit: 0, field: 'duration' })
    expect(refused.body.error.details.expected.fields).toContain('needs')
    expect(JSON.stringify(refused.body.error.details.expected).length).toBeLessThanOrEqual(1_536)
  })

  test('a retry key is refused, and Generate refuses a plan above the certified size', async () => {
    const plan = await harness.create('blank')
    expect(error(await harness.call('planning.plan.edit', { resource: plan.id, input: { edits: [{ edit: 'plan', title: 'x' }] }, expectedRevision: 1, idempotencyKey: 'k1' }))).toEqual([400, 'idempotency_not_supported'])
    const small = await createHarness({ solver: { ...createSolverDouble(), certifiedSize: { ...testCertifiedSize, maxJobs: 1 } } })
    try {
      const big = await small.create('train-a-work-week')
      const refused = await small.call('planning.plan.generate', { resource: big.id, input: {}, expectedRevision: 1 })
      expect(error(refused)).toEqual([413, 'above_certified_size'])
      expect(refused.body.error.message).toBe(`This plan has ${jobsPerSolve(trainA)} jobs. Planning is certified for plans of up to 1 jobs (test plans); larger plans wait for the owner's decision.`)
      expect(refused.body.error.message).not.toContain(testCertifiedSize.evidence)   // the evidence is detail, never in the refusal
    } finally { await small.close() }
  })

  test('baseline refuses an option that is not validated feasible or no longer matches the plan', async () => {
    const plan = await harness.create('supply-run')
    const generated = await harness.call('planning.plan.generate', { resource: plan.id, input: {}, expectedRevision: 1 })
    expect(generated.body.result.options.every((option: { status: { word: string } }) => option.status.word === 'invalid input')).toBe(true)
    const invalid = generated.body.result.options[0].key
    expect(error(await harness.call('planning.plan.baseline', { resource: plan.id, input: { option: invalid, name: 'Issue' }, expectedRevision: 1 }))).toEqual([409, 'option_not_feasible'])
    expect(error(await harness.call('planning.plan.baseline', { resource: plan.id, input: { option: 'O9', name: 'Issue' }, expectedRevision: 1 }))).toEqual([400, 'unknown_reference'])
    const other = await harness.create('train-a-work-week')
    const options = await harness.call('planning.plan.generate', { resource: other.id, input: {}, expectedRevision: 1 })
    await harness.call('planning.plan.edit', { resource: other.id, input: { edits: [{ edit: 'plan', title: 'Changed' }] }, expectedRevision: 1 })
    expect(error(await harness.call('planning.plan.baseline', { resource: other.id, input: { option: options.body.result.recommended, name: 'Issue' }, expectedRevision: 2 }))).toEqual([409, 'option_stale'])
  })

  test('an unknown plan or Definition revision is 404', async () => {
    expect(error(await harness.call('planning.plan.read', { resource: crypto.randomUUID() }))).toEqual([404, 'plan_not_found'])
    const answer = await harness.request(`/internal/workspaces/${harness.workspaceId}/capabilities/planning.plan.create/invoke`, { method: 'POST', body: JSON.stringify({
      workspaceId: harness.workspaceId, capabilityId: 'planning.plan.create', input: {},
      definition: { workspaceId: harness.workspaceId, moduleId: 'planning', type: 'planning.plan-definition', id: 'blank', revisionId: '0000000000000000' },
      access: { workspaceId: harness.workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'human' } },
    }) })
    expect(error(answer)).toEqual([404, 'definition_not_found'])
  })
})
