import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createPlanStore, encodePlan, summarize } from './store.ts'
import { planInputsSchema, type Plan } from './schema.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const tempRoot = async () => { const root = await mkdtemp(join(tmpdir(), 'planning-store-')); roots.push(root); return root }
const workspaceId = workspaceIdSchema.parse('5d1b0a9e-6c1e-4d5e-9f00-0000000000a1')
const supplyRun = planInputsSchema.parse(await Bun.file(new URL('./fixtures/supply-run.case2.json', import.meta.url)).json())

const planFor = (id: string = crypto.randomUUID()): Plan => ({
  id, workspaceId, revision: 1, createdAt: '2026-11-11T08:00:00Z', updatedAt: '2026-11-11T08:00:00Z',
  inputs: supplyRun, options: null, baselines: [],
  changes: [{ seq: 1, at: '2026-11-11T08:00:00Z', by: { kind: 'human' }, revision: 1, summary: 'Created', kinds: [] }], droppedChanges: 0,
})
const retitle = (title: string, raise = true) => (plan: Plan): Plan => ({ ...plan, revision: plan.revision + (raise ? 1 : 0), inputs: { ...plan.inputs, settings: { ...plan.inputs.settings, title } } })
const caught = async (work: Promise<unknown>) => { try { await work } catch (error) { return error as { status: number; code: string; details?: Record<string, unknown> } } throw new Error('expected a refusal') }

describe('one JSON file per plan', () => {
  test('a plan lives at workspaces/<ws>/planning/plans/<uuid>.json and the old studies folder is never read', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    expect(await store.provision(workspaceId)).toBe(true)
    expect(await store.provision(workspaceId)).toBe(false)
    await mkdir(join(root, 'workspaces', workspaceId, 'planning', 'studies'), { recursive: true })
    await writeFile(join(root, 'workspaces', workspaceId, 'planning', 'studies', `${crypto.randomUUID()}.json`), '{"old":true}')
    const plan = await store.create(workspaceId, planFor())
    // Two lines: the catalogue summary, then the plan.
    const lines = (await Bun.file(join(root, 'workspaces', workspaceId, 'planning', 'plans', `${plan.id}.json`)).text()).split('\n')
    expect([JSON.parse(lines[0]!), JSON.parse(lines[1]!), lines.slice(2)]).toEqual([summarize(plan), encodePlan(plan), ['']])
    expect(await store.read(workspaceId, plan.id)).toEqual(plan)
    expect((await store.list(workspaceId))).toEqual({ plans: [summarize(plan)], damaged: [] })
    expect((await caught(store.read(workspaceId, crypto.randomUUID()))).code).toBe('plan_not_found')
  })

  test('a write needs the current revision: missing is 400 with the current one, stale is 409 with what changed since', async () => {
    const store = createPlanStore(await tempRoot())
    await store.provision(workspaceId)
    const plan = await store.create(workspaceId, planFor())
    const missing = await caught(store.update(workspaceId, plan.id, { expectedRevision: undefined, required: true }, retitle('A')))
    expect([missing.status, missing.code, missing.details?.currentRevision]).toEqual([400, 'plan_revision_required', 1])
    const saved = await store.update(workspaceId, plan.id, { expectedRevision: 1, required: true }, plan => ({ ...retitle('A')(plan), changes: [...plan.changes, { seq: 2, at: plan.updatedAt, by: { kind: 'human' }, revision: 2, summary: 'Renamed A', kinds: ['plan'] }] }))
    expect(saved.revision).toBe(2)
    const stale = await caught(store.update(workspaceId, plan.id, { expectedRevision: 1, required: true }, retitle('B')))
    expect([stale.status, stale.code, stale.details?.currentRevision, stale.details?.since]).toEqual([409, 'plan_revision_conflict', 2, [{ revision: 2, summary: 'Renamed A' }]])
    // A change may keep the revision (generate, baseline) or raise it by one, nothing else.
    expect((await store.update(workspaceId, plan.id, { expectedRevision: 2, required: true }, retitle('C', false))).revision).toBe(2)
    expect((await caught(store.update(workspaceId, plan.id, { expectedRevision: 2, required: true }, plan => ({ ...plan, revision: plan.revision + 2 })))).code).toBe('invalid_plan_mutation')
  })

  test('one writer per Workspace: concurrent changes apply one after the other', async () => {
    const store = createPlanStore(await tempRoot())
    await store.provision(workspaceId)
    const plan = await store.create(workspaceId, planFor())
    await Promise.all(Array.from({ length: 10 }, () => store.update(workspaceId, plan.id, { expectedRevision: undefined, required: false }, retitle('x'))))
    expect((await store.read(workspaceId, plan.id)).revision).toBe(11)
  })

  test('a damaged file is listed as damaged and hides nothing else, and is never deleted', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    await store.provision(workspaceId)
    const good = await store.create(workspaceId, planFor())
    const damagedId = crypto.randomUUID()
    await writeFile(join(root, 'workspaces', workspaceId, 'planning', 'plans', `${damagedId}.json`), '{"half":')
    expect(await store.list(workspaceId)).toEqual({ plans: [summarize(good)], damaged: [{ id: damagedId }] })
    const read = await caught(store.read(workspaceId, damagedId))
    expect([read.status, read.code, (read as unknown as Error).message]).toEqual([500, 'plan_damaged', 'This plan file could not be read; do not delete it, report it.'])
    // After a rollback a newer plan reads as damaged: deleting it would lose it.
    for (const expectedRevision of [1, undefined]) expect((await caught(store.delete(workspaceId, damagedId, { expectedRevision, required: false }))).code).toBe('plan_damaged')
    expect((await store.list(workspaceId)).damaged).toEqual([{ id: damagedId }])
  })

  test('a file that cannot be read just now is a 503 to retry, not damage', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    await store.provision(workspaceId)
    const plan = await store.create(workspaceId, planFor())
    const path = join(root, 'workspaces', workspaceId, 'planning', 'plans', `${plan.id}.json`)
    await chmod(path, 0o000)
    try {
      const refused = await caught(store.read(workspaceId, plan.id))
      expect([refused.status, refused.code]).toEqual([503, 'store_unavailable'])
      expect((await caught(store.list(workspaceId))).code).toBe('store_unavailable')
      expect((await caught(store.delete(workspaceId, plan.id, { expectedRevision: undefined, required: false }))).code).toBe('store_unavailable')
    } finally { await chmod(path, 0o600) }
    expect(await store.read(workspaceId, plan.id)).toEqual(plan)
  })
})

