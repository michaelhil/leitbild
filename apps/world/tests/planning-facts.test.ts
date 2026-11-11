import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  newWorkspaceId, planningFactBasisSchema, planningFactsOutputSchema, planningProjectionOutputSchema, workspaceResourceReferenceSchema,
  type PlanningFact, type PlanningFactsOutput, type PlanningProjectionOutput, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createPlanningFactsPort, planningFactsPageBytes } from '../src/core/simulation-runs/planning-facts.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { PackRuntimeQuery } from '../src/simulation/protocol.ts'
import { actorIdSchema, objectIdSchema } from '../src/core/model/ids.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const controller = { id: actorIdSchema.parse('actor:planning-facts-test'), label: 'Planner', role: 'controller' as const }
const supplyRun = builtinScenarioDefinitions.find(source => source.id === 'supply-run')!
const trainA = builtinScenarioDefinitions.find(source => source.id === 'train-a-work-week')!
const { guide: _guide, ...supplyRunWithoutGuide } = supplyRun
const workspaceId = newWorkspaceId()
const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'planning-facts-'))
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const registry = createSimulationRunRegistry({
    dataDir, workspaceId,
    scenarioDefinitions: [
      ...builtinScenarioDefinitions,
      { ...supplyRunWithoutGuide, id: 'planning-facts-roles', roles: [{ id: 'control', label: 'Controller', class: 'controller' as const }] },
      // One Run with two Packs that project planning facts.
      { ...supplyRun, id: 'planning-facts-both', packs: [...supplyRun.packs, ...trainA.packs] },
    ],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    runtimeAdapters: assembly.runtimeAdapters, idleRuntimeCloseTimer: () => () => {},
  })
  cleanup.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  return registry
}
const source = (run: SimulationRunRuntime): WorkspaceResourceReference =>
  workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id })
const read = (run: SimulationRunRuntime, input: unknown) => run.planningFacts.read(source(run), input)
/** Every page of one question, following `more`; each page must stay within the byte budget. */
const allPages = async (ask: (cursor?: string) => Promise<PlanningFactsOutput>) => {
  const pages: PlanningFactsOutput[] = []
  let cursor: string | undefined
  do {
    const answer = planningFactsOutputSchema.parse(await ask(cursor))
    expect(Buffer.byteLength(JSON.stringify(answer), 'utf8')).toBeLessThanOrEqual(planningFactsPageBytes)
    pages.push(answer)
    cursor = answer.more
  } while (cursor !== undefined)
  return pages
}
/** Each locator's facts, merged across pages in page order. */
const merged = (pages: ReadonlyArray<PlanningFactsOutput>) => {
  const items = new Map<string, PlanningFact[]>()
  for (const page of pages) for (const item of page.items) items.set(item.locator, [...items.get(item.locator) ?? [], ...item.facts])
  return items
}
/** The port over a real Run, with a spy (or a substitute answer) between it and the Pack projections. */
const spiedPort = (run: SimulationRunRuntime, answer?: (query: PackRuntimeQuery, real: unknown) => unknown) => {
  const calls: Array<{ readonly query: PackRuntimeQuery; readonly answer: unknown }> = []
  const projections = new Set(run.packs().map(pack => `world.${pack.descriptor.id}.planning-basis`))
  const port = createPlanningFactsPort({
    snapshot: () => run.snapshot(), roles: () => run.roles(), packs: () => run.packs(),
    active: id => projections.has(id) && ['world.einsatz.planning-basis', 'world.process-plant.planning-basis'].includes(id),
    invoke: async query => {
      const real = await run.readAtBoundary(query)
      const given = answer === undefined ? real : answer(query, real)
      calls.push({ query, answer: given })
      return given
    },
  })
  return { calls, read: (input: unknown) => port.read(source(run), input) }
}
const caseSubjects = ['einsatz/unit/unit%3Atruck-1', 'einsatz/unit/unit%3Atruck-3', 'einsatz/unit/unit%3Atruck-4', 'einsatz/task/task%3Asports-hall-tank', 'einsatz/task/task%3Afield-kitchen']

