import { rejectCapabilityInput } from '../../simulation/capability-rejection.ts'
import { processPlantPwrReferenceModelRef } from './plant-definitions.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { evaluateSafetyFunction, type SafetyFunctionComparison } from './safety-functions.ts'
import { pressurizedWaterReactorReferenceIc } from './specs/reference-ic.ts'

// The assessments a Plant answers are the critical safety functions its I&C
// declares, each judged by its status tree (safety-functions.ts). The trees
// are reference-model criteria after the generic Westinghouse ERG, not
// qualified plant procedures, and the values they read are runtime model
// evidence: neither establishes instrument validity or the adequacy of a
// safety function at a real plant.

const source = 'source:apps/world/src/packs/process-plant/specs/reference-ic-safety-functions.ts'
const qualification = {
  qualification: 'reference-model-criteria',
  automaticCsfQualified: false,
  instrumentationValidity: 'not-established',
} as const

export const processPlantAssessmentCatalog = (): ReadonlyArray<Record<string, unknown>> =>
  pressurizedWaterReactorReferenceIc.safetyFunctions.map(({ id, label, basis }) => ({
    id, title: label, description: `Critical safety function status: ${basis}.`, source, compatibleModelRef: processPlantPwrReferenceModelRef,
    ...qualification,
  }))

/** The declared critical safety functions, judged now: all, or those named, in declaration order. */
export const evaluateProcessPlantAssessments = (
  plant: ProcessPlantRuntimeInstance,
  assessmentIds: ReadonlyArray<string> | undefined,
  detail: 'full' | 'summary' = 'full',
): ReadonlyArray<Record<string, unknown>> => {
  const declared = plant.plant.automation.safetyFunctions
  const unknown = (assessmentIds ?? []).filter(id => !declared.some(safetyFunction => safetyFunction.id === id))
  if (unknown.length > 0) {
    return rejectCapabilityInput(`Unknown assessment${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}; Process Plant ${plant.plant.id} declares ${declared.map(safetyFunction => safetyFunction.id).join(', ') || 'none'}.`)
  }
  const identity = { modelRef: plant.plant.modelRef, modelDigest: plant.plant.modelDigest, simTimeMs: plant.runtime.elapsedMs() }
  return declared
    .filter(safetyFunction => assessmentIds === undefined || assessmentIds.includes(safetyFunction.id))
    .map(safetyFunction => {
      const { label, basis, ...evaluation } = evaluateSafetyFunction({ system: plant.plant, runtime: plant.runtime, safetyFunction })
      const { path, checks, ...status } = evaluation
      const unresolved = (comparisons: ReadonlyArray<SafetyFunctionComparison>) => comparisons.filter(comparison => comparison.answer === 'unknown' || comparison.reason !== undefined)
      // A current status board is a different read from inspecting its full
      // tree. It retains the same verdict, frame, qualification and exceptions;
      // it never changes the evaluator or claims to carry every deciding value.
      const facts = detail === 'full' ? evaluation : {
        ...status,
        checks: checks.map(check => {
          if (check.met !== 'yes') return check
          const { comparisons, ...summary } = check
          const exceptions = unresolved(comparisons)
          return { ...summary, ...(exceptions.length === 0 ? {} : { unresolved: exceptions }) }
        }),
        unresolved: path.flatMap(step => {
          const comparisons = unresolved(step.comparisons)
          return comparisons.length === 0 ? [] : [{ ...step, comparisons }]
        }),
      }
      return { ...identity, ...facts, title: label, basis: { source, tree: basis }, ...qualification }
    })
}
