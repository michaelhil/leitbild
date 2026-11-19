// The `about` link from a plan Resource to its World Run: read from the plan in full once per summary
// line, never again while the plan is unchanged, and never at the listing's expense.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { ABOUT_RELATION, moduleResourceDescriptorSchema } from '@leitbild/contracts'
import { createPlanDefinitions } from '../definitions/index.ts'
import { planningError } from '../errors.ts'
import { createHarness, type Harness } from './fixtures/harness.ts'
import { createPlanningModuleApi } from './module-api.ts'

/** A plan Resource as it is on the wire, checked against the contract. */
interface Published { readonly ref: { readonly id: string }; readonly links: unknown[] }

const open: Harness[] = []
afterAll(async () => { for (const harness of open) await harness.close() })

/** A second Module API over the harness's store that counts the plans its listing reads in full. */
const listingOver = (harness: Harness) => {
  const fullReads: string[] = []
  const failing = new Map<string, Error>()
  const handle = createPlanningModuleApi({
    operations: harness.operations, definitions: createPlanDefinitions(),
    store: {
      ...harness.store,
      read: async (workspaceId, planId) => {
        fullReads.push(planId)
        const failure = failing.get(planId)
        if (failure !== undefined) throw failure
        return harness.store.read(workspaceId, planId)
      },
    },
  })
  const send = async (path: string, init?: RequestInit) => (await handle(new Request(`http://planning${path}`, init), new URL(`http://planning${path}`)))!
  const list = async (): Promise<{ readonly status: number; readonly resources: Published[]; readonly fullReads: string[] }> => {
    fullReads.length = 0
    const response = await send(`/internal/workspaces/${harness.workspaceId}/resources`)
    const body = await response.json() as { resources?: Published[] }
    for (const entry of body.resources ?? []) moduleResourceDescriptorSchema.parse(entry)
    return { status: response.status, resources: body.resources ?? [], fullReads: [...fullReads] }
  }
  return { list, send, failing }
}

const start = async () => {
  const harness = await createHarness()
  open.push(harness)
  return { harness, ...listingOver(harness) }
}

const linkedPlan = async (harness: Harness, run: string) => {
  const created = await harness.create('blank')
  const linked = await harness.call('planning.plan.edit', { resource: created.id, input: { edits: [{ edit: 'plan', run }] }, expectedRevision: created.revision })
  if (linked.status !== 200) throw new Error(`link failed: ${JSON.stringify(linked.body)}`)
  return { id: created.id, revision: linked.body.result.plan.revision as number }
}

const planFile = (harness: Harness, planId: string) => join(harness.root, 'workspaces', harness.workspaceId, 'planning', 'plans', `${planId}.json`)
const of = (resources: readonly Published[], planId: string) => resources.find(entry => entry.ref.id === planId)
const aboutRun = (harness: Harness, run: string) => [{ rel: ABOUT_RELATION, ref: { workspaceId: harness.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run } }]

