import { planningProjectionInputSchema, planningProjectionOutputSchema } from '@leitbild/contracts'
import { defineSimulationQueryCapability } from './capabilities.ts'

/**
 * A Pack's planning projection, `world.<pack>.planning-basis`. Only World core's
 * planning facts query reads it; the Pack owns every fact, its unit and basis.
 */
export const planningProjectionCapability = (id: string) => defineSimulationQueryCapability({
  id,
  title: 'Project planning facts',
  description: 'World-owned read of this Pack\'s planning subjects. index lists every subject without costly estimates; facts reads the named subjects together, each value with its unit, basis and simulation time. Unknown locators are left out.',
  readScope: 'collection',
  audience: 'system',
  input: planningProjectionInputSchema,
  output: planningProjectionOutputSchema,
})
