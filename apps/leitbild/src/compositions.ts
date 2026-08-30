import {
  capabilityIdSchema,
  definitionIdSchema,
  definitionTypeSchema,
  moduleIdSchema,
  type CapabilityId,
  type DefinitionId,
  type DefinitionType,
  type ModuleId,
} from '@leitbild/contracts'

export interface CompositionAction {
  readonly capabilityId: CapabilityId
  readonly moduleId: ModuleId
  readonly definitionType: DefinitionType
  readonly definitionId: DefinitionId
}

export interface CompositionDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly actions: ReadonlyArray<CompositionAction>
}

// Compositions intentionally contain only independent, apply-once Definition
// starts. They resolve exact current revisions before invoking Modules.
// They are not workflows: no output references, branching, schedules, or state.
export const COMPOSITION_CATALOG: ReadonlyArray<CompositionDefinition> = [
  {
    id: 'halden-process-control-room',
    title: 'Halden Process Control Room',
    description: 'Starts the Halden process-plant World and a structured control-room Agents room.',
    actions: [
      {
        capabilityId: capabilityIdSchema.parse('world.scenario.start'),
        moduleId: moduleIdSchema.parse('world'),
        definitionType: definitionTypeSchema.parse('world.scenario'),
        definitionId: definitionIdSchema.parse('halden-process-plant-demo'),
      },
      {
        capabilityId: capabilityIdSchema.parse('agents.room-definition.start'),
        moduleId: moduleIdSchema.parse('agents'),
        definitionType: definitionTypeSchema.parse('agents.room'),
        definitionId: definitionIdSchema.parse('control-room-script'),
      },
    ],
  },
]

export const getComposition = (id: string): CompositionDefinition | undefined =>
  COMPOSITION_CATALOG.find(composition => composition.id === id)
