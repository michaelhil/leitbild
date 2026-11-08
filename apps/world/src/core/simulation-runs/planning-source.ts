import { createHash } from 'node:crypto'
import {
  planningOwnerBasisInputSchema, planningOwnerBasisSchema, planningSourceBasisSchema,
  planningSourceQualificationResultSchema, planningSourceQualifyInputSchema,
  type PlanningSourceProfile, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { rawObjectReadPolicy } from '../packs/inspection.ts'
import { createQueryReadPolicy, unavailableQueryReadScope } from '../../simulation/query-read-policy.ts'
import type { PackRuntimeQuery } from '../../simulation/protocol.ts'
import type { WorldPack } from '../packs/protocol.ts'
import type { RunRoles } from '../model/roles.ts'
import type { SimulationRunStateSnapshot } from './state-store.ts'

export const createPlanningSourcePort = (ports: {
  readonly snapshot: () => SimulationRunStateSnapshot
  readonly roles: () => RunRoles | null
  readonly packs: () => ReadonlyArray<WorldPack>
  readonly invoke: (query: PackRuntimeQuery) => Promise<unknown>
  readonly active: (id: string) => boolean
  readonly epoch: () => Promise<string | null>
}) => {
  const context = (profile: PlanningSourceProfile) => {
    if (ports.roles() !== null) unavailableQueryReadScope('Shared planning input supports only open Runs without roles')
    const snapshot = ports.snapshot()
    const restrictions = snapshot.scenario?.agentRestrictions
    const capabilityId = `world.${profile}.planning-basis`
    if (!ports.active(capabilityId)) unavailableQueryReadScope('The requested planning source owner is unavailable')
    if (restrictions?.operationIds.some(id => id === capabilityId || id.startsWith(`world.${profile}.`))) unavailableQueryReadScope('This owner has restricted operations and is not qualified for the shared research input profile')
    const denied = restrictions?.objects.filter(entry => entry.deny.includes('inspect')).map(entry => String(entry.objectId)) ?? []
    const policy = rawObjectReadPolicy(createQueryReadPolicy(`planning:${restrictions?.revision ?? 0}`, denied), snapshot.objects, ports.packs())
    return { snapshot, capabilityId, policy, revision: restrictions?.revision ?? 0 }
  }
  return {
    capture: async (source: WorkspaceResourceReference, profile: PlanningSourceProfile, raw: unknown) => {
      const input = planningOwnerBasisInputSchema.parse(raw)
      const epoch = await ports.epoch()
      if (epoch === null) unavailableQueryReadScope('This Run predates shared planning capture; start a new research Run')
      const captured = context(profile)
      const owner = planningOwnerBasisSchema.parse(await ports.invoke({ capabilityId: captured.capabilityId, input: { ...input, purpose: 'capture' }, readPolicy: captured.policy }))
      const after = ports.snapshot()
      if (after.seq !== captured.snapshot.seq || (after.scenario?.agentRestrictions.revision ?? 0) !== captured.revision || await ports.epoch() !== epoch) {
        throw Object.assign(new Error('Planning source changed during capture; pause or refresh the Run and capture again'), { code: 'query_policy_superseded', status: 409 })
      }
      const subjects = [...owner.subjects].sort((a, b) => a.locator.localeCompare(b.locator)).map(subject => ({ ...subject, facts: [...subject.facts].sort((a, b) => a.id.localeCompare(b.id)) }))
      const digest = createHash('sha256').update(JSON.stringify({ profile, subjects })).digest('hex')
      return planningSourceBasisSchema.parse({ source, profile, subjects, digest,
        sequence: captured.snapshot.seq, simulationAt: owner.simulationAt, observedAt: new Date().toISOString(),
        qualification: { audience: 'shared-research', epoch, restrictionRevision: captured.revision, subjectIds: subjects.map(subject => subject.locator) },
      })
    },
    qualify: async (raw: unknown) => {
      const input = planningSourceQualifyInputSchema.parse(raw)
      try {
        const current = context(input.profile)
        if (await ports.epoch() !== input.qualification.epoch) return { allowed: false, code: 'source_epoch_changed', reason: 'The captured Run was reset, replaced, or has no planning epoch' }
        if (current.revision !== input.qualification.restrictionRevision) return { allowed: false, code: 'source_qualification_changed', reason: 'Shared source restrictions changed; capture a new input basis' }
        const answer = planningSourceQualificationResultSchema.parse(await ports.invoke({
          capabilityId: current.capabilityId,
          input: { subjectIds: input.qualification.subjectIds, purpose: 'qualify' },
          readPolicy: current.policy,
        }))
        if ((ports.snapshot().scenario?.agentRestrictions.revision ?? 0) !== current.revision || await ports.epoch() !== input.qualification.epoch) return { allowed: false, code: 'source_qualification_changed', reason: 'Shared source qualification changed during the check' }
        return answer
      } catch {
        // Qualification never exposes owner diagnostics or current values to a retained Study.
        return { allowed: false, code: 'source_unavailable', reason: 'The captured source set is unavailable to the shared research audience' }
      }
    },
  }
}
export type PlanningSourcePort = ReturnType<typeof createPlanningSourcePort>
