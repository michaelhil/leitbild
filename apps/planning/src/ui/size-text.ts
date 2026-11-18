// The plan's size against the certified size, as the one short line under the plan's title.
import type { CertifiedSize, PlanInputs } from '../plan/schema.ts'
import { jobsPerSolve, sizeBand } from '../plan/summary.ts'

/**
 * "Plan size: 33 jobs · certified up to 33, handles up to 40 with a caution". Jobs are counted as Generate
 * counts them: the most any one option holds. A plan above the certified size says which side of the limit
 * it is on. While the owner has not decided a size, the line says so and gives the measured size.
 */
export const planSizeLine = (size: CertifiedSize, inputs: Pick<PlanInputs, 'jobs' | 'methods'>): string => {
  const jobs = jobsPerSolve(inputs)
  const own = `Plan size: ${jobs} ${jobs === 1 ? 'job' : 'jobs'}`
  if (!size.decided) return `${own} · certified size pending the owner's decision, measured up to ${size.maxJobs}`
  const band = sizeBand(inputs, size)
  const certified = `certified up to ${size.maxJobs}, handles up to ${size.limitJobs} with a caution`
  return `${own} · ${certified}${band === 'certified' ? '' : band === 'caution' ? ' · this plan is above the certified size: its options carry the caution' : ' · this plan is too large to generate'}`
}
