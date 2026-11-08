import { createHash } from 'node:crypto'
import { engineeringCaptureInputSchema, engineeringInputBasisSchema, engineeringQualifyInputSchema, type EngineeringInputBasis, type EngineeringProfile } from '@leitbild/contracts'
import { engineeringOwnerBasisSchema, engineeringOwnerOutputSchema } from '../../simulation/engineering-inputs.ts'
import type { PackRuntimeQuery } from '../../simulation/protocol.ts'
import { scenarioDefinitionSchema } from '../scenarios/definition.ts'
import thermal from '../../scenarios/engineering-thermal.scenario.json'
import grid from '../../scenarios/engineering-grid.scenario.json'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { SimulationRunId } from '../model/ids.ts'
import type { SimulationRunStateSnapshot } from '../simulation-runs/state-store.ts'
import { compiledScenarioDigest } from '../simulation-runs/compiled-scenario-store.ts'

export const engineeringDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const engineeringSourceRef = (registry: SimulationRunRegistry, id: SimulationRunId) => ({ workspaceId: registry.workspaceId, moduleId: 'world' as never, type: 'world.simulation-run' as never, id })
export const engineeringRefusal = (code = 'engineering_source_unavailable', reason = 'This source is outside the shared engineering research profile'): never => {
  throw Object.assign(new Error(reason), { code, status: 409 })
}
const profiles = {
  'plant-thermal': { definition: scenarioDefinitionSchema.parse(thermal), subjectId: 'plant:engineering-thermal', capabilityId: 'world.process-plant.engineering-basis' },
  'grid-balance': { definition: scenarioDefinitionSchema.parse(grid), subjectId: 'grid:engineering', capabilityId: 'world.electric-grid.engineering-basis' },
} as const

export const engineeringSourceContext = async (registry: SimulationRunRegistry, id: SimulationRunId, profile: EngineeringProfile, subjectId: string) => {
  const selected = profiles[profile]
  const runtime = await registry.load(id)
  const revision = await registry.scenarioRevisionForRun(id)
  const epoch = await registry.sourceEpoch(id)
  const snapshot = runtime.snapshot()
  const restrictions = snapshot.scenario?.agentRestrictions
  if (!revision || !Bun.deepEquals(revision.document, selected.definition) || epoch === null || runtime.roles() !== null
    || subjectId !== selected.subjectId || !snapshot.objects.some(object => object.id === subjectId)
    || restrictions?.operationIds.length || restrictions?.objects.some(item => item.deny.length > 0)
    || snapshot.procedures?.runs.some(run => run.status === 'active' || run.status === 'transferred')) return engineeringRefusal()
  const compiled = registry.loadedCompiledScenario(id)
  if (snapshot.objects.length !== compiled.initialObjects.length || snapshot.objects.some(object => !compiled.initialObjects.some(original => original.id === object.id))) return engineeringRefusal()
  const scenarioDigest = compiledScenarioDigest(compiled)
  const readPolicy = runtime.inspectionPolicy({ id: 'actor:engineering' as never, label: 'Engineering research', role: 'ai_agent' })
  const query = (purpose: 'capture' | 'qualify'): PackRuntimeQuery => ({ capabilityId: selected.capabilityId, input: { subjectId, purpose }, readPolicy })
  return { runtime, epoch, scenarioDigest, revision: restrictions?.revision ?? 0, query, snapshot, compiled }
}

export const engineeringBasis = (registry: SimulationRunRegistry, id: SimulationRunId, input: { profile: EngineeringProfile; subjectId: string }, context: Awaited<ReturnType<typeof engineeringSourceContext>>, snapshot: Pick<SimulationRunStateSnapshot, 'seq'>, rawOwner: unknown): EngineeringInputBasis => {
  const owner = engineeringOwnerBasisSchema.parse(rawOwner)
  const values = { profile: input.profile, subjectId: input.subjectId, source: engineeringSourceRef(registry, id), profileRevision: 'engineering-research-1' as const,
    frame: { epoch: context.epoch, scenarioDigest: context.scenarioDigest, restrictionRevision: context.revision,
      sequence: snapshot.seq, simulationAt: new Date(Date.parse(context.compiled.world.startsAt) + owner.modelElapsedMs).toISOString(), observedAt: new Date().toISOString() },
    quantities: owner.quantities,
  }
  return engineeringInputBasisSchema.parse({ ...values, digest: engineeringDigest(values) })
}
export const captureEngineeringInputs = async (registry: SimulationRunRegistry, id: SimulationRunId, raw: unknown) => {
  const input = engineeringCaptureInputSchema.parse(raw)
  const context = await engineeringSourceContext(registry, id, input.profile, input.subjectId)
  const owner = await context.runtime.readAtBoundary(context.query('capture'))
  // Recheck the whole current profile, not only sequence: roles, restrictions,
  // active procedures and exact authored/runtime scope remain admissible.
  const after = await engineeringSourceContext(registry, id, input.profile, input.subjectId)
  if (after.snapshot.seq !== context.snapshot.seq || after.epoch !== context.epoch || after.revision !== context.revision || after.scenarioDigest !== context.scenarioDigest) return engineeringRefusal('engineering_source_changed', 'Source changed during capture; pause or capture again')
  return engineeringBasis(registry, id, input, context, after.snapshot, owner)
}
export const qualifyEngineeringInputs = async (registry: SimulationRunRegistry, id: SimulationRunId, raw: unknown) => {
  const input = engineeringQualifyInputSchema.parse(raw)
  try {
    const context = await engineeringSourceContext(registry, id, input.profile, input.subjectId)
    if (context.epoch !== input.frame.epoch || context.scenarioDigest !== input.frame.scenarioDigest || context.revision !== input.frame.restrictionRevision) return { allowed: false, code: 'engineering_source_changed', reason: 'The original source qualification has changed' }
    const owner = engineeringOwnerOutputSchema.parse(await context.runtime.readAtBoundary(context.query('qualify')))
    const after = await engineeringSourceContext(registry, id, input.profile, input.subjectId)
    if (!('allowed' in owner) || !owner.allowed || after.epoch !== context.epoch || after.revision !== context.revision || after.scenarioDigest !== context.scenarioDigest) return { allowed: false, code: 'engineering_source_changed', reason: 'The original source qualification has changed' }
    return { allowed: true }
  } catch {
    // No protected owner diagnostic is returned by qualification.
    return { allowed: false, code: 'engineering_source_unavailable', reason: 'The original source is unavailable to this research profile' }
  }
}
