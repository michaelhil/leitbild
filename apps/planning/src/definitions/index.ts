// Bundled plan Definitions. Planning creates them through planning.plan.create.
// The Train A and Supply run case documents are lane A's fixtures, copied unchanged
// (definitions/fidelity.test.ts keeps them equal), and hold no schedule numbers.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ABOUT_RELATION, moduleDefinitionCollectionSchema, type ModuleDefinitionDescriptor, type WorkspaceId } from '@leitbild/contracts'
import { stableJson } from '@leitbild/module-runtime'
import { keySchema, labelSchema, planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import blank from './blank.plan-definition.json' with { type: 'json' }
import trainA from './train-a-work-week.plan-definition.json' with { type: 'json' }
import supplyRun from './supply-run.plan-definition.json' with { type: 'json' }
import deliveryDemo from './halden-delivery-planning.plan-definition.json' with { type: 'json' }
import maintenanceDemo from './nuclear-maintenance-planning.plan-definition.json' with { type: 'json' }
import { deliveryDemoDefinitionId } from './delivery-demo.ts'
import { maintenanceDemoDefinitionId } from './maintenance-demo.ts'

export { deliveryDemoDefinitionId, maintenanceDemoDefinitionId }
export const guidedPlanDefinitionIds = new Set([deliveryDemoDefinitionId, maintenanceDemoDefinitionId])

export const planDefinitionType = 'planning.plan-definition'
/** World's Scenario Definition type: a guided plan Definition is about the Scenario its settings name. */
const worldScenarioDefinitionType = 'world.scenario'

export interface PlanDefinition {
  readonly id: string
  readonly revisionId: string
  readonly title: string
  readonly description: string
  readonly inputs: PlanInputs
}
export interface PlanDefinitionsPort {
  readonly list: () => readonly PlanDefinition[]
}

export const planDefinitionDocumentSchema = z.object({
  id: keySchema,
  title: labelSchema,
  description: z.string().trim().min(1).max(1_024),
  inputs: planInputsSchema,
}).strict().superRefine((document, context) => {
  if (document.inputs.settings.run !== null) context.addIssue({ code: 'custom', path: ['inputs', 'settings', 'run'], message: 'A Definition creates an unlinked plan' })
})

/** 16 hex digits of the sha256 of the document's stable JSON. */
export const definitionRevisionId = (document: unknown): string => createHash('sha256').update(stableJson(document)).digest('hex').slice(0, 16)

const load = (raw: unknown): PlanDefinition => {
  const document = planDefinitionDocumentSchema.parse(raw)
  return { id: document.id, title: document.title, description: document.description, inputs: document.inputs, revisionId: definitionRevisionId(document) }
}

/** Blank first, then the guided demo and the full cases. */
export const bundledPlanDefinitions: readonly PlanDefinition[] = [blank, maintenanceDemo, deliveryDemo, trainA, supplyRun].map(load)

export const createPlanDefinitions = (definitions: readonly PlanDefinition[] = bundledPlanDefinitions): PlanDefinitionsPort => ({ list: () => definitions })

// Only a guided plan opens beside a Run of its Scenario, so only it is about that Scenario. The other
// Definitions name a Scenario to start and link to nothing.
const scenarioLinks = (workspaceId: WorkspaceId, definition: PlanDefinition) => {
  const scenario = guidedPlanDefinitionIds.has(definition.id) ? definition.inputs.settings.scenario : undefined
  return scenario === undefined ? {} : { links: [{ rel: ABOUT_RELATION, ref: { workspaceId, moduleId: 'world', type: worldScenarioDefinitionType, id: scenario.id } }] }
}

export const definitionDescriptors = (workspaceId: WorkspaceId, definitions: PlanDefinitionsPort, capabilityIds: readonly string[]): ModuleDefinitionDescriptor[] =>
  moduleDefinitionCollectionSchema.parse({ definitions: definitions.list().map(definition => ({
    ref: { workspaceId, moduleId: 'planning', type: planDefinitionType, id: definition.id },
    title: definition.title,
    description: definition.description,
    category: 'Plans',
    currentRevisionId: definition.revisionId,
    capabilityIds: [...capabilityIds],
    ...(guidedPlanDefinitionIds.has(definition.id) ? {} : { primaryCapabilityId: 'planning.plan.create' }),
    ...scenarioLinks(workspaceId, definition),
  })) }).definitions
