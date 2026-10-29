import { expect, test } from 'bun:test'
import { newWorkspaceId } from '@leitbild/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import { declarationOf } from '../src/features/displays/compose/declared.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import type { ActorId, IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import { createOperationClient } from '../src/packs/process-plant/ui/displays/operation/operation-client.ts'
import { readElementOperation } from '../src/packs/process-plant/ui/displays/operation/element-operation.ts'
import { commandPhase, faceplateControls, itemControlView, operationNow, optionOf, proposalCard } from '../src/packs/process-plant/ui/displays/operation/operation-presenter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'

test('real Run controller discovery, shared faceplate, stale proposal and fresh-model restart preserve exact operator authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-controller-flow-'))
  const workspaceId = newWorkspaceId(), routing = createDirectRoutingAdapter()
  const assembly = createWorldApplicationAssembly({ routing })
  const makeRegistry = () => createSimulationRunRegistry({ dataDir: directory, workspaceId,
    scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  let registry = makeRegistry()
  const person: Actor = { id: 'actor:human:controller-test' as ActorId, role: 'operator', label: 'Controller operator' }
  const ai: Actor = { id: 'actor:ai:controller-test' as ActorId, role: 'ai_agent', label: 'Controller agent' }
  const plantId = 'plant:halden-2', item = 'feedwaterControlValveA'
  let runtime: SimulationRunRuntime
  try {
    runtime = await registry.create({ scenarioId: 'halden-normal-operation' })
    await runtime.setClock({ paused: true })
    const advance = async (milliseconds = 1_000) => { const start = Date.parse(runtime.snapshot().clock!.currentTime); await runtime.runMaximumPace(new Date(start + milliseconds).toISOString() as IsoTimestamp, { shouldStop: () => false }) }
    const query = async <T,>(capabilityId: string, input: unknown): Promise<T> => { const result = await runtime.invokeCapability(person, { capabilityId, input }); if (result.kind !== 'query') throw Error('Expected query'); return result.result as T }
    const client = createOperationClient({
      query: async <T,>(_run: SimulationRunId, capability: string, input: unknown): Promise<T> => query<T>(capability, input),
      command: async (_run, capabilityId, input) => { const result = await runtime.invokeCapability(person, { capabilityId, input }); if (result.kind !== 'command') throw Error('Expected command'); return result.result.ok ? { ok: true, commandId: result.result.commandId } : { ok: false, reason: result.result.reason } },
    })
    const read = async () => { const result = await readElementOperation(client, runtime.id, plantId, item); const now = operationNow(result.read!.sample, result.read!.units); return { result, now, view: itemControlView(result.item, now, result.resets) } }
    const set = async (tagId: string, value: boolean | number) => {
      const validation = await query<{ accepted: boolean }>('world.process-plant.control.validate', { plantId, tagId, value })
      expect(validation.accepted).toBe(true)
      const result = await runtime.invokeCapability(person, { capabilityId: 'world.process-plant.control.write', input: { plantId, tagId, value } })
      if (result.kind !== 'command' || !result.result.ok) throw Error('Control write refused')
      await advance()
    }
    await advance()
    const discovery = await query<{ signals: Array<{ plantId: string; signal: { tagId: string; writable: boolean; unit: string; quantity: string } }> }>('world.process-plant.signals.search', { plantId, text: 'MFW-A-CTRL', writable: true, publishedOnly: true, detail: 'full' })
    expect(discovery.signals.find(value => value.signal.tagId === 'MFW-A-CTRL-AUTO')).toMatchObject({ plantId, signal: { writable: true, unit: 'boolean', quantity: 'boolean' } })
    expect(discovery.signals.find(value => value.signal.tagId === 'MFW-A-CTRL-SP')).toMatchObject({ plantId, signal: { writable: true, unit: 'percent', quantity: 'ratio' } })
    expect(discovery.signals.every(value => value.plantId === plantId)).toBe(true)
    const declaration = await declarationOf(await displayRunOf(registry, runtime, person, new Set()), plantId, [item])
    for (const [tag, unit] of [['MFW-A-CTRL-AUTO', ''], ['MFW-A-CTRL-SP', '%']]) {
      expect(declaration!.observables.find(value => value.tag === tag)).toMatchObject({ basis: 'command', unit })
    }
    const first = await read()
    const automatic = first.view.controls.find(control => control.target.startsWith('MFW-A-CTRL-AUTO'))!
    const target = first.view.controls.find(control => control.form === 'setpoint')!
    expect(automatic.now).toBe('AUTO')
    expect(target.setpoint).toMatchObject({ value: 55, unit: 'percent', limits: { min: 0, max: 100 } })
    expect(faceplateControls(first.view, { pinned: false, short: false, proposalPending: false }).open!.controls.some(control => control.path.endsWith('.positionFraction'))).toBe(false)
    expect(await client.validate(runtime.id, plantId, { path: 'feedwaterControlValveA.positionFraction' as never, value: 0.4 })).toMatchObject({ accepted: false })
    for (const [capabilityId, input] of [
      ['world.process-plant.control.write', { plantId, tagId: 'MFW-A-CV', value: 0.4 }],
      ['world.process-plant.control.ramp', { plantId, tagId: 'MFW-A-CV', targetValue: 0.4, durationSeconds: 10 }],
    ] as const) {
      const refused = await runtime.invokeCapability(person, { capabilityId, input })
      if (refused.kind !== 'command') throw Error('Expected a command result')
      expect(refused.result).toMatchObject({ ok: false, reason: expect.stringContaining('MAN') })
    }

    await set('MFW-A-CTRL-AUTO', false)
    const manual = await read()
    expect(manual.view.controls.find(control => control.path === automatic.path)?.now).toBe('MAN')
    expect(await client.validate(runtime.id, plantId, { path: 'feedwaterControlValveA.positionFraction' as never, value: 0.4 })).toMatchObject({ accepted: true })
    expect(faceplateControls(manual.view, { pinned: false, short: false, proposalPending: false }).open!.controls.some(control => control.path.endsWith('.positionFraction'))).toBe(true)
    const proposed = await runtime.invokeCapability(ai, { capabilityId: 'world.process-plant.control.propose', input: { plantId, tagId: 'MFW-A-CV', value: 0.4, reason: 'Demonstrate stale manual authority review', evidence: ['SG-A-LVL-NR'] } })
    if (proposed.kind !== 'command' || !proposed.result.ok) throw Error('Proposal refused')
    await set('MFW-A-CTRL-AUTO', true)
    const after = await read(), proposal = after.result.proposals.find(proposal => proposal.write?.path === 'feedwaterControlValveA.positionFraction')!
    const card = proposalCard(proposal, after.result.reviews.get(proposal.id)!, after.result.item, after.now)
    expect(card.status).toBe('blocked')
    expect(card.approve?.enabled).toBe(false)
    expect(card.checked.text).toContain('select MAN')
    expect(await client.decide(runtime.id, plantId, proposal.id, 'approve', null)).toMatchObject({ ok: false })

    // The same open-card read path sees another actor's target immediately;
    // a target is configuration, not evidence the receiver already reached it.
    await set('MFW-A-CTRL-SP', 60)
    const changed = await read(), nextTarget = changed.view.controls.find(control => control.path === target.path)!
    expect(nextTarget.setpoint?.value).toBe(60)
    expect(nextTarget.now).toBe('Target 60 %')
    expect(optionOf(nextTarget, 60)?.current).toBe(true)
    expect(commandPhase(nextTarget, optionOf(nextTarget, 60)!, { path: nextTarget.path, value: 60, sentAtElapsedMs: changed.now.elapsedMs, result: { ok: true } }, changed.now).text).toStartWith('Target 60 %')
    const other = await client.controls(runtime.id, 'plant:halden-1', [item])
    expect(other.items[0]!.offered.find(control => control.control.form === 'setpoint')?.control.path).toBe(target.path)
    const untouched = await query<{ signals: Array<{ variable: { value: number } }> }>('world.process-plant.signals.read', { plantId: 'plant:halden-1', signals: [{ tagId: 'MFW-A-CTRL-SP' }] })
    expect(untouched.signals[0]!.variable.value).toBe(55)
    await set('SG-A-ARV-SP', 7.425)
    const relief = await readElementOperation(client, runtime.id, plantId, 'steamGeneratorReliefValveA')
    const reliefNow = operationNow(relief.read!.sample, relief.read!.units)
    const reliefTarget = itemControlView(relief.item, reliefNow, relief.resets).controls.find(control => control.form === 'setpoint')!
    expect(reliefTarget.setpoint?.value).toBe(7.425)
    expect(reliefTarget.now).toBe('Target 7.425 MPa')
    expect(optionOf(reliefTarget, 7.86)?.current).toBe(false)

    const runId = runtime.id
    await registry.shutdown()
    registry = makeRegistry()
    runtime = await registry.load(runId)
    const restored = await read()
    expect(restored.view.controls.find(control => control.path === automatic.path)?.now).toBe('AUTO')
    expect(restored.view.controls.find(control => control.path === target.path)?.setpoint?.value).toBe(60)
    const restoredRelief = await readElementOperation(client, runtime.id, plantId, 'steamGeneratorReliefValveA')
    expect(itemControlView(restoredRelief.item, operationNow(restoredRelief.read!.sample, restoredRelief.read!.units)).controls.find(control => control.form === 'setpoint')?.setpoint?.value).toBe(7.425)
  } finally { await registry.shutdown(); await rm(directory, { recursive: true, force: true }) }
}, 30_000)
