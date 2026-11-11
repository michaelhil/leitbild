import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, workspaceIdSchema } from '@leitbild/contracts'
import { createStudyStore } from './study-store.ts'
import { createPlanningService } from './service.ts'
import { createPlanningModuleApi } from './module-api.ts'

test('discovery describes real output shapes and invalid owner output is refused at the wire boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-output-'))
  try {
    const workspaceId = workspaceIdSchema.parse(crypto.randomUUID())
    const store = createStudyStore(directory)
    await store.provision(workspaceId)
    const service = createPlanningService({ store, sources: { capture: async () => { throw new Error('No source read expected') }, qualify: async () => ({ allowed: true }) } })
    const handle = createPlanningModuleApi({ service: { ...service, create: async (...args) => ({ ...await service.create(...args), revision: -1 }) } })
    const path = `http://planning/internal/workspaces/${workspaceId}/capabilities`
    const catalog = await handle(new Request(path), new URL(path))
    const body = await catalog!.json() as { capabilities: Array<{ id: string; outputSchema: Record<string, unknown> }> }
    expect(body.capabilities.find(item => item.id === 'planning.study.solve')?.outputSchema.properties).toHaveProperty('candidate')
    expect(body.capabilities.every(item => Object.keys(item.outputSchema).length > 1)).toBe(true)
    const invoke = `${path}/planning.study.create/invoke`
    const response = await handle(new Request(invoke, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, capabilityId: 'planning.study.create', access: accessContextSchema.parse({ workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'human' } }), input: { title: 'Boundary test', problem: { profile: 'elapsed-fs', axis: { run: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' }, unit: 'second' }, horizon: { start: 0, end: 60 }, asOf: 0, supplies: [], activities: [{ id: 'a', title: 'A', modeId: 'chosen', durationSeconds: 1, demands: [], tardinessWeight: 0, progress: { kind: 'planned' } }], precedences: [], priorityOrder: ['a'], objectives: [] } } }) }), new URL(invoke))
    expect(response?.status).toBe(500)
    expect(await response!.json()).toMatchObject({ error: { code: 'invalid_planning_result' } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

// L2 (10 Nov 2026): Host's delete card refuses a delete Capability with
// required input, and every Workspace page holding a Study stopped loading.
test('delete takes no input so the Workspace delete card can offer it; the envelope revision is its optional precondition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'planning-delete-'))
  try {
    const workspaceId = workspaceIdSchema.parse(crypto.randomUUID())
    const store = createStudyStore(directory)
    await store.provision(workspaceId)
    const service = createPlanningService({ store, sources: { capture: async () => { throw new Error('No source read expected') }, qualify: async () => ({ allowed: true }) } })
    const handle = createPlanningModuleApi({ service })
    const base = `http://planning/internal/workspaces/${workspaceId}/capabilities`
    const access = () => accessContextSchema.parse({ workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'human' } })
    const invoke = async (capabilityId: string, body: Record<string, unknown>) => {
      const url = `${base}/${capabilityId}/invoke`
      return (await handle(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, capabilityId, access: access(), ...body }) }), new URL(url)))!
    }
    const catalog = await (await handle(new Request(base), new URL(base)))!.json() as { capabilities: Array<{ id: string; kind: string; risk: string; inputSchema: { required?: string[] } }> }
    const remove = catalog.capabilities.find(item => item.id === 'planning.study.delete')!
    expect(remove).toMatchObject({ kind: 'command', risk: 'destructive' })
    expect(remove.inputSchema.required ?? []).toEqual([])

    const created = await invoke('planning.study.create', { input: { title: 'Delete test', problem: { profile: 'elapsed-fs', axis: { run: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' }, unit: 'second' }, horizon: { start: 0, end: 60 }, asOf: 0, supplies: [], activities: [{ id: 'a', title: 'A', modeId: 'chosen', durationSeconds: 1, demands: [], tardinessWeight: 0, progress: { kind: 'planned' } }], precedences: [], priorityOrder: ['a'], objectives: [] } } })
    expect(created.status).toBe(200)
    const { result } = await created.json() as { result: { study: { id: string; revision: number } } }
    const resource = { workspaceId, moduleId: 'planning', type: 'planning.study', id: result.study.id }

    const stale = await invoke('planning.study.delete', { resource, input: {}, expectedRevision: result.study.revision + 1 })
    expect(stale.status).toBe(409)
    const deleted = await invoke('planning.study.delete', { resource, input: {} })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ result: { deleted: true } })
    expect((await invoke('planning.study.delete', { resource, input: {} })).status).toBe(404)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
