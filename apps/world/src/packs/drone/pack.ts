import type { WorldPack } from '../../core/packs/protocol.ts'
import { dronePackConfigSchema, droneScenarioSupport } from './scenario.ts'
import { dronePackView } from './ui-pack.ts'
import { createDroneAttackInteractionHandler } from './interactions.ts'
import { defaultDroneVehicleModels } from './model.ts'

export const dronePack: WorldPack = {
  ...dronePackView,
  scenarioConfigSchema: dronePackConfigSchema,
  authoring: {
    itemTypes: [{
      id: 'drone',
      label: 'Drone',
      description: 'A simulated aircraft with a selected vehicle model, starting altitude, and heading.',
      idPrefix: 'drone',
      defaultItem: {
        modelId: 'native-survey-quad',
        altitudeM: 35,
        headingDeg: 0,
      },
      placement: { target: 'item', kind: 'point', path: ['position'] },
      fields: [{
        target: 'item', path: ['modelId'], label: 'Vehicle model',
        control: {
          kind: 'select',
          defaultValue: 'native-survey-quad',
          options: defaultDroneVehicleModels.map(model => ({ value: model.id, label: model.label })),
        },
      }, {
        target: 'item', path: ['altitudeM'], label: 'Altitude (m)',
        control: { kind: 'number', defaultValue: 35, min: 0, max: 500, step: 5 },
      }, {
        target: 'item', path: ['headingDeg'], label: 'Heading (degrees)',
        control: { kind: 'number', defaultValue: 0, min: 0, max: 360, step: 5 },
      }],
    }],
  },
  knowledge: { wikiRefs: [{ name: 'Drone operations', url: '/docs/wiki/drone-ops.md' }] },
  interactions: { handlers: [createDroneAttackInteractionHandler()] },
  scenario: droneScenarioSupport,
}
