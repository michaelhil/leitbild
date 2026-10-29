import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { actorIdSchema, objectIdSchema, type IsoTimestamp } from '../src/core/model/index.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { lineStateProjectionRevision } from '../src/packs/process-plant/observation/declarations.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { physicalLayoutPack } from '../src/packs/physical-layout/pack.ts'
import { pwrRhrUnitPhysicalDesignRef, pwrOperatorUnitPhysicalDesignRef, resolvePhysicalDesign } from '../src/packs/physical-layout/design.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { layoutLiveResponseSchema, type LayoutLiveResponse } from '../src/ui/physical-layout/read-model.ts'
import { resolvePhysicalSubjectOperation } from '../src/ui/physical-layout/operation.ts'

const plantId = objectIdSchema.parse('plant:rhr-live'), layoutId = 'layout:rhr-live'
const actor = { id: actorIdSchema.parse('actor:rhr-live'), label: 'RHR live inspection proof', role: 'operator' as const }
const packs = [processPlantPack, physicalLayoutPack]
const definition = scenarioDefinitionSchema.parse({ id: 'rhr-live-proof', title: 'Actual RHR layout inspection', view: { map: { center: [11.477, 59.085], zoom: 16 } }, world: { startsAt: '2026-10-29T04:00:00.000Z' }, packs: [
  { id: 'process-plant', config: {}, items: [{ type: 'plant', id: plantId, label: 'Current four-loop PWR', location: [11.477, 59.085], model: { ref: 'process-plant.pwr.reference', parameters: { loopCount: 4 } }, operatingPoint: { ref: 'process-plant.pwr.full-power' }, automation: { ref: 'process-plant.pwr.standard' } }] },
  { id: 'physical-layout', config: {}, items: [{ type: 'site-layout', id: layoutId, label: 'Current RHR unit', design: pwrRhrUnitPhysicalDesignRef, members: { unit: plantId }, bearing: 0 }] },
], timeline: { cues: [{ id: 'primary-release', at: { kind: 'after_scenario_start', seconds: 10 }, title: 'Actual primary release', actions: [{ type: 'invoke_capability', capabilityId: 'world.process-plant.control.write', input: { plantId, path: 'rcp-a-to-core.leak.areaFraction', value: .5 } }] }] } })