describe('atomic saves', () => {
  test('a crash before the replace leaves the previous plan whole, and the stray temporary file is removed on the next start', async () => {
    const root = await tempRoot()
    const plan = await (async () => { const store = createPlanStore(root); await store.provision(workspaceId); return store.create(workspaceId, planFor()) })()
    const crashing = createPlanStore(root, { beforeReplace: async () => { throw Object.assign(new Error('power lost'), { code: 'EIO' }) } })
    expect((await caught(crashing.update(workspaceId, plan.id, { expectedRevision: 1, required: true }, retitle('lost')))).code).toBe('EIO')
    // The failed save removed its own temporary file; one left by a killed process is swept on the next start.
    const directory = join(root, 'workspaces', workspaceId, 'planning', 'plans')
    await writeFile(join(directory, `${plan.id}.json.${crypto.randomUUID()}.tmp`), '{"partial":')
    const restarted = createPlanStore(root)
    expect(await restarted.read(workspaceId, plan.id)).toEqual(plan)
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  test('a write that fails while writing removes its temporary file at once', async () => {
    const root = await tempRoot()
    const plan = await (async () => { const store = createPlanStore(root); await store.provision(workspaceId); return store.create(workspaceId, planFor()) })()
    const failing = createPlanStore(root, { beforeWrite: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } })
    expect((await caught(failing.update(workspaceId, plan.id, { expectedRevision: 1, required: true }, retitle('lost')))).code).toBe('ENOSPC')
    expect((await readdir(join(root, 'workspaces', workspaceId, 'planning', 'plans'))).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(await failing.read(workspaceId, plan.id)).toEqual(plan)
  })

  test('kill -9 during repeated saves never loses an acknowledged save and never leaves a half-written plan', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    await store.provision(workspaceId)
    const plan = await store.create(workspaceId, planFor())
    const writer = new URL('./fixtures/store-crash-writer.ts', import.meta.url).pathname
    for (let round = 0; round < 5; round += 1) {
      const child = Bun.spawn(['bun', writer, root, workspaceId, plan.id], { stdout: 'pipe', stderr: 'pipe' })
      const reader = child.stdout.getReader()
      let text = ''
      while (text.split('\n').filter(Boolean).length < 3 + round * 2) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`writer stopped: ${await new Response(child.stderr).text()}`)
        text += new TextDecoder().decode(chunk.value)
      }
      child.kill('SIGKILL')
      await child.exited
      const acknowledged = Math.max(...text.split('\n').filter(Boolean).map(Number))
      const reopened = createPlanStore(root)
      const stored = await reopened.read(workspaceId, plan.id)
      expect(stored.revision).toBeGreaterThanOrEqual(acknowledged)
      expect(stored.inputs.settings.title).toBe(`Saved ${stored.revision}`)
      expect(await reopened.list(workspaceId)).toMatchObject({ damaged: [] })
      expect((await readdir(join(root, 'workspaces', workspaceId, 'planning', 'plans'))).filter(name => name.endsWith('.tmp'))).toEqual([])
    }
  }, 60_000)
})

