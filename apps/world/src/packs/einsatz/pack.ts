import { einsatzInspectionReferences } from './read-policy.ts'
import type { WorldPack } from '../../core/packs/protocol.ts'
import { einsatzAuthoring } from './authoring.ts'
import { einsatzGuidance } from './capabilities.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { einsatzScenarioRoles } from './groups.ts'
import { createDroneObservationHandler } from './interactions/drone-observation.ts'
import { validateEinsatzScenarioConfig } from './scenario-config.ts'
import { einsatzScenarioSupport } from './scenario.ts'
import { einsatzPackView } from './ui-pack.ts'

/**
 * The Einsatz World Pack, registered with its runtime adapter in the World
 * application assembly beside the other road Pack, on the same routing.
 *
 * It is role-aware: in a Run that declares sides every object it writes
 * carries its side, or `public` for a public type; its queries and refusals
 * answer within the viewer core stamps; a public object holds counts only;
 * a command id stays on objects its caller's view holds; and it emits no
 * realtime messages. In a Scenario with sides each declared group becomes
 * an operator role (`groups.ts`); without sides a Run is open.
 *
 * Two links to other Packs, each through what that Pack publishes: a Drone
 * Pack reconnaissance observation of a task is recorded on it with a notice
 * (`interactions/drone-observation.ts`, its handler registered here), and
 * with the Weather Pack in the Run road units move at the pace the weather
 * at their position allows (`interactions/road-weather.ts`, read by the
 * runtime).
 */
export const einsatzPack: WorldPack = {
  inspectionReferences: einsatzInspectionReferences,
  ...einsatzPackView,
  scenarioConfigSchema: einsatzConfigSchema,
  authoring: einsatzAuthoring,
  knowledge: { wikiRefs: [{ name: 'Einsatz knowledge', url: '/wiki?path=world%2Fpacks%2Feinsatz%2Findex.md' }], guidance: einsatzGuidance },
  roleAware: true,
  validateScenarioConfig: validateEinsatzScenarioConfig,
  scenarioRoles: einsatzScenarioRoles,
  scenario: einsatzScenarioSupport,
  interactions: { handlers: [createDroneObservationHandler()] },
}
