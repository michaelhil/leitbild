// The screen's actions against a test double of Host and Planning: the order of calls, the revision in
// every write, refusals in words, Cancel, and that the screen calls only the nine operations and never
// writes to World.
import { describe, expect, test } from 'bun:test'
import { createPlanningClient } from './api.ts'
import { modelOf, optionOf, runBasis, status, supplyRunInputs, trainAPlanned } from './fixtures/plans.ts'
import type { PlanModel } from './model.ts'
import { createPlanActions } from './plan-actions.ts'

const workspace = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
const nine = new Set(['world.simulation-run.planning-facts', 'planning.plan.create', 'planning.plan.edit', 'planning.plan.generate', 'planning.plan.explain', 'planning.plan.read', 'planning.plan.baseline', 'planning.sources.refresh', 'planning.plan.delete'])

interface Call { readonly capability: string; readonly expectedRevision?: number; readonly input: Record<string, unknown> }

/** Serves one plan as read sections and answers writes; each saved write raises the revision by one. */
const host = (start: PlanModel, refusal?: { status: number; code: string; message: string; details?: Record<string, unknown> }) => {
  let plan = start
  const calls: Call[] = []
  const lists = (): Record<string, readonly unknown[]> => ({
    jobs: [...plan.inputs.jobs.map(job => ({ job })), ...plan.inputs.links.map(link => ({ link })), ...plan.inputs.methods.map(method => ({ method }))],
    rules: plan.inputs.rules.map(rule => ({ rule })),
    crews: [...plan.inputs.calendars.map(calendar => ({ calendar })), ...plan.inputs.resources.map(resource => ({ resource })), ...plan.inputs.purchases.map(purchase => ({ purchase }))],
    sources: [...plan.inputs.equipment.map(equipment => ({ equipment })), ...plan.inputs.groups.map(group => ({ group })), ...plan.inputs.world.facts.map(fact => ({ fact }))],
    options: plan.options?.items ?? [], schedule: Object.values(plan.rows)[0] ?? [],
  })
  const write = () => ({ plan: { id: plan.id, title: plan.title, revision: plan.revision }, target: { kind: 'resource', ref: { workspaceId: workspace, moduleId: 'planning', type: 'planning.plan', id: plan.id } }, changed: ['Saved the change.'], attention: [], problems: [] })
  const save = (change: (inputs: PlanModel['inputs']) => PlanModel['inputs']) => { plan = { ...plan, revision: plan.revision + 1, inputs: change(plan.inputs) } }
  const client = createPlanningClient(workspace, async (path, init) => {
    const url = String(path)
    if (init?.method !== 'POST') return Response.json({ workspaceId: workspace, modules: [], resources: [] })
    const capability = decodeURIComponent(url.split('/capabilities/')[1]!.replace('/invoke', ''))
    const body = JSON.parse(String(init.body)) as { expectedRevision?: number; input: Record<string, unknown> }
    calls.push({ capability, ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }), input: body.input })
    if (init.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError')
    if (refusal !== undefined && capability !== 'planning.plan.read') return Response.json({ error: { code: refusal.code, message: refusal.message, ...(refusal.details === undefined ? {} : { details: refusal.details }) } }, { status: refusal.status })
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
      case 'planning.plan.explain':
        return Response.json({ result: { lines: [`Not possible: ${String(body.input.option)} needs 37 h of work, but only 32 h exist.`], items: [] } })
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
    // Not the Module's change lines (maint's walk S-03: raw locators and "Committed job steps 0 1").
    expect(shown.notice).toBe('Linked. World values read; World returned none for this plan.')
  })

  test('an edit is previewed at the current revision; applying sends the authority given', async () => {
    const start = trainAPlanned()
    const double = host(start)
    const preview = await double.actions.preview(start, [{ edit: 'remove', what: 'rule', key: 'R1' }], 'Remove the rule')
    expect(preview.result?.preview?.saved).toBe(false)
    const shown = await double.actions.apply(start, [{ edit: 'remove', what: 'rule', key: 'R1' }], { name: 'Shift manager', reason: 'Train B work moved' }, 'opt-1', 'Remove the rule')
    expect(double.calls.filter(call => call.capability === 'planning.plan.edit').map(call => [call.expectedRevision, call.input])).toEqual([
      [start.revision, { edits: [{ edit: 'remove', what: 'rule', key: 'R1' }], preview: true }],
      [start.revision, { edits: [{ edit: 'remove', what: 'rule', key: 'R1' }], authority: { name: 'Shift manager', reason: 'Train B work moved' } }],
    ])
    // The screen writes its own notice; the Module's change lines are not copied (they may name keys).
    expect(shown.notice).toBe('Saved: Remove the rule.')
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
    await double.actions.apply(start, [{ edit: 'resource', key: 'Truck-9', label: 'Truck 9', kind: 'tool', count: 1, calendar: 'exercise', attributes: [], locator: truck.locator, source: { by: 'planner' } }], null, null, 'Add Truck 9 as a tool')
    expect(double.calls.map(call => call.capability).filter(capability => capability !== 'planning.plan.read')).toEqual(['world.simulation-run.planning-facts', 'planning.plan.edit', 'planning.sources.refresh'])
  })

  test('refusals become previews in words; a protected item and a missing agreement differ', async () => {
    const start = trainAPlanned()
    // The Module's message names keys; the screen says names, from the refusal's details.
    const protectedItem = await host(start, { status: 409, code: 'protected_equipment', message: 'SWA-TAG names SWB, which rule R1 protects', details: { about: ['SWA-TAG', 'SWB', 'R1'] } }).actions.preview(start, [{ edit: 'job', key: 'SWA-TAG', equipment: ['SWB'] }], 'Tag out SW B')
    const rule = start.inputs.rules.find(item => item.key === 'R1')!
    expect(protectedItem.refusal).toEqual({ text: `Remove SW A from service and hang tags would touch Service Water Pump B, which “${rule.words}” protects. No job may touch it.`, needsAuthority: false, nearestAllowed: null })
    const below = await host(start, { status: 409, code: 'below_minimum', message: 'SWA-RTS would run shorter', details: { about: ['SWA-RTS'] } }).actions.preview(start, [{ edit: 'job', key: 'SWA-RTS', duration: { value: 1 } }], 'Shorter test')
    expect(below.refusal).toEqual({ text: 'Restore SW A, fill and vent, pump test would run shorter than its declared minimum. Name the person who agreed and their reason. Ask them; never fill this in yourself.', needsAuthority: true, nearestAllowed: null })
    // Lane P's structured refusal: the rule in its words, what lifts it, and the nearest allowed time (T20-02).
    const nearest = new Date(Date.parse(start.inputs.settings.window!.start) + 30 * 3_600_000).toISOString()
    const structured = await host(start, {
      status: 409, code: 'needs_authority', message: 'Edit 1 weakens (rule: R2)',
      details: { about: ['R2'], rule: 'Once the first Train A cooling item is tagged out, every item must be back within 72 h', nearestAllowed: nearest, authority: { needed: true, ask: 'Name the person who agreed and their reason, as authority. Ask them; never fill this in yourself.' } },
    }).actions.preview(start, [{ edit: 'job', key: 'SWA-RTS', lock: nearest }], 'Fix the start')
    expect(structured.refusal).toEqual({
      text: 'Once the first Train A cooling item is tagged out, every item must be back within 72 h. Name the person who agreed and their reason, as authority. Ask them; never fill this in yourself.',
      needsAuthority: true, nearestAllowed: nearest,
    })
    const protectedOnly = await host(start, { status: 409, code: 'protected_equipment', message: 'x', details: { about: ['SWA-TAG', 'SWB', 'R1'], rule: 'SW B is protected: no job may touch it' } }).actions.preview(start, [{ edit: 'job', key: 'SWA-TAG', equipment: ['SWB'] }], 'Tag out SW B')
    expect(protectedOnly.refusal).toEqual({ text: 'SW B is protected: no job may touch it.', needsAuthority: false, nearestAllowed: null })
    const authority = await host(start, { status: 409, code: 'needs_authority', message: 'Removing a protected rule needs someone\'s agreement.' }).actions.preview(start, [{ edit: 'remove', what: 'rule', key: 'R1' }], 'Remove')
    expect(authority.refusal?.needsAuthority).toBe(true)
    await expect(host(start, { status: 500, code: 'invalid_planning_result', message: 'x' }).actions.preview(start, [{ edit: 'remove', what: 'rule', key: 'R1' }], 'Remove')).rejects.toThrow()
  })

  test('Generate sends the revision; Cancel and refusals still read the plan again and say what happened', async () => {
    const start = trainAPlanned()
    const done = await host(start).actions.generate(start, {}, new AbortController().signal, null)
    // The outcome is said by the banner, from the options read back; no notice is copied from the Module.
    expect([done.notice, done.error, done.option]).toEqual([null, null, 'opt-1'])
    const stop = new AbortController()
    stop.abort()
    const cancelled = host(start)
    const shown = await cancelled.actions.generate(start, {}, stop.signal, 'opt-1')
    expect(shown.notice).toContain('Cancelled.')
    expect(cancelled.calls.some(call => call.capability === 'planning.plan.read')).toBe(true)
    const large = await host(start, { status: 413, code: 'above_certified_size', message: 'Too large for the certified size: certified for single-train work weeks up to 100 jobs; this plan has 340.' }).actions.generate(start, {}, new AbortController().signal, null)
    expect(large.error).toBe('Too large for the certified size: certified for single-train work weeks up to 100 jobs; this plan has 340.')
  })

  test('T5-01, T5-02: reading the plan also reads why each current refused option is impossible', async () => {
    const base = trainAPlanned()
    const refused = status({ word: 'proven infeasible', run: runBasis(base.inputs.settings.grid), cause: { kind: 'chain', jobs: ['SWA-RTS'], workHours: 37, calendars: ['day'], availableHours: 32, from: '2026-11-16T06:00:00Z', by: '2026-11-20T14:00:00Z' } })
    const start: PlanModel = { ...base, options: { at: base.options!.at, recommended: null, items: [optionOf('v1', 'Rebuild, days only', refused), optionOf('old', 'Earlier', refused, { fresh: false })] } }
    const double = host(start)
    const shown = await double.actions.load(null)
    expect(shown.model.refusals).toEqual({ v1: ['Not possible: v1 needs 37 h of work, but only 32 h exist.'] })
    expect(double.calls.filter(call => call.capability === 'planning.plan.explain').map(call => call.input)).toEqual([{ ask: 'refusal', option: 'v1' }])
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
