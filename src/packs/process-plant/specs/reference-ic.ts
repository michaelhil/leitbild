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
import { fourLoopReferenceLetters, referenceLoopLettersForCount, sixLoopReferenceLetters, type ProcessPlantReferenceLoop } from './reference-loop.ts'

export const processPlantPressurizedWaterReactorIcRef = 'process-plant.pressurized-water-reactor.ic.v1'
export const processPlantPressurizedWaterReactorSixLoopIcRef = 'process-plant.pressurized-water-reactor-6-loop.ic.v1'
export const processPlantPwrReferenceIcRefForLoopCount = (loopCount: number): string =>
  `process-plant.pwr.reference.${loopCount}-loop.ic.v2`

export const pressurizedWaterReactorReferenceIcFor = (
  loops: ReadonlyArray<ProcessPlantReferenceLoop>,
): ProcessPlantIcConfig => ({
  rules: [
    ...reactorReferenceIcRules(loops),
    ...pressurizerReferenceIcRules(),
    ...loops.flatMap(loop => steamGeneratorReferenceIcRules(loop)),
    ...loops.flatMap(loop => reactorCoolantPumpReferenceIcRules(loop)),
    ...loops.flatMap(loop => accumulatorReferenceIcRules(loop)),
    ...containmentReferenceIcRules(),
    ...electricalReferenceIcRules(),
    ...balanceOfPlantReferenceIcRules(),
  ],
})

export const pressurizedWaterReactorReferenceIc: ProcessPlantIcConfig = pressurizedWaterReactorReferenceIcFor(fourLoopReferenceLetters)
export const pressurizedWaterReactorSixLoopReferenceIc: ProcessPlantIcConfig = pressurizedWaterReactorReferenceIcFor(sixLoopReferenceLetters)

const builtInProcessPlantIcConfigs = new Map<string, ProcessPlantIcConfig>([
  [processPlantPressurizedWaterReactorIcRef, pressurizedWaterReactorReferenceIc],
  [processPlantPressurizedWaterReactorSixLoopIcRef, pressurizedWaterReactorSixLoopReferenceIc],
])

export const resolveProcessPlantIcConfig = (icRef: string): ProcessPlantIcConfig => {
  const config = builtInProcessPlantIcConfigs.get(icRef)
  if (config) return processPlantIcConfigSchema.parse(structuredClone(config))
  const dynamicPwrMatch = /^process-plant\.pwr\.reference\.(\d+)-loop\.ic\.v2$/u.exec(icRef)
  if (dynamicPwrMatch) {
    const loopCount = Number(dynamicPwrMatch[1])
    return processPlantIcConfigSchema.parse(pressurizedWaterReactorReferenceIcFor(referenceLoopLettersForCount(loopCount)))
  }
  throw new Error(`unknown process plant icRef: ${icRef}`)
}

export const listProcessPlantIcRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantIcConfigs.keys()]