describe('a plan Resource is about its World Run', () => {
  test('a linked plan publishes one about link to its Run; an unlinked plan publishes none and is not read', async () => {
    const { harness, list } = await start()
    const linked = await linkedPlan(harness, 'run-a')
    const unlinked = await harness.create('blank')
    const listing = await list()
    expect(listing.status).toBe(200)
    expect(ABOUT_RELATION).toBe('about')
    expect(of(listing.resources, linked.id)!.links).toEqual(aboutRun(harness, 'run-a'))
    expect(of(listing.resources, unlinked.id)!.links).toEqual([])
    expect(listing.fullReads).toEqual([linked.id])
  })

  test('an unchanged linked plan is never read in full again; a changed one is read once more', async () => {
    const { harness, list } = await start()
    const first = await linkedPlan(harness, 'run-a')
    const second = await linkedPlan(harness, 'run-b')
    expect((await list()).fullReads.sort()).toEqual([first.id, second.id].sort())

    const again = await list()
    expect(again.fullReads).toEqual([])
    expect(of(again.resources, first.id)!.links).toEqual(aboutRun(harness, 'run-a'))
    expect(of(again.resources, second.id)!.links).toEqual(aboutRun(harness, 'run-b'))

    // A new revision of one plan: that plan is read once, the other not at all, and the link follows the plan.
    const moved = await harness.call('planning.plan.edit', { resource: first.id, input: { edits: [{ edit: 'plan', run: 'run-c' }] }, expectedRevision: first.revision })
    expect(moved.body.result.plan.revision).toBe(first.revision + 1)
    const changed = await list()
    expect(changed.fullReads).toEqual([first.id])
    expect(of(changed.resources, first.id)!.links).toEqual(aboutRun(harness, 'run-c'))
    expect(of(changed.resources, second.id)!.links).toEqual(aboutRun(harness, 'run-b'))
    expect((await list()).fullReads).toEqual([])

    // Unlinked: no link, and nothing to read.
    await harness.call('planning.plan.edit', { resource: first.id, input: { edits: [{ edit: 'plan', run: null }] }, expectedRevision: first.revision + 1 })
    const unlinked = await list()
    expect(unlinked.fullReads).toEqual([])
    expect(of(unlinked.resources, first.id)!.links).toEqual([])
  })

  test('a plan whose summary reads but whose body is damaged publishes no link, and the listing succeeds', async () => {
    const { harness, list } = await start()
    const sound = await linkedPlan(harness, 'run-a')
    const broken = await linkedPlan(harness, 'run-b')
    const text = await Bun.file(planFile(harness, broken.id)).text()
    await Bun.write(planFile(harness, broken.id), `${text.slice(0, text.indexOf('\n'))}\n{"not":"a plan"}\n`)
    expect((await harness.call('planning.plan.read', { resource: broken.id })).body.error.code).toBe('plan_damaged')

    const listing = await list()
    expect(listing.status).toBe(200)
    expect(of(listing.resources, sound.id)!.links).toEqual(aboutRun(harness, 'run-a'))
    expect(of(listing.resources, broken.id)!.links).toEqual([])
    expect(listing.fullReads.sort()).toEqual([sound.id, broken.id].sort())
    // Damaged under the same summary line stays damaged: it is not read in full on every listing.
    const again = await list()
    expect(again.fullReads).toEqual([])
    expect(of(again.resources, broken.id)!.links).toEqual([])
  })

  test('a plan the store cannot read just now publishes no link, the listing succeeds, and the next listing reads it', async () => {
    const { harness, list, failing } = await start()
    const sound = await linkedPlan(harness, 'run-a')
    const unread = await linkedPlan(harness, 'run-b')
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      failing.set(unread.id, planningError(503, 'store_unavailable', 'Planning could not read its files just now; try again'))
      const listing = await list()
      expect(listing.status).toBe(200)
      expect(of(listing.resources, sound.id)!.links).toEqual(aboutRun(harness, 'run-a'))
      expect(of(listing.resources, unread.id)!.links).toEqual([])
      expect(logged).toHaveBeenCalledTimes(1)

      // Deleted between the listing's summary read and the full read: no link, and nothing to report.
      failing.set(unread.id, planningError(404, 'plan_not_found', 'Plan not found'))
      const missing = await list()
      expect(missing.status).toBe(200)
      expect(of(missing.resources, unread.id)!.links).toEqual([])
      expect(logged).toHaveBeenCalledTimes(1)

      failing.clear()
      const recovered = await list()
      expect(recovered.fullReads).toEqual([unread.id])
      expect(of(recovered.resources, unread.id)!.links).toEqual(aboutRun(harness, 'run-b'))
    } finally { logged.mockRestore() }
  })

  test('a Run id that cannot name a Resource publishes no link and does not fail the listing', async () => {
    const { harness, list } = await start()
    const plan = await linkedPlan(harness, 'not a resource id')
    const listing = await list()
    expect(listing.status).toBe(200)
    expect(of(listing.resources, plan.id)!.links).toEqual([])
    expect((await list()).fullReads).toEqual([])
  })

  test('a deleted plan leaves the memo: the same file put back is read in full again', async () => {
    const { harness, list } = await start()
    const kept = await linkedPlan(harness, 'run-a')
    const gone = await linkedPlan(harness, 'run-b')
    await list()
    const text = await Bun.file(planFile(harness, gone.id)).text()
    expect((await harness.call('planning.plan.delete', { resource: gone.id, expectedRevision: gone.revision })).status).toBe(200)

    const without = await list()
    expect(without.fullReads).toEqual([])
    expect(of(without.resources, gone.id)).toBeUndefined()
    expect(of(without.resources, kept.id)!.links).toEqual(aboutRun(harness, 'run-a'))

    // Byte for byte the plan the memo knew (same id, revision and updatedAt): only a dropped entry reads it again.
    await Bun.write(planFile(harness, gone.id), text)
    const back = await list()
    expect(back.fullReads).toEqual([gone.id])
    expect(of(back.resources, gone.id)!.links).toEqual(aboutRun(harness, 'run-b'))
    expect((await list()).fullReads).toEqual([])
  })

  test('a removed Workspace leaves the memo', async () => {
    const { harness, list, send } = await start()
    const plan = await linkedPlan(harness, 'run-a')
    await list()
    const text = await Bun.file(planFile(harness, plan.id)).text()
    const workspace = `/internal/workspaces/${harness.workspaceId}`
    expect((await send(workspace, { method: 'DELETE' })).status).toBe(204)
    expect((await send(workspace, { method: 'PUT', body: JSON.stringify({ workspaceId: harness.workspaceId }) })).status).toBe(201)
    await Bun.write(planFile(harness, plan.id), text)
    const listing = await list()
    expect(listing.fullReads).toEqual([plan.id])
    expect(of(listing.resources, plan.id)!.links).toEqual(aboutRun(harness, 'run-a'))
  })
})
