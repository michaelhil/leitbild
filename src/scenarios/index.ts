import type { ScenarioDefinition } from '../core/model/index.ts'
import { osloAmbulanceTutorialScenario } from './oslo-ambulance-tutorial.ts'

export const scenarios: ReadonlyArray<ScenarioDefinition> = [
  osloAmbulanceTutorialScenario,
]

export { osloAmbulanceTutorialScenario }
