import type { OperationalObject } from '../../core/model/index.ts'
import { processPlantPackId, processPlantUnitPackDataSchema } from './model.ts'
import { pwrReferenceParametersSchema } from './assembly/pwr-reference-assembly.ts'
import { processPlantPwrReferenceModelRef, processPlantPwrFullPowerOperatingPointRef, processPlantPwrReferenceAutomationRef } from './plant-definitions.ts'

/** Admission to annotated reference guidance, never proof of qualified criteria. */
export const assertPwrReferenceProcedureTarget = (object: Pick<OperationalObject, 'packId' | 'packData'>): void => {
  const data = processPlantUnitPackDataSchema.safeParse(object.packData)
  if (object.packId !== processPlantPackId || !data.success) throw new Error('PWR reference procedures require an actual Process Plant target')
  const selection = data.data
  const parameters = pwrReferenceParametersSchema.safeParse(selection.model.parameters)
  if (selection.model.ref !== processPlantPwrReferenceModelRef || !parameters.success || parameters.data.loopCount !== 4
    || selection.operatingPoint.ref !== processPlantPwrFullPowerOperatingPointRef
    || selection.automation.ref !== processPlantPwrReferenceAutomationRef
    || Object.keys(selection.operatingPoint.parameterOverrides ?? {}).length > 0
    || Object.keys(selection.operatingPoint.valueOverrides ?? {}).length > 0) {
    throw new Error('PWR reference procedures apply only to the unmodified four-loop reference model initialized at its standard full-power operating point with standard I&C; matching that scope does not qualify the manual reference criteria')
  }
}
