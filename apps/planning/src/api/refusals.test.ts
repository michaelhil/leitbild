import { afterAll, describe, expect, test } from 'bun:test'
import { planInputsSchema } from '../plan/schema.ts'
import { createSolverDouble, testCertifiedSize } from './fixtures/doubles.ts'
import { createHarness } from './fixtures/harness.ts'

const harness = await createHarness()
afterAll(() => harness.close())
const trainA = planInputsSchema.parse(await Bun.file(new URL('../plan/fixtures/train-a.fragment.json', import.meta.url)).json())
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
      expect(refused.bytes).toBeLessThanOrEqual(4_096)
    }
    expect(error(await edit([{ edit: 'job', key: minimumTest.key, duration: { value: minimumTest.minimum!.value / 2, unit: minimumTest.minimum!.unit } }]))).toEqual([409, 'below_minimum'])
    const agreed = await edit([{ edit: 'equipment', key: supported.key, supportedBy: [] }], { authority: { name: 'Shift supervisor', reason: 'Support restored by a temporary line' }, reason: 'Temporary cooling' })
    expect(agreed.status).toBe(200)
    const history = (await harness.call('planning.plan.read', { resource: plan.id, input: { section: 'history' } })).body.result.sections[0].data.items[0]
    expect(history).toMatchObject({ revision: 2, authority: 'Shift supervisor: Support restored by a temporary line', reason: 'Temporary cooling' })
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
      expect(refused.body.error.message).toBe(`Too large for the certified size: certified for ${testCertifiedSize.family} up to 1 jobs; this plan has ${trainA.jobs.length}`)
    } finally { await small.close() }
  })

  test('baseline refuses an option that is not validated feasible or no longer matches the plan', async () => {
    const plan = await harness.create('supply-run')
    const generated = await harness.call('planning.plan.generate', { resource: plan.id, input: {}, expectedRevision: 1 })
    expect(generated.body.result.options.every((option: { status: { word: string } }) => option.status.word === 'invalid input')).toBe(true)
    expect(error(await harness.call('planning.plan.baseline', { resource: plan.id, input: { option: 'O1', name: 'Issue' }, expectedRevision: 1 }))).toEqual([409, 'option_not_feasible'])
    expect(error(await harness.call('planning.plan.baseline', { resource: plan.id, input: { option: 'O9', name: 'Issue' }, expectedRevision: 1 }))).toEqual([400, 'unknown_reference'])
    const blank = await harness.create('train-a-work-week')
    await harness.call('planning.plan.generate', { resource: blank.id, input: {}, expectedRevision: 1 })
    await harness.call('planning.plan.edit', { resource: blank.id, input: { edits: [{ edit: 'plan', title: 'Changed' }] }, expectedRevision: 1 })
    expect(error(await harness.call('planning.plan.baseline', { resource: blank.id, input: { option: 'O1', name: 'Issue' }, expectedRevision: 2 }))).toEqual([409, 'option_stale'])
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
