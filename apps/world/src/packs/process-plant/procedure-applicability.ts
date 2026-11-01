import type { OperationalObject } from '../../core/model/index.ts'
import { processPlantPackId, processPlantUnitPackDataSchema } from './model.ts'
import { pwrReferenceParametersSchema } from './assembly/pwr-reference-assembly.ts'
import { processPlantLd01ModelRef, processPlantPwrReferenceModelRef, processPlantPwrFullPowerOperatingPointRef, processPlantPwrReferenceAutomationRef } from './plant-definitions.ts'

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

/** An LD-01 procedure applies only to an LD-01 Plant, whose Plant Model is the compiled LD-01 unit graph; every other
 * target is refused, with no fallback to another graph (PHYS's applicability rule for LD01-E0). */
export const assertLd01ProcedureTarget = (object: Pick<OperationalObject, 'packId' | 'packData'>): void => {
  const data = processPlantUnitPackDataSchema.safeParse(object.packData)
  if (object.packId !== processPlantPackId || !data.success || data.data.model.ref !== processPlantLd01ModelRef) {
    throw new Error('LD-01 procedures apply only to an LD-01 Plant (the compiled LD-01 unit graph); no other target is admitted')
  }
}