describe('World planning facts', () => {
  test('case2\'s five subjects are read in one projection request, with arrivals between the trucks and both requests', async () => {
    const registry = await setup()
    const run = await registry.create({ scenarioId: 'supply-run' })
    const spied = spiedPort(run)
    const first = await spied.read({ subjects: caseSubjects })
    expect(spied.calls).toHaveLength(1)
    expect(spied.calls[0]!.query.capabilityId).toBe('world.einsatz.planning-basis')
    expect(spied.calls[0]!.query.input).toEqual({ subjects: caseSubjects, detail: 'facts' })
    expect(first.items[0]!.locator).toBe(caseSubjects[0]!)
    const pages = await allPages(cursor => read(run, { subjects: caseSubjects, ...(cursor === undefined ? {} : { cursor }) }))
    const items = merged(pages)
    expect([...items.keys()]).toEqual(caseSubjects)
    const ids = new Set([...items.values()].flat().map(fact => fact.id))
    // The World facts case2 refers to (planning fixture supply-run.case2.json), written out here.
    for (const id of [
      'unit:truck-1/property/payloadKg', 'unit:truck-3/property/payloadKg', 'unit:truck-4/property/payloadKg',
      'unit:truck-1/service-seconds', 'unit:truck-3/service-seconds', 'unit:truck-4/service-seconds',
      'unit:truck-1/arrival-seconds/task:sports-hall-tank', 'unit:truck-4/arrival-seconds/task:sports-hall-tank',
      'unit:truck-1/arrival-seconds/task:field-kitchen', 'unit:truck-3/arrival-seconds/task:field-kitchen', 'unit:truck-4/arrival-seconds/task:field-kitchen',
    ]) expect(ids.has(id), id).toBe(true)
    const facts = [...items.values()].flat()
    const byId = new Map(facts.map(fact => [fact.id, fact]))
    expect(byId.get('unit:truck-4/property/payloadKg')).toMatchObject({ value: 1500, unit: 'kg', basis: 'configured' })
    expect(byId.get('unit:truck-1/service-seconds')).toMatchObject({ value: 180, unit: 's', quantity: 'time', basis: 'design' })
    expect(byId.get('unit:truck-4/arrival-seconds/task:sports-hall-tank')).toMatchObject({ unit: 's', quantity: 'time', basis: 'owner-estimate' })
    expect(byId.get('unit:truck-4/eligible/task:sports-hall-tank')).toMatchObject({ value: true, basis: 'owner-estimate' })
    expect(byId.get('task:sports-hall-tank/rank')).toMatchObject({ basis: 'observed' })
    expect(byId.get('unit:truck-1/phase')).toMatchObject({ quantity: 'state', basis: 'observed' })
  })

  test('every fact has a basis and its own simulation time, every number its unit, and no design value is labelled observed', async () => {
    const registry = await setup()
    const run = await registry.create({ scenarioId: 'planning-facts-both' })
    const startsAt = new Date(Date.parse(run.snapshot().clock!.currentTime)).toISOString()
    const pumps = (await allPages(cursor => read(run, { kind: 'pump', limit: 20, ...(cursor === undefined ? {} : { cursor }) }))).flatMap(page => page.items.map(item => item.locator))
    const subjects = [...caseSubjects, 'process-plant/plant%3Atrain-a/serviceWaterPumpA', 'process-plant/plant%3Atrain-a/serviceWaterPumpB', 'process-plant/plant%3Atrain-a/auxFeedwaterPumpTurbine']
    for (const locator of subjects.slice(caseSubjects.length)) expect(pumps).toContain(locator)
    const facts = [...merged(await allPages(cursor => read(run, { subjects, ...(cursor === undefined ? {} : { cursor }) }))).values()].flat()
    expect(facts.length).toBeGreaterThan(40)
    for (const fact of facts) {
      expect(planningFactBasisSchema.safeParse(fact.basis).success, fact.id).toBe(true)
      expect(fact.at, fact.id).toBe(startsAt)
      if (typeof fact.value === 'number') expect(fact.unit, fact.id).toBeDefined()
    }
    const design = /\/(nominal-flow|runup-seconds|coastdown-seconds|model-digest|mobilization-seconds|service-seconds|carry-capacity|handover-seconds|receiving-slots)$/
    const designFacts = facts.filter(fact => design.test(fact.id))
    expect(designFacts.length).toBeGreaterThanOrEqual(10)
    for (const fact of designFacts) expect(fact.basis, fact.id).toBe('design')
    for (const fact of facts.filter(fact => fact.id.includes('/property/'))) expect(fact.basis, fact.id).toBe('configured')
    for (const fact of facts.filter(fact => /\/(eligible|arrival-seconds|arrival-unavailable|transfer-seconds)\//.test(fact.id))) expect(fact.basis, fact.id).toBe('owner-estimate')
    const byId = new Map(facts.map(fact => [fact.id, fact]))
    expect(byId.get('plant:train-a/serviceWaterPumpA/nominal-flow')).toMatchObject({
      label: 'Nominal pump flow at full-power operating point', quantity: 'mass-flow', unit: 'kg/s', basis: 'design',
    })
    expect(byId.get('plant:train-a/auxFeedwaterPumpTurbine/runup-seconds')).toMatchObject({ quantity: 'time', unit: 's', basis: 'design' })
    expect(byId.get('plant:train-a/serviceWaterPumpB/runningState')).toMatchObject({ quantity: 'state', value: true, basis: 'observed' })
    expect(byId.get('plant:train-a/serviceWaterPumpB/flowKgPerS')).toMatchObject({ quantity: 'mass-flow', basis: 'observed' })
    expect(byId.get('plant:train-a/serviceWaterPumpB/model-digest')).toMatchObject({ quantity: 'state', basis: 'design' })
  })

  test('a search fans out to every Pack projection, lists without estimates, and pages within 4 KB', async () => {
    const registry = await setup()
    const run = await registry.create({ scenarioId: 'planning-facts-both' })
    const spied = spiedPort(run)
    const first = await spied.read({ limit: 20 })
    expect(spied.calls.map(call => call.query.capabilityId)).toEqual(['world.einsatz.planning-basis', 'world.process-plant.planning-basis'])
    expect(spied.calls.every(call => JSON.stringify(call.query.input) === '{"detail":"index"}')).toBe(true)
    const einsatzIndex = planningProjectionOutputSchema.parse(spied.calls[0]!.answer)
    expect(einsatzIndex.subjects.flatMap(subject => subject.facts).some(fact => /\/(arrival|eligible|transfer)/.test(fact.id))).toBe(false)
    expect(first.more).toBeDefined()
    const pages = await allPages(cursor => read(run, { limit: 20, ...(cursor === undefined ? {} : { cursor }) }))
    expect(pages.length).toBeGreaterThan(1)
    const locators = pages.flatMap(page => page.items.map(item => item.locator))
    expect(new Set(locators).size).toBe(locators.length)
    // Supply run: two depots, three trucks, two requests. The four-loop plant: four reactor coolant pumps and 20 others.
    expect(locators.filter(locator => locator.startsWith('einsatz/'))).toHaveLength(7)
    expect(locators.filter(locator => locator.startsWith('process-plant/'))).toHaveLength(4 + 20)
    for (const item of pages.flatMap(page => page.items)) {
      expect(item.facts.length).toBeLessThanOrEqual(2)
      expect(item.facts.every(fact => fact.basis === 'observed' && fact.quantity === 'state')).toBe(true)
    }
    const trucks = await read(run, { text: 'TRUCK', kind: 'unit' })
    expect(trucks.items.map(item => item.label)).toEqual(['Truck 1', 'Truck 3', 'Truck 4'])
    expect(trucks.items[0]!.facts.map(fact => fact.id)).toEqual(['unit:truck-1/phase', 'unit:truck-1/integrity'])
    expect((await read(run, { text: 'service water pump' })).items.map(item => item.label)).toEqual(['Service Water Pump A', 'Service Water Pump B'])
    expect((await read(run, { text: 'feed pump' })).items.map(item => item.label)).toContain('Main Feedwater Pump A')
    // Names holding the asked words exactly come before names where they only begin a word.
    const pumpA = (await read(run, { text: 'pump a', limit: 20 })).items.map(item => item.label)
    const exact = pumpA.map(label => /\bPump A$/.test(label))
    expect(exact.indexOf(false)).toBeGreaterThan(exact.lastIndexOf(true))
    expect(pumpA).toContain('Motor-Driven Auxiliary Feedwater Pump')
    await expect(read(run, { text: 'truck', cursor: first.more })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
  })

  test('an item larger than a page continues on the next page under its locator, and exact reads keep the request order', async () => {
    const registry = await setup()
    const run = await registry.create({ scenarioId: 'supply-run' })
    const large = spiedPort(run, (query, real) => {
      const answer = real as PlanningProjectionOutput
      return { ...answer, subjects: answer.subjects.map(subject => subject.locator !== caseSubjects[1] ? subject : {
        ...subject, facts: Array.from({ length: 60 }, (_, index) => ({ ...subject.facts[0]!, id: `unit:truck-3/test-fact/${index}`, label: `Test fact ${index}` })),
      }) }
    })
    const subjects = [caseSubjects[4]!, caseSubjects[1]!, caseSubjects[0]!]
    const pages = await allPages(cursor => large.read({ subjects, ...(cursor === undefined ? {} : { cursor }) }))
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.flatMap(page => page.items.map(item => item.locator)).filter((locator, index, all) => all[index - 1] !== locator)).toEqual(subjects)
    expect(merged(pages).get(caseSubjects[1]!)!.map(fact => fact.id)).toEqual(Array.from({ length: 60 }, (_, index) => `unit:truck-3/test-fact/${index}`))
    expect(large.calls.every(call => (call.query.input as { subjects: string[] }).subjects.length === 3)).toBe(true)
  })

  test('an answer outside the contract is refused with 500 naming the Pack', async () => {
    const registry = await setup()
    const run = await registry.create({ scenarioId: 'supply-run' })
    const withBasis = (basis: string) => spiedPort(run, (_query, real) => {
      const answer = real as PlanningProjectionOutput
      return { ...answer, subjects: answer.subjects.map(subject => ({ ...subject, facts: subject.facts.map(fact => ({ ...fact, basis })) })) }
    })
    await expect(withBasis('observation').read({ subjects: caseSubjects })).rejects.toMatchObject({
      status: 500, code: 'invalid_pack_answer', details: { packId: 'einsatz' }, message: expect.stringContaining('The einsatz Pack answered planning facts outside the contract'),
    })
    const unitless = spiedPort(run, (_query, real) => {
      const answer = real as PlanningProjectionOutput
      return { ...answer, subjects: answer.subjects.map(subject => ({ ...subject, facts: subject.facts.map(({ unit: _unit, ...fact }) => fact) })) }
    })
    await expect(unitless.read({ text: 'truck' })).rejects.toMatchObject({ status: 500, code: 'invalid_pack_answer', details: { packId: 'einsatz' } })
    const foreign = spiedPort(run, (_query, real) => {
      const answer = real as PlanningProjectionOutput
      return { ...answer, subjects: [...answer.subjects, { ...answer.subjects[0]!, locator: 'process-plant/plant%3Ax/pump' }] }
    })
    await expect(foreign.read({})).rejects.toMatchObject({ status: 500, code: 'invalid_pack_answer', message: expect.stringContaining('another Pack owns') })
    const honest = spiedPort(run, (_query, real) => real)
    const extra = spiedPort(run, (query, real) => query.input && (query.input as { subjects?: string[] }).subjects
      ? { ...(real as PlanningProjectionOutput), subjects: [...(real as PlanningProjectionOutput).subjects, { locator: caseSubjects[2]!, label: 'Truck 4', kind: 'unit', facts: [] }] }
      : real)
    expect((await honest.read({ subjects: [caseSubjects[0]!] })).items).toHaveLength(1)
    await expect(extra.read({ subjects: [caseSubjects[0]!] })).rejects.toMatchObject({ status: 500, message: expect.stringContaining('not asked for') })
  })

  test('unknown subjects answer 404 naming each; repeated subjects are refused', async () => {
    const registry = await setup()
    const run = await registry.create({ scenarioId: 'supply-run' })
    await expect(read(run, { subjects: [caseSubjects[0], 'einsatz/unit/unit%3Anone', 'process-plant/plant%3Ax/pump', 'nopack/x'] })).rejects.toMatchObject({
      status: 404, code: 'unknown_subject', details: { subjects: ['einsatz/unit/unit%3Anone', 'process-plant/plant%3Ax/pump', 'nopack/x'] },
    })
    await expect(read(run, { subjects: [caseSubjects[0], caseSubjects[0]] })).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })

  test('Runs with roles and restricted owners are refused; denied items refuse the owner\'s facts', async () => {
    const registry = await setup()
    const roleRun = await registry.create({ scenarioId: 'planning-facts-roles' })
    await expect(read(roleRun, {})).rejects.toMatchObject({ status: 403, message: expect.stringContaining('without roles') })
    await expect(read(roleRun, { subjects: caseSubjects })).rejects.toMatchObject({ status: 403 })
    const run = await registry.create({ scenarioId: 'supply-run' })
    await run.setAgentRestrictions(controller, { operationIds: ['world.einsatz.unit.send'], objects: [] }, 0)
    await expect(read(run, { subjects: caseSubjects })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('einsatz operations are restricted') })
    await run.setAgentRestrictions(controller, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:truck-1'), deny: ['inspect'] }] }, 1)
    await expect(read(run, {})).rejects.toMatchObject({ status: 403 })
    await run.setAgentRestrictions(controller, { operationIds: [], objects: [] }, 2)
    expect((await read(run, {})).items.length).toBeGreaterThan(0)
  })

  test('a moving Run is read without a pause or refusal, each fact at its own time, and nothing is journalled', async () => {
    const registry = await setup()
    const run = await registry.create({ scenarioId: 'supply-run' })
    await run.setClock({ paused: false })
    const first = await read(run, { subjects: caseSubjects.slice(0, 2) })
    await Bun.sleep(1_200)
    const second = await read(run, { subjects: caseSubjects.slice(0, 2) })
    expect(run.snapshot().clock!.paused).toBe(false)
    const at = (answer: PlanningFactsOutput) => Date.parse(answer.items[0]!.facts[0]!.at)
    expect(at(second)).toBeGreaterThan(at(first))
    expect(Date.parse(second.observedAt)).toBeGreaterThan(Date.parse(first.observedAt))
    await run.setClock({ paused: true })
    const paused = { seq: run.snapshot().seq, events: run.events().length }
    for (const input of [{}, { text: 'truck' }, { subjects: caseSubjects }]) await allPages(cursor => read(run, { ...input, ...(cursor === undefined ? {} : { cursor }) }))
    expect({ seq: run.snapshot().seq, events: run.events().length }).toEqual(paused)
  })
})
