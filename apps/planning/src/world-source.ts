import {
  planningSourceBasisSchema, planningSourceQualificationResultSchema, planningSourceRequestSchema,
  type AccessContext, type PlanningSourceBasis,
} from '@leitbild/contracts'
import type { PlanningSourcePort } from './source-port.ts'
import { planningError } from './errors.ts'
import { createPlanningHostClient } from './host-client.ts'

export const createWorldPlanningSources = (config: { readonly hostUrl: string; readonly fetch?: typeof fetch }): PlanningSourcePort => {
  const host = createPlanningHostClient(config)
  const checkWorkspace = (basis: Pick<PlanningSourceBasis, 'source'>, access: AccessContext): void => {
    if (basis.source.workspaceId !== access.workspaceId) throw planningError(400, 'source_workspace_mismatch', 'Source must belong to the current Workspace')
  }
  return {
    capture: async (input, access) => {
      const request = planningSourceRequestSchema.parse(input)
      checkWorkspace(request, access)
      const basis = planningSourceBasisSchema.parse(await host.call(access, `world.${request.profile}.planning-basis`, {
        resource: request.source, input: request.subjectIds === undefined ? {} : { subjectIds: request.subjectIds },
      }))
      if (basis.source.id !== request.source.id || basis.source.workspaceId !== request.source.workspaceId || basis.profile !== request.profile) throw planningError(502, 'source_response_mismatch', 'The owner returned evidence for a different source')
      return basis
    },
    qualify: async (input, access, activation) => {
      const basis = planningSourceBasisSchema.parse(input)
      checkWorkspace(basis, access)
      return planningSourceQualificationResultSchema.parse(await host.call(access, 'world.planning-source.qualify', {
        resource: basis.source, input: { profile: basis.profile, qualification: basis.qualification, activation },
      }))
    },
  }
}
