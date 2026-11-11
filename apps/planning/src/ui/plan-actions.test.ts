// The screen's actions against a test double of Host and Planning: the order of calls, the revision in
// every write, refusals in words, Cancel, and that the screen calls only the nine operations and never
// writes to World.
import { describe, expect, test } from 'bun:test'
import { createPlanningClient } from './api.ts'
import { modelOf, supplyRunInputs, trainAPlanned } from './fixtures/plans.ts'
import type { PlanModel } from './model.ts'
import { createPlanActions } from './plan-actions.ts'

const workspace = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
const nine = new Set(['world.simulation-run.planning-facts', 'planning.plan.create', 'planning.plan.edit', 'planning.plan.generate', 'planning.plan.explain', 'planning.plan.read', 'planning.plan.baseline', 'planning.sources.refresh', 'planning.plan.delete'])

interface Call { readonly capability: string; readonly expectedRevision?: number; readonly input: Record<string, unknown> }

/** Serves one plan as read sections and answers writes; each saved write raises the revision by one. */
const host = (start: PlanModel, refusal?: { status: number; code: string; message: string }) => {
  let plan = start
  const calls: Call[] = []
  const lists = (): Record<string, readonly unknown[]> => ({
    jobs: [...plan.inputs.jobs.map(job => ({ job })), ...plan.inputs.links.map(link => ({ link })), ...plan.inputs.methods.map(method => ({ method }))],
    rules: plan.inputs.rules.map(rule => ({ rule })),
    crews: [...plan.inputs.calendars.map(calendar => ({ calendar })), ...plan.inputs.resources.map(resource => ({ resource })), ...plan.inputs.purchases.map(purchase => ({ purchase }))],
    sources: [...plan.inputs.equipment.map(equipment => ({ equipment })), ...plan.inputs.groups.map(group => ({ group })), ...plan.inputs.world.facts.map(fact => ({ fact }))],
    options: plan.options?.items ?? [], schedule: Object.values(plan.rows)[0] ?? [],
  })
  const write = () => ({ plan: { id: plan.id, title: plan.title, revision: plan.revision }, changed: ['Saved the change.'], attention: [], problems: [] })
  const save = (change: (inputs: PlanModel['inputs']) => PlanModel['inputs']) => { plan = { ...plan, revision: plan.revision + 1, inputs: change(plan.inputs) } }
  const client = createPlanningClient(workspace, async (path, init) => {
    const url = String(path)
    if (init?.method !== 'POST') return Response.json({ workspaceId: workspace, modules: [], resources: [] })
    const capability = decodeURIComponent(url.split('/capabilities/')[1]!.replace('/invoke', ''))
    const body = JSON.parse(String(init.body)) as { expectedRevision?: number; input: Record<string, unknown> }
    calls.push({ capability, ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }), input: body.input })
    if (init.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError')
    if (refusal !== undefined && capability !== 'planning.plan.read') return Response.json({ error: { code: refusal.code, message: refusal.message } }, { status: refusal.status })
    switch (capability) {
      case 'planning.plan.read': {
        const section = String(body.input.section)
        const data = section === 'summary'
          ? { plan: { id: plan.id, title: plan.title, revision: plan.revision, updatedAt: plan.updatedAt }, settings: plan.inputs.settings, goals: plan.inputs.goals, refreshedAt: plan.inputs.world.refreshedAt, attention: plan.attention, certifiedSize: plan.certifiedSize }
          : { items: lists()[section], ...(section === 'options' ? { at: plan.options?.at ?? null, recommended: plan.options?.recommended ?? null } : {}), ...(section === 'schedule' ? { option: body.input.option } : {}) }
        return Response.json({ result: { target: { kind: 'resource', resource: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: plan.id } }, title: plan.title, observedAt: '2026-11-12T09:00:00.000Z', sections: [{ id: section, title: section, data }] } })
      }
      case 'planning.plan.edit': {
        const edits = body.input.edits as Array<{ edit: string; run?: string }>
        if (body.input.preview === true) return Response.json({ result: { ...write(), preview: { saved: false, consequence: 'Nothing else moves.', violations: [], weakens: [] } } })
        save(inputs => {
          const run = edits.find(edit => edit.edit === 'plan' && typeof edit.run === 'string')?.run
          return run === undefined ? inputs : { ...inputs, settings: { ...inputs.settings, run: { id: run, linkedAt: '2026-11-12T09:00:00.000Z' } } }
        })
        return Response.json({ result: write() })
      }
      case 'planning.sources.refresh':
        save(inputs => ({ ...inputs, world: { ...inputs.world, refreshedAt: '2026-11-12T09:01:00.000Z' } }))
        return Response.json({ result: { ...write(), changed: ['Read 3 World values.'] } })
      case 'planning.plan.generate':
        return Response.json({ result: { plan: { id: plan.id, revision: plan.revision }, options: [], recommended: plan.options?.recommended, text: 'One option, validated feasible.' } })
      case 'world.simulation-run.planning-facts': {
        const subjects = body.input.subjects as string[] | undefined
        const item = (locator: string) => ({ locator, label: 'Truck 9', kind: 'vehicle', facts: [{ id: 'unit:truck-9/property/payloadKg', label: 'Payload', quantity: 'mass', unit: 'kg', value: 900, basis: 'configured', at: '2026-09-03T08:00:00Z' }] })
        return Response.json({ result: { run: { workspaceId: workspace, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }, observedAt: '2026-09-03T08:00:00Z', items: (subjects ?? ['einsatz/unit/unit%3Atruck-9']).map(item) } })
      }
      default:
        return Response.json({ result: write() })
    }
  })
  return { client, calls, actions: createPlanActions(client, start.id), current: () => plan }
}

