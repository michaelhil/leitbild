import type { WorldPack } from '../../core/packs/protocol.ts'
import { dronePackConfigSchema } from './config.ts'
import { createDroneAttackInteractionHandler } from './interactions.ts'
import { defaultDroneVehicleModels, dronePackDataSchema } from './model.ts'
import { droneScenarioSupport } from './scenario.ts'
import { dronePackView } from './ui-pack.ts'

export const dronePack: WorldPack = {
  inspectionReferences: object => { const data = dronePackDataSchema.parse(object.packData); return [...data.control.guidedTarget?.targetObjectId === undefined ? [] : [data.control.guidedTarget.targetObjectId], ...data.health.damage.flatMap(entry => entry.sourceObjectId === undefined ? [] : [entry.sourceObjectId])] },
  ...dronePackView,
  scenarioConfigSchema: dronePackConfigSchema,
  authoring: {
    configuration: {
      beforeStart: "Choose built-in or Pack-configured models by modelId. Custom models extend or override matching built-in ids; inspect the models schema for limits and sensor/control choices. altitudeM is metres, headingDeg is degrees clockwise from north. Runtime timing fields use milliseconds; smaller values increase mechanics/projection/transport work.",
      liveChanges: "Exact world.drone.* commands control vehicles and missions. configure-vehicle-model replaces one vehicle's validated model definition in that Run; discover its complete input schema and command constraints. Sensor contacts expose hasMore/nextAfter and read current state on each page.",
      requiresNewRevision: "Pack limits and step/projection/motion timing belong to the Scenario Pack Selection and require a new Scenario Revision and Run. Starting positions and initial model selections do not hot-rewrite existing vehicles.",
    },
    configFields: [
      { path: ['maxDrones'], label: 'Maximum drones', control: { kind: 'number', step: 1 } },
    ],
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
      placement: { kind: 'point', path: ['position'] },
      fields: [{
        path: ['modelId'], label: 'Vehicle model',
        control: {
          kind: 'select',
          options: defaultDroneVehicleModels.map(model => ({ value: model.id, label: model.label })),
          extendFromConfig: { path: ['models'], valueKey: 'id', labelKey: 'label' },
        },
      }, {
        path: ['altitudeM'], label: 'Altitude (m)',
        control: { kind: 'number', step: 5 },
      }, {
        path: ['headingDeg'], label: 'Heading (degrees)',
        control: { kind: 'number', min: 0, max: 360, step: 5 },
      }],
    }],
  },
  knowledge: { wikiRefs: [{ name: 'Drone knowledge', url: '/wiki?path=world%2Fpacks%2Fdrone%2Findex.md' }] },
  interactions: { handlers: [createDroneAttackInteractionHandler()] },
  scenario: droneScenarioSupport,
}
