import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createPlanStore } from './store.ts'
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
    expect(await Bun.file(join(root, 'workspaces', workspaceId, 'planning', 'plans', `${plan.id}.json`)).json()).toEqual(plan)
    expect((await store.list(workspaceId))).toEqual({ plans: [plan], damaged: [] })
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

  test('a damaged file is listed as damaged and hides nothing else; it can be deleted only without a revision', async () => {
    const root = await tempRoot()
    const store = createPlanStore(root)
    await store.provision(workspaceId)
    const good = await store.create(workspaceId, planFor())
    const damagedId = crypto.randomUUID()
    await writeFile(join(root, 'workspaces', workspaceId, 'planning', 'plans', `${damagedId}.json`), '{"half":')
    expect(await store.list(workspaceId)).toEqual({ plans: [good], damaged: [{ id: damagedId }] })
    expect((await caught(store.read(workspaceId, damagedId))).code).toBe('plan_damaged')
    expect((await caught(store.delete(workspaceId, damagedId, { expectedRevision: 1, required: false }))).code).toBe('plan_damaged')
    await store.delete(workspaceId, damagedId, { expectedRevision: undefined, required: false })
    expect(await store.list(workspaceId)).toEqual({ plans: [good], damaged: [] })
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
