// planning.plan.read sections into the screen's model: every page is followed, every part validated
// with the stored plan's schemas, and a missing section is an error, never an empty plan.
import { describe, expect, test } from 'bun:test'
import { createPlanningClient } from './api.ts'
import { supplyRunPlanned, trainAPlanned } from './fixtures/plans.ts'
import type { PlanModel } from './model.ts'
import { loadPlan } from './read-plan.ts'

const workspace = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'

/** A test double for Planning's read: serves a model as sections, two items per page. */
const serving = (model: PlanModel, drop?: string) => {
  const reads: string[] = []
  const { inputs } = model
  const lists: Record<string, readonly unknown[]> = {
    jobs: [...inputs.jobs.map(job => ({ job })), ...inputs.links.map(link => ({ link })), ...inputs.methods.map(method => ({ method }))],
    rules: inputs.rules.map(rule => ({ rule })),
    crews: [...inputs.calendars.map(calendar => ({ calendar })), ...inputs.resources.map(resource => ({ resource })), ...inputs.purchases.map(purchase => ({ purchase }))],
    sources: [...inputs.equipment.map(equipment => ({ equipment })), ...inputs.groups.map(group => ({ group })), ...inputs.world.facts.map(fact => ({ fact }))],
    options: model.options?.items ?? [],
    schedule: Object.values(model.rows)[0] ?? [],
    history: [],
  }
  const client = createPlanningClient(workspace, async (_path, init) => {
    const body = JSON.parse(String(init?.body)) as { input: { section: string; cursor?: string; option?: string } }
    const { section, cursor } = body.input
    reads.push(`${section}${cursor === undefined ? '' : `@${cursor}`}`)
    const start = cursor === undefined ? 0 : Number(cursor)
    const data = section === 'summary'
      ? { plan: { id: model.id, title: model.title, revision: model.revision, updatedAt: model.updatedAt }, settings: inputs.settings, goals: inputs.goals, refreshedAt: inputs.world.refreshedAt, attention: model.attention, certifiedSize: model.certifiedSize }
      : {
        items: lists[section]!.slice(start, start + 2), ...(start + 2 < lists[section]!.length ? { more: String(start + 2) } : {}),
        ...(section === 'options' ? { at: model.options?.at ?? null, recommended: model.options?.recommended ?? null } : {}),
        ...(section === 'schedule' ? { option: body.input.option } : {}),
      }
    const sections = section === drop ? [{ id: 'other', title: 'Other', data: {} }] : [{ id: section, title: section, data }]
    return Response.json({ result: { target: { kind: 'resource', resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: model.id } }, title: model.title, observedAt: '2026-11-12T09:00:00.000Z', sections } })
  })
  return { client, reads }
}

describe('reading a plan', () => {
  test('the sections assemble into the same plan, every page followed, with the recommended schedule', async () => {
    for (const model of [trainAPlanned(), supplyRunPlanned()]) {
      const { client, reads } = serving(model)
      const loaded = await loadPlan(client, model.id)
      expect(loaded.inputs).toEqual(model.inputs)
      expect(loaded.options).toEqual(model.options)
      expect(loaded.rows).toEqual(model.rows)
      expect(reads.filter(read => read.startsWith('jobs')).length).toBe(Math.ceil((model.inputs.jobs.length + model.inputs.links.length + model.inputs.methods.length) / 2))
    }
  })

  test('a section missing from the answer is an error, not an empty plan', async () => {
    const { client } = serving(trainAPlanned(), 'rules')
    await expect(loadPlan(client, trainAPlanned().id)).rejects.toThrow('Planning answered without the rules section.')
  })
})