describe('plan screen actions', () => {
  test('linking a Run is one plan edit and then a refresh, each at the current revision; World is only read', async () => {
    const start = modelOf(supplyRunInputs())
    const double = host(start)
    const shown = await double.actions.link(start, 'run-1', null)
    const writes = double.calls.filter(call => call.capability !== 'planning.plan.read')
    expect(writes).toEqual([
      { capability: 'planning.plan.edit', expectedRevision: start.revision, input: { edits: [{ edit: 'plan', run: 'run-1' }] } },
      { capability: 'planning.sources.refresh', expectedRevision: start.revision + 1, input: { plan: start.id } },
    ])
    expect(shown.model.inputs.settings.run?.id).toBe('run-1')
    expect(shown.model.revision).toBe(start.revision + 2)
    expect(shown.notice).toBe('Linked. Read 3 World values.')
  })

  test('an edit is previewed at the current revision; applying sends the authority given', async () => {
    const start = trainAPlanned()
    const double = host(start)
    const preview = await double.actions.preview(start, [{ edit: 'remove', what: 'rule', key: 'R1' }], 'Remove the rule')
    expect(preview.result?.preview?.saved).toBe(false)
    const shown = await double.actions.apply(start, [{ edit: 'remove', what: 'rule', key: 'R1' }], { name: 'Shift manager', reason: 'Train B work moved' }, 'opt-1')
    expect(double.calls.filter(call => call.capability === 'planning.plan.edit').map(call => [call.expectedRevision, call.input])).toEqual([
      [start.revision, { edits: [{ edit: 'remove', what: 'rule', key: 'R1' }], preview: true }],
      [start.revision, { edits: [{ edit: 'remove', what: 'rule', key: 'R1' }], authority: { name: 'Shift manager', reason: 'Train B work moved' } }],
    ])
    // No World item was named, so nothing is read from World again.
    expect(double.calls.some(call => call.capability === 'planning.sources.refresh')).toBe(false)
    expect(shown.option).toBe('opt-1')
  })

  test('adding a World item on a linked plan reads World again after saving', async () => {
    const inputs = supplyRunInputs()
    const start = modelOf({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: '2026-09-03T08:00:00Z' } } })
    const double = host(start)
    const truck = await double.actions.detail(start, 'einsatz/unit/unit%3Atruck-9')
    expect(truck.facts[0]!.label).toBe('Payload')
    await double.actions.apply(start, [{ edit: 'resource', key: 'Truck-9', label: 'Truck 9', kind: 'tool', count: 1, calendar: 'exercise', attributes: [], locator: truck.locator, source: { by: 'planner' } }], null, null)
    expect(double.calls.map(call => call.capability).filter(capability => capability !== 'planning.plan.read')).toEqual(['world.simulation-run.planning-facts', 'planning.plan.edit', 'planning.sources.refresh'])
  })

  test('refusals become previews in words; a protected item and a missing agreement differ', async () => {
    const start = trainAPlanned()
    const protectedItem = await host(start, { status: 409, code: 'protected_equipment', message: 'Service Water Pump B is protected.' }).actions.preview(start, [{ edit: 'job', key: 'X', equipment: ['SWB'] }], 'Tag out SW B')
    expect(protectedItem.refusal).toEqual({ text: 'Service Water Pump B is protected.', needsAuthority: false })
    const authority = await host(start, { status: 409, code: 'needs_authority', message: 'Removing a protected rule needs someone\'s agreement.' }).actions.preview(start, [{ edit: 'remove', what: 'rule', key: 'R1' }], 'Remove')
    expect(authority.refusal?.needsAuthority).toBe(true)
    await expect(host(start, { status: 500, code: 'invalid_planning_result', message: 'x' }).actions.preview(start, [{ edit: 'remove', what: 'rule', key: 'R1' }], 'Remove')).rejects.toThrow()
  })

  test('Generate sends the revision; Cancel and refusals still read the plan again and say what happened', async () => {
    const start = trainAPlanned()
    const done = await host(start).actions.generate(start, {}, new AbortController().signal, null)
    expect([done.notice, done.error, done.option]).toEqual(['One option, validated feasible.', null, 'opt-1'])
    const stop = new AbortController()
    stop.abort()
    const cancelled = host(start)
    const shown = await cancelled.actions.generate(start, {}, stop.signal, 'opt-1')
    expect(shown.notice).toContain('Cancelled.')
    expect(cancelled.calls.some(call => call.capability === 'planning.plan.read')).toBe(true)
    const large = await host(start, { status: 413, code: 'above_certified_size', message: 'Too large for the certified size: certified for single-train work weeks up to 100 jobs; this plan has 340.' }).actions.generate(start, {}, new AbortController().signal, null)
    expect(large.error).toBe('Too large for the certified size: certified for single-train work weeks up to 100 jobs; this plan has 340.')
  })

  test('across every action the screen calls only the nine operations, and the only World one is the facts query', async () => {
    const inputs = supplyRunInputs()
    const start = modelOf({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: '2026-09-03T08:00:00Z' } } })
    const double = host(start)
    await double.actions.search(start, 'truck')
    await double.actions.refresh(start, null)
    await double.actions.generate(double.current(), {}, new AbortController().signal, null)
    await double.actions.baseline(double.current(), 'opt-1', 'Base', '')
    const used = new Set(double.calls.map(call => call.capability))
    expect([...used].filter(capability => !nine.has(capability))).toEqual([])
    expect([...used].filter(capability => capability.startsWith('world.'))).toEqual(['world.simulation-run.planning-facts'])
    // The search reads the found items' values in one request.
    expect(double.calls.filter(call => call.capability === 'world.simulation-run.planning-facts').map(call => Object.keys(call.input))).toEqual([['text', 'limit'], ['subjects']])
  })
})
