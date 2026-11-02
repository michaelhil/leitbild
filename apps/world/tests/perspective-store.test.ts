import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorageBudget } from '@leitbild/module-runtime'
import { newWorkspaceId, resourceIdSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { simulationRunIdSchema } from '../src/core/model/ids.ts'
import { createPerspectiveStore } from '../src/core/perspectives/store.ts'

test('Perspective preparation survives reopening, rejects causal-key changes and serializes competing binding writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'world-perspective-store-')), workspaceId = newWorkspaceId()
  const runId = simulationRunIdSchema.parse('run-perspective-store')
  const configuration = { directory, workspaceId, workspaceRoot: directory, storageBudget: createStorageBudget({ root: directory }), runExists: async () => true }
  try {
    const store = createPerspectiveStore(configuration), requestId = crypto.randomUUID()
    const pending = await store.prepare({ runId, roleIds: ['blue'], requestId })
    expect(pending.admission.status).toBe('pending')
    expect(pending.admission.admissionGeneration).not.toBe(pending.admission.runIncarnation)
    const reopened = createPerspectiveStore(configuration)
    expect(await reopened.prepare({ runId, roleIds: ['blue'], requestId })).toEqual(pending)
    await expect(reopened.prepare({ runId, roleIds: ['red'], requestId })).rejects.toMatchObject({ code: 'perspective_prepare_conflict' })
    const binding = {
      perspective: pending.admission.resource, admissionGeneration: pending.admission.admissionGeneration,
      room: workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'agents', type: 'agents.room', id: resourceIdSchema.parse('private-room') }),
      actualAgentId: 'actual-agent', runtimeGeneration: crypto.randomUUID(), templateId: 'template', templateRevision: 'template-revision',
    }
    const update = () => reopened.change(pending.admission.resource.id, 0, record => ({ ...record, admission: { ...record.admission, status: 'active', revision: 1, binding } }))
    const outcomes = await Promise.allSettled([update(), update()])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'perspective_revision_conflict' } })
    const saved = await createPerspectiveStore(configuration).read(pending.admission.resource.id)
    expect(saved.admission).toMatchObject({ status: 'active', revision: 1, binding })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Run-incarnation rotation and deletion invalidate old admissions without rebinding or affecting another Run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'world-perspective-incarnation-')), workspaceId = newWorkspaceId()
  const firstRun = simulationRunIdSchema.parse('run-first'), secondRun = simulationRunIdSchema.parse('run-second')
  const present = new Set([firstRun, secondRun])
  const config = { directory, workspaceId, workspaceRoot: directory, storageBudget: createStorageBudget({ root: directory }), runExists: async (id: typeof firstRun) => present.has(id) }
  try {
    const store = createPerspectiveStore(config)
    const first = await store.prepare({ runId: firstRun, roleIds: ['blue'], requestId: crypto.randomUUID() })
    const second = await store.prepare({ runId: secondRun, roleIds: ['red'], requestId: crypto.randomUUID() })
    await store.rotateRun(firstRun)
    const restored = createPerspectiveStore(config)
    expect(await restored.admission(first)).toMatchObject({ status: 'revoked', revokedReason: 'The owning Run incarnation has ended' })
    await expect(restored.change(first.admission.resource.id, 0, record => record)).rejects.toMatchObject({ code: 'perspective_revoked' })
    await restored.assertCurrent(second)
    const fresh = await restored.prepare({ runId: firstRun, roleIds: ['blue'], requestId: crypto.randomUUID() })
    expect(fresh.admission.runIncarnation).not.toBe(first.admission.runIncarnation)
    expect(fresh.admission.admissionGeneration).not.toBe(first.admission.admissionGeneration)
    present.delete(secondRun)
    await expect(restored.assertCurrent(second)).rejects.toMatchObject({ code: 'perspective_revoked' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