// The actual World/Pack admission, numerical runtime, shared owner observation
// reader and people-facing map API are exercised together. Nothing supplies a
// fabricated physical-target description, process observation or topology.
test('current R8 live map reads one fresh owner sample for graph-exact RHR machines, routes and physical feedback', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-rhr-live-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: [definition],
    compileScenarioDefinition: source => compileScenarioDefinition(source, packs, { routing: createDirectRoutingAdapter() }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs), scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }), runtimeAdapters: [createLocalProcessPlantPackRuntimeAdapter()] })
  try {
    const run = await registry.create({ scenarioId: definition.id }); await run.setClock({ paused: true })
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: plantId, loopCount: 4 })), design = await resolvePhysicalDesign(pwrRhrUnitPhysicalDesignRef)
    if (design.profile !== 'drafting') throw Error('Expected current RHR drafting admission')
    expect(design.modelRequirement).toEqual({ modelRef: plant.modelRef, modelDigest: plant.modelDigest })
    const observations = run.observations.bind(run)
    let ownerReads = 0
    const counted = spyOn(run, 'observations').mockImplementation(caller => {
      const port = observations(caller)
      return { ...port, read: async request => { ownerReads++; return port.read(request) } }
    })
    const read = async () => {
      const before = ownerReads
      const request = new Request(`http://leitbild.test/api/workspaces/${registry.workspaceId}/world/simulation-runs/${run.id}/displays/layout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layoutObjectId: layoutId, expectedRevision: pwrRhrUnitPhysicalDesignRef.digest }),
      })
      const response = await handleSimulationRunApi(request, new URL(request.url), { registry,
        accessContext: accessContextSchema.parse({ workspaceId: registry.workspaceId, requestId: newRequestId(), actor: { kind: 'anonymous' } }), roleHolders: () => ({}) })
      if (!response) throw Error('RHR layout route was not handled')
      const body = await response.json()
      if (response.status !== 200) throw Error(`RHR layout API ${response.status}: ${JSON.stringify(body)}`)
      const result = layoutLiveResponseSchema.parse(body)
      expect(ownerReads - before).toBe(1)
      expect(result.scope).toMatchObject({ runId: run.id, layoutObjectId: layoutId, revision: design.design.digest, objectId: plantId, packId: 'process-plant', modelDigest: plant.modelDigest, sequence: run.snapshot().seq })
      expect(result.sample.at).toEqual({ at: run.snapshot().clock!.currentTime, clock: 'simulation', paused: true })
      const direct = await observations(actor).read({ refs: result.sample.observations.map(value => value.ref) })
      expect(direct.refused).toEqual([]); expect(direct.unknown).toEqual([])
      const ownerValues = new Map(direct.observations.map(value => [value.ref, value]))
      for (const value of result.sample.observations) {
        expect(value.at).toBe(result.sample.at.at)
        expect(value.clock).toBe('simulation')
        expect(ownerValues.get(value.ref)).toEqual(value)
      }
      return result
    }
    const advance = async (seconds: number) => {
      const until = new Date(Date.parse(run.snapshot().clock!.currentTime) + seconds * 1_000).toISOString() as IsoTimestamp
      await run.runMaximumPace(until, { shouldStop: () => false, onProgress: () => undefined }); await run.setClock({ paused: true })
    }
    const write = async (path: string, value: number | boolean) => {
      const outcome = await run.invokeCapability(actor, { capabilityId: 'world.process-plant.control.write', input: { plantId, path, value } })
      expect(outcome.kind).toBe('command')
      if (outcome.kind !== 'command') throw Error(`Expected actual control command: ${path}`)
      expect(outcome.result.ok).toBe(true)
    }
    const observation = (sample: LayoutLiveResponse, path: string) => {
      const value = sample.sample.observations.find(value => value.ref === `${plantId}#${path}`)
      if (!value) throw Error(`Actual layout did not acquire ${path}`)
      expect(value.quality).toBe('good'); return value
    }
    try {
      const before = await read()
      await advance(120)
      await write('rhrIsolationValve.positionFraction', 1)
      await write('rhrPumpA.running', true); await write('rhrPumpB.running', true)
      await advance(180)
      const loaded = await read()
      expect(loaded.scope.epoch).toBe(before.scope.epoch)
      expect(loaded.scope.sequence).toBeGreaterThan(before.scope.sequence)
      expect(Date.parse(loaded.sample.at.at)).toBeGreaterThan(Date.parse(before.sample.at.at))
      const machines = ['A', 'B'].flatMap(train => ['rhrHeatExchanger', 'componentCoolingHeatExchanger', 'componentCoolingTank', 'componentCoolingWaterPumpBreaker', 'serviceWaterPumpBreaker'].map(prefix => `${prefix}${train}`))
      const subjects = new Map(loaded.subjects.map(subject => [subject.elementId, subject]))
      for (const id of machines) {
        const subject = subjects.get(id)!
        expect(subject).toBeDefined(); expect(subject.topology?.kind).toBe('node')
        expect(subject.values.length).toBeGreaterThan(0)
      }
      const topology = await observations(actor).topology(plantId)
      if ('refused' in topology) throw Error(topology.refused.message)
      expect(topology.objectId).toBe(plantId)
      expect(topology.revision).toBe(lineStateProjectionRevision(plant))
      for (const train of ['A', 'B']) for (const prefix of ['rhrHeatExchanger', 'componentCoolingHeatExchanger']) {
        const id = `${prefix}${train}`, wire = topology.nodes.find(node => node.id === id)!
        expect(wire).toMatchObject({ class: 'transfer', kind: 'heatExchanger' })
        for (const [port, circuit] of [['hotIn', 'hot'], ['hotOut', 'hot'], ['coldIn', 'cold'], ['coldOut', 'cold']]) {
          const actual = wire.ports.find(value => value.id === port)!
          expect(actual.circuit).toBe(circuit)
          const medium = prefix === 'rhrHeatExchanger' ? (circuit === 'hot' ? 'residualHeatRemoval' : 'componentCoolingWater') : (circuit === 'hot' ? 'componentCoolingWater' : 'serviceWater')
          expect(actual.media).toEqual([medium])
        }
        expect(observation(loaded, `${id}.heatTransferMw`).value).toBeGreaterThan(0)
        expect(subjects.get(id)!.values.find(value => value.ref === `${plantId}#${id}.heatTransferMw`)?.unit).toBe('MW')
      }
      const historical = await resolvePhysicalDesign(pwrOperatorUnitPhysicalDesignRef)
      if (historical.profile !== 'drafting') throw Error('Expected exact previous physical admission')
      const retainedRoutes = new Map(historical.source.routing!.connections.map(route => [route.graphConnectionId, route]))
      const newRouteIds = design.source.routing!.connections.filter(route => JSON.stringify(route) !== JSON.stringify(retainedRoutes.get(route.graphConnectionId))).map(route => route.graphConnectionId)
      expect(newRouteIds).toHaveLength(26)
      for (const id of newRouteIds) {
        const subject = subjects.get(id)!, edge = plant.sourceGraph.connections.find(edge => edge.id === id)!
        if (subject?.topology?.kind !== 'connection') throw Error(`Current layout has no exact route semantics: ${id}`)
        const split = (ref: string) => ({ elementId: ref.slice(0, ref.lastIndexOf('.')), port: ref.slice(ref.lastIndexOf('.') + 1) })
        expect(subject.topology.from).toMatchObject(split(edge.from)); expect(subject.topology.to).toMatchObject(split(edge.to))
        expect(subject.topology.medium.id).toBe(edge.connectionKind === 'electricalPower' ? 'electricalPower' : edge.service!)
        const operation = resolvePhysicalSubjectOperation(subject, loaded.sample.observations, false)
        if (edge.connectionKind === 'fluidFlow') {
          const flow = observation(loaded, `${id}.flowKgPerS`)
          expect(flow.value).toBeGreaterThan(0)
          expect(subject.topology.values.find(value => value.ref === flow.ref)?.unit).toBe('kg/s')
          expect(operation.flows.some(value => value.value === flow.value && value.quality === 'good')).toBe(true)
        } else expect(operation.conducting).not.toBeNull()
      }
      for (const train of ['A', 'B']) for (const prefix of ['componentCoolingWaterPump', 'serviceWaterPump']) {
        const subject = subjects.get(`${prefix}${train}`)!
        if (subject.topology?.kind !== 'node') throw Error('Expected actual pump node')
        expect(subject.topology.equipmentKind).toBe('centrifugalPump')
        expect(observation(loaded, `${prefix}${train}.runningState`).value).toBe(true)
        expect(resolvePhysicalSubjectOperation(subject, loaded.sample.observations, false).equipment?.running).not.toBeNull()
      }
      // A real command and numerical advance must refresh the already-admitted
      // layout; no close/reopen or fabricated status projection is involved.
      await write('componentCoolingWaterPumpA.running', false); await advance(1)
      const stopped = await read()
      expect(stopped.scope.epoch).toBe(loaded.scope.epoch)
      expect(stopped.scope.sequence).toBeGreaterThan(loaded.scope.sequence)
      expect(observation(stopped, 'componentCoolingWaterPumpA.runningState').value).toBe(false)
      expect(observation(stopped, 'componentCoolingWaterPumpB.runningState').value).toBe(true)
    } finally { counted.mockRestore() }
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
}, 30_000)
