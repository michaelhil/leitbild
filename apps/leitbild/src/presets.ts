import { capabilityIdSchema, type CapabilityId } from '@leitbild/contracts'

export interface PresetAction {
  readonly capabilityId: CapabilityId
  readonly input: unknown
}

export interface PresetDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly actions: ReadonlyArray<PresetAction>
}

// Presets intentionally contain only independent, apply-once Capability calls.
// They are not workflows: no output references, branching, schedules, or state.
export const PRESET_CATALOG: ReadonlyArray<PresetDefinition> = [
  {
    id: 'halden-process-control-room',
    title: 'Halden Process Control Room',
    description: 'Starts the Halden process-plant World and a structured control-room Agents room.',
    actions: [
      {
        capabilityId: capabilityIdSchema.parse('world.simulation-run.create'),
        input: { scenarioId: 'halden-process-plant-demo' },
      },
      {
        capabilityId: capabilityIdSchema.parse('agents.demo.apply'),
        input: { demoId: 'control-room-script' },
      },
    ],
  },
]

export const getPreset = (id: string): PresetDefinition | undefined =>
  PRESET_CATALOG.find(preset => preset.id === id)
