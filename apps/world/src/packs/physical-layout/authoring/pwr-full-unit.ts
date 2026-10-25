import baseData from '../pwr-turbine-island.source.json'
import baseBindings from '../pwr-turbine-island.bindings.json'
import arrangement from './pwr-full-unit.arrangement.json'
import { physicalSourceSchema } from '../native/campus/source.ts'
import { composePhysicalArrangement } from './arrangement.ts'
import type { Binding } from './composition.ts'

/** Authoring input is the arrangement JSON; the three adjacent JSON artifacts are checked outputs. */
export const createPwrFullUnitPhysicalArtifacts = () => composePhysicalArrangement(arrangement, physicalSourceSchema.parse(baseData), baseBindings as Binding[])