describe('bounded plans and listings', () => {
  test('a write past the plan size limit is refused with 413 in words and saves nothing', async () => {
    const store = createPlanStore(await tempRoot(), { maxPlanBytes: 20_000 })
    await store.provision(workspaceId)
    const plan = await store.create(workspaceId, planFor())
    const refused = await caught(store.update(workspaceId, plan.id, { expectedRevision: 1, required: true }, current => ({
      ...current, changes: [...current.changes, ...Array.from({ length: 200 }, (_, index) => ({ seq: index + 2, at: current.updatedAt, by: { kind: 'human' as const }, revision: 1, summary: 'x'.repeat(200), kinds: [] }))],
    })))
    expect([refused.status, refused.code]).toEqual([413, 'plan_too_large'])
    expect((refused as unknown as Error).message).toMatch(/^This change would make the plan [\d.]+ MB, more than the 0 MB a plan may hold; nothing was saved$/)
    expect(await store.read(workspaceId, plan.id)).toEqual(plan)
  })

  test('baselines that share inputs store them once, and the plan reads back whole', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    await store.provision(workspaceId)
    const option = { key: 'O1', label: 'Only', variant: { methods: [], purchases: [] }, status: { word: 'invalid input' as const, problems: [{ about: [], code: 'test' }] }, rows: [], metrics: [], inputsRevision: 1 }
    const earlier = { ...supplyRun, settings: { ...supplyRun.settings, title: 'Earlier' } }
    const baseline = (key: string, inputs: typeof supplyRun) => ({ key, name: key, at: '2026-11-11T08:00:00Z', by: { kind: 'human' as const }, option, inputs })
    const plan = await store.create(workspaceId, { ...planFor(), baselines: [baseline('B1', earlier), baseline('B2', earlier), baseline('B3', supplyRun)] })
    const file = encodePlan(plan)
    expect(file.frozenInputs.length).toBe(1)
    expect(file.baselines.map(entry => entry.inputs)).toEqual([file.frozenInputs[0]!.key, file.frozenInputs[0]!.key, 'current'])
    expect(await createPlanStore(root).read(workspaceId, plan.id)).toEqual(plan)
  })

  test('a listing reads only each file\'s summary line, never the plan', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    await store.provision(workspaceId)
    const plan = await store.create(workspaceId, planFor())
    const directory = join(root, 'workspaces', workspaceId, 'planning', 'plans')
    // A valid summary line before 3 MB that is not a plan: the listing never reaches it, opening the plan does.
    const id = crypto.randomUUID()
    await writeFile(join(directory, `${id}.json`), `${JSON.stringify({ ...summarize(plan), id })}\n${'x'.repeat(3_000_000)}\n`)
    expect((await store.list(workspaceId)).plans.map(entry => entry.id).sort()).toEqual([plan.id, id].sort())
    expect((await caught(store.read(workspaceId, id))).code).toBe('plan_damaged')
  })

  test('opening a plan whose summary line disagrees with the plan finds it damaged', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    await store.provision(workspaceId)
    const plan = await store.create(workspaceId, planFor())
    const path = join(root, 'workspaces', workspaceId, 'planning', 'plans', `${plan.id}.json`)
    const [, body] = (await Bun.file(path).text()).split('\n')
    await writeFile(path, `${JSON.stringify({ ...summarize(plan), title: 'Another title' })}\n${body}\n`)
    const refused = await caught(store.read(workspaceId, plan.id))
    expect([refused.code, (refused as unknown as Error).message]).toEqual(['plan_damaged', 'This plan file could not be read; do not delete it, report it.'])
    expect((await caught(store.delete(workspaceId, plan.id, { expectedRevision: undefined, required: false }))).code).toBe('plan_damaged')
  })

  test('listing plans near the file limit adds only a few MB of RSS', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    await store.provision(workspaceId)
    // Plans near the 4 MB file limit: 8 options of 1,500 dated rows each.
    const row = (index: number) => ({ job: `J${index}`, start: '2026-11-16T06:00:00Z', finish: '2026-11-16T07:00:00Z', uses: [{ resource: 'truck-1', from: '2026-11-16T06:00:00Z', to: '2026-11-16T07:00:00Z' }], float: { workingHours: 1.5, limitedBy: { kind: 'window-end' as const } } })
    const rows = Array.from({ length: 1_500 }, (_, index) => row(index))
    const option = (key: string) => ({ key, label: `Option ${key}`, variant: { methods: [], purchases: [] }, status: { word: 'invalid input' as const, problems: [{ about: [], code: 'test' }] }, rows, metrics: [], inputsRevision: 1 })
    const large = (): Plan => ({ ...planFor(), options: { at: '2026-11-11T08:00:00Z', by: { kind: 'human' }, options: Array.from({ length: 8 }, (_, index) => option(`O${index + 1}`)) } })
    const count = 9
    for (let index = 0; index < count; index += 1) await store.create(workspaceId, large())
    Bun.gc(true)
    const start = process.memoryUsage().rss
    let peak = start
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 1)
    const listing = await store.list(workspaceId)
    clearInterval(sampler)
    peak = Math.max(peak, process.memoryUsage().rss)
    expect(listing.plans.length).toBe(count)
    expect(peak - start).toBeLessThan(8_000_000)
  }, 120_000)
})
