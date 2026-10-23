import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import type { ViewRun } from '../src/features/displays/compose/view.ts'
import { procedureTagDisplayPlan } from '../src/ui/procedures/procedure-tag-display.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { PROCEDURE_TAGS } from './display-parity/states.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T39 P4, re-baselined at the swap and again in R2 (plan v5 W3.1, D-E): a clicked procedure tag opens World's default
// display of the element its Pack declares the tag measured on (displays/default for <unit>#<element>), composed as
// the person reads it: the equipment, its lead values, trend, own alerts and drawing, never the demand's own default.
// On four-loop Halden Unit 2, the eight tags T01 recorded: each tag the unit's model holds opens its equipment; one it
// lacks says so before anything is composed. The reactor trip breaker joins no line the Plant draws: no drawing.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:tags' as ActorId, label: 'Tags', role: 'operator' as const }
const plantId = 'plant:halden-2'

let registry: SimulationRunRegistry
let dataDir: string
let run: ViewRun
const facts: Record<string, unknown> = {}
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-tag-default-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  const runtime = await registry.create({ scenarioId: 'halden-power-complex' })
  await runtime.setClock({ paused: true })
  run = await displayRunOf(registry, runtime, person, new Set())
  const validated = await runtime.invokeCapability(person, { capabilityId: 'world.process-plant.procedure-tags.validate', input: { plantId, tags: PROCEDURE_TAGS.map(id => ({ id })) } })
  if (validated.kind !== 'query') throw new Error('procedure-tags.validate is a query')
  for (const tag of (validated.result as { readonly tags: ReadonlyArray<any> }).tags) {
    const plan = procedureTagDisplayPlan(plantId, tag.id, tag)
    if (plan.kind !== 'display') { facts[tag.id] = { plan: plan.kind }; continue }
    const outcome = await composeDefault(run, plan.subject)
    facts[tag.id] = outcome.ok
      ? { element: plan.subject.slice(plan.subject.indexOf('#') + 1), opens: outcome.state.views.map(view => view.kind) }
      : { subject: plan.subject, refused: outcome.issues.map(issue => issue.code) }
  }
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

describe('P4: a procedure tag opens the default display of the element it is measured on', () => {
  test('each of the eight tags: its equipment\'s values, trend, alerts and drawing; one the model lacks composes nothing', () => {
    const opened = (element: string) => ({ element, opens: ['values', 'trend', 'alerts', 'topology'] })
    expect(facts).toEqual({
      'PT-455': opened('pressurizer'), 'NIS-PR-AVG': opened('core'), 'SG-B-LVL-NR': opened('sgB'), 'AFW-FLOW': opened('auxFeedwaterHeader'),
      'MSIV-A-POS': opened('mainSteamIsolationValveA'), 'DG-A': opened('dieselGeneratorA'),
      'TRIP-BKR-A': { element: 'reactorTripBreakerA', opens: ['values', 'trend', 'alerts'] },
      'SI-SIG': { plan: 'not-in-model' },
    })
  })
})
