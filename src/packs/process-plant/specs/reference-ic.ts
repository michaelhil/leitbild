import type { ProcessPlantIcConfig } from '../runtime/index.ts'
import { balanceOfPlantReferenceIcRules } from './reference-ic-balance-of-plant.ts'
import { pressurizerReferenceIcRules } from './reference-ic-pressurizer.ts'
import { reactorCoolantPumpReferenceIcRules } from './reference-ic-rcp.ts'
import { steamGeneratorReferenceIcRules } from './reference-ic-steam-generator.ts'

export const processPlantPressurizedWaterReactorIcRef = 'process-plant.pressurized-water-reactor.ic.v1'

export const pressurizedWaterReactorReferenceIc: ProcessPlantIcConfig = {
  rules: [
    ...pressurizerReferenceIcRules(),
    ...steamGeneratorReferenceIcRules('A'),
    ...steamGeneratorReferenceIcRules('B'),
    ...steamGeneratorReferenceIcRules('C'),
    ...steamGeneratorReferenceIcRules('D'),
    ...reactorCoolantPumpReferenceIcRules('A'),
    ...reactorCoolantPumpReferenceIcRules('B'),
    ...reactorCoolantPumpReferenceIcRules('C'),
    ...reactorCoolantPumpReferenceIcRules('D'),
    ...balanceOfPlantReferenceIcRules(),
  ],
}

const builtInProcessPlantIcConfigs = new Map<string, ProcessPlantIcConfig>([
  [processPlantPressurizedWaterReactorIcRef, pressurizedWaterReactorReferenceIc],
])

export const resolveProcessPlantIcConfig = (icRef: string): ProcessPlantIcConfig => {
  const config = builtInProcessPlantIcConfigs.get(icRef)
  if (!config) throw new Error(`unknown process plant icRef: ${icRef}`)
  return config
}

export const listProcessPlantIcRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantIcConfigs.keys()]
