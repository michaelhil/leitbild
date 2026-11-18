// Test support: the frozen flagship (maint/case-v0.2.json, sha256 a552c921…) as plan inputs, from lane A's
// full fixture plan/fixtures/train-a.case.json. `read` adds the World facts a refresh would copy for the
// plan's own preconditions (each job check, read as its expected state at the data date): TEST INPUTS
// derived from the fixture, never typed per item. Without them every option is invalid input.
import { planInputsSchema, type PlanInputs } from '../../plan/schema.ts'
import caseJson from '../../plan/fixtures/train-a.case.json'

export const TRAIN_A_CASE_SHA256 = 'a552c921c58fe982c3d413fe7ccd8ae505b9f312949f804f541706e6460ed9b1'

/** The facts a refresh would read for the plan's preconditions, each at its expected value. */
export const preconditionFacts = (inputs: PlanInputs): PlanInputs['world']['facts'] => {
  const at = inputs.settings.dataDate ?? inputs.settings.window?.start ?? new Date(0).toISOString()
  return inputs.jobs.flatMap(job => job.checks.map(check => {
    const locator = inputs.equipment.find(item => item.key === check.equipment)?.locator
    if (locator === undefined) throw new Error(`${check.equipment} has no World locator to read`)
    return { locator, id: check.fact, label: check.words, quantity: 'state', value: check.expect, basis: 'observed' as const, at, ...(typeof check.expect === 'number' ? { unit: '1' } : {}) }
  }))
}

/** The full flagship: 34 jobs, 41 planner links, every 72 h group rule. */
export const trainAInputs = (options: { readonly read?: boolean } = {}): PlanInputs => {
  const inputs = planInputsSchema.parse(caseJson)
  if (options.read !== true) return inputs
  const facts = preconditionFacts(inputs)
  return planInputsSchema.parse({ ...inputs, world: { refreshedAt: facts[0]?.at ?? null, facts } })
}
