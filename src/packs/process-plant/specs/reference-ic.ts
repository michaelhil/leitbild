import type { ProcessPlantIcConfig } from '../runtime/index.ts'
import { processPlantIcConfigSchema } from '../runtime/index.ts'
import { accumulatorReferenceIcRules } from './reference-ic-accumulator.ts'
import { balanceOfPlantReferenceIcRules } from './reference-ic-balance-of-plant.ts'
import { containmentReferenceIcRules } from './reference-ic-containment.ts'
import { electricalReferenceIcRules } from './reference-ic-electrical.ts'
import { pressurizerReferenceIcRules } from './reference-ic-pressurizer.ts'
import { reactorReferenceIcRules } from './reference-ic-reactor.ts'
import { reactorCoolantPumpReferenceIcRules } from './reference-ic-rcp.ts'
import { steamGeneratorReferenceIcRules } from './reference-ic-steam-generator.ts'

export const processPlantPressurizedWaterReactorIcRef = 'process-plant.pressurized-water-reactor.ic.v1'

export const pressurizedWaterReactorReferenceIc: ProcessPlantIcConfig = {
  rules: [
    ...reactorReferenceIcRules(),
    ...pressurizerReferenceIcRules(),
    ...steamGeneratorReferenceIcRules('A'),
    ...steamGeneratorReferenceIcRules('B'),
    ...steamGeneratorReferenceIcRules('C'),
    ...steamGeneratorReferenceIcRules('D'),
    ...reactorCoolantPumpReferenceIcRules('A'),
    ...reactorCoolantPumpReferenceIcRules('B'),
    ...reactorCoolantPumpReferenceIcRules('C'),
    ...reactorCoolantPumpReferenceIcRules('D'),
    ...accumulatorReferenceIcRules('A'),
    ...accumulatorReferenceIcRules('B'),
    ...accumulatorReferenceIcRules('C'),
    ...accumulatorReferenceIcRules('D'),
    ...containmentReferenceIcRules(),
    ...electricalReferenceIcRules(),
    ...balanceOfPlantReferenceIcRules(),
  ],
}

const builtInProcessPlantIcConfigs = new Map<string, ProcessPlantIcConfig>([
  [processPlantPressurizedWaterReactorIcRef, pressurizedWaterReactorReferenceIc],
])

export const resolveProcessPlantIcConfig = (icRef: string): ProcessPlantIcConfig => {
  const config = builtInProcessPlantIcConfigs.get(icRef)
  if (!config) throw new Error(`unknown process plant icRef: ${icRef}`)
  return processPlantIcConfigSchema.parse(structuredClone(config))
}

export const listProcessPlantIcRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantIcConfigs.keys()]
