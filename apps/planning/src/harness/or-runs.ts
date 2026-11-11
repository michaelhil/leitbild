// Test harness, the bench adapter: or's v0.2 runs (R/or/runs/v02-*.json) as dated rows the product checker
// can judge. The uses of each row come from or's own instance and solution (its mode calendars and
// demands), never from the product checker, so the two derivations meet only at the check.
//
// Regenerate the fixture (reads the review folder, verifies nothing is edited by hashing each run):
//   bun apps/planning/src/harness/or-runs.ts <R>/or/runs apps/planning/src/harness/fixtures/or-v02-runs.json
import type { CaseActual, CaseChoices, CaseProgress } from './train-a-case.ts'
import type { CheckRow } from '../check/check.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OrRunExtract {
  readonly name: string
  readonly sha256: string
  readonly status: string
  readonly disruption?: string
  readonly choices: CaseChoices
  readonly asOf: string | null
  readonly actuals: readonly CaseActual[]
  readonly addedJobs: readonly string[]
  readonly failedTests: readonly string[]
  /** or's own measures for the schedule, to compare with the checker's metrics. */
  readonly claimed: { readonly groupSpanHours: Readonly<Record<string, number>>; readonly guidelineExcessHours: number; readonly unavailableHours: number; readonly extraCost: number }
  readonly rows: readonly CheckRow[]
}

const utc = (iso: string): string => new Date(Date.parse(iso)).toISOString().replace('.000Z', 'Z')

/** or resource ids, with the slot it is used in, to a product resource and the purchase that bought it. */
const productSource = (orResource: string, rate: number, modeCalendar: string): { readonly resource: string; readonly purchase?: string } => {
  if (orResource === 'mech-station') return rate > 0 ? { resource: 'mech-station', purchase: 'ot-mech' } : { resource: 'mech-station' }
  if (orResource === 'elec-station') return rate > 0 ? { resource: 'elec-station', purchase: 'ot-elec' } : { resource: 'elec-station' }
  if (orResource.startsWith('mech-contractor@')) return { resource: 'mech-contractor', purchase: 'contractor-nights' }
  if (orResource === 'crane@fri') return { resource: 'crane', purchase: 'crane-fri' }
  if (orResource === 'ect-team') return modeCalendar === 'ect-fri' ? { resource: 'ect-team', purchase: 'ect-friday' } : { resource: 'ect-team' }
  return { resource: orResource }
}

export const extractOrRun = (run: any, sha256: string): OrRunExtract => {
  const instance = run.instance
  const slotMs = instance.slotHours * 3_600_000
  const first = run.schedule[0]
  const windowStart = Date.parse(first.start) - first.startSlot * slotMs
  const at = (slot: number): string => new Date(windowStart + slot * slotMs).toISOString().replace('.000Z', 'Z')
  const calendars = new Map<string, boolean[]>(instance.calendars.map((calendar: any) => [calendar.id, calendar.work]))
  const resources = new Map<string, any>(instance.resources.map((resource: any) => [resource.id, resource]))
  const rows: CheckRow[] = []
  instance.activities.forEach((activity: any, index: number) => {
    const scheduled = run.schedule.find((row: any) => row.activityId === activity.id)
    if (scheduled === undefined) return   // helper milestones carry no job
    const mode = activity.modes[run.solution.mode[index]]
    const start = run.solution.start[index] as number
    if (start !== scheduled.startSlot) throw new Error(`${run.run}: ${activity.id} schedule and solution disagree`)
    const work = calendars.get(mode.calendar)!
    const worked: number[] = []
    if (mode.work > 0) {
      if (mode.interruptible) { for (let slot = start; slot < instance.horizon && worked.length < mode.work; slot++) if (work[slot]) worked.push(slot) }
      else for (let slot = start; slot < start + mode.work; slot++) worked.push(slot)
    }
    const uses: Array<{ resource: string; from: string; to: string; purchase?: string }> = []
    for (const demand of mode.demands) {
      const when = demand.when === undefined ? undefined : calendars.get(demand.when)!
      const resource = resources.get(demand.resource)
      let open: { source: { resource: string; purchase?: string }; from: number; to: number } | undefined
      const close = () => { if (open !== undefined) for (let unit = 0; unit < demand.amount; unit++) uses.push({ resource: open.source.resource, from: at(open.from), to: at(open.to), ...(open.source.purchase === undefined ? {} : { purchase: open.source.purchase }) }); open = undefined }
      for (const slot of worked) {
        if (when !== undefined && !when[slot]) { close(); continue }
        const source = productSource(demand.resource, resource.rate[slot], mode.calendar)
        if (open !== undefined && open.to === slot && open.source.resource === source.resource && open.source.purchase === source.purchase) { open.to = slot + 1; continue }
        close()
        open = { source, from: slot, to: slot + 1 }
      }
      close()
    }
    rows.push({ job: activity.id.replace('~rest', '.rest'), start: utc(scheduled.start), finish: utc(scheduled.end), uses })
  })
  const nights = run.choices.nights as string[]
  if (nights.length !== 0 && nights.length !== 4) throw new Error(`${run.run}: the adapter models all four nights or none`)
  return {
    name: run.run, sha256, status: run.status.status,
    ...(run.disruption === undefined ? {} : { disruption: run.disruption }),
    choices: run.choices, asOf: run.asOf, actuals: run.actuals, addedJobs: run.addedJobs, failedTests: run.failedTests,
    claimed: {
      groupSpanHours: Object.fromEntries(run.measures.groupSpans.map((span: any) => [span.id, span.hours])),
      // from or's measures, which are recomputed from job times; its objective uses helper milestones that
      // may float (v02-base-M1-ot1-n4 claims 12 h there, its own measures 11 h)
      guidelineExcessHours: run.measures.groupSpans.reduce((sum: number, span: any) => sum + span.guidelineExcessHours, 0),
      unavailableHours: run.measures.unavailableHours,
      extraCost: run.measures.extraCost.totalNok,
    },
    rows,
  }
}

/** Replan progress from the run and the frozen case's disruption record. */
export const progressOf = (cj: any, run: OrRunExtract): CaseProgress | undefined => {
  if (run.asOf === null) return undefined
  const disruption = (prefix: string) => (cj.disruptions as any[]).find(item => item.id.startsWith(`${prefix}-`))
  const x2 = run.disruption === 'X2' ? disruption('X2').change : undefined
  const x3 = run.disruption === 'X3' ? disruption('X3').change : undefined
  const x4 = run.disruption === 'X4' ? disruption('X4').change : undefined
  const addJobs = [...(x3 === undefined ? [] : [x3.addJob]), ...(x4?.addJobs ?? [])]
  if (addJobs.map(job => job.id).sort().join() !== [...run.addedJobs].sort().join()) throw new Error(`${run.name}: added jobs differ from the case`)
  return {
    asOf: run.asOf, actuals: run.actuals, addJobs, addLinks: [...(x3?.addLinks ?? []), ...(x4?.addLinks ?? [])],
    failedTests: run.failedTests, capacityLoss: x2?.capacityLoss === undefined ? [] : [x2.capacityLoss],
  }
}

if (import.meta.main) {
  const [directory, out] = process.argv.slice(2)
  if (directory === undefined || out === undefined) throw new Error('usage: bun or-runs.ts <or/runs directory> <out.json>')
  const runs: OrRunExtract[] = []
  for (const name of [...new Bun.Glob('v02-*.json').scanSync({ cwd: directory })].sort()) {
    const text = await Bun.file(`${directory}/${name}`).text()
    const run = JSON.parse(text)
    if (!run.solution) continue
    const sha256 = new Bun.CryptoHasher('sha256').update(text).digest('hex')
    runs.push(extractOrRun(run, sha256))
  }
  await Bun.write(out, `${JSON.stringify({ source: 'R/or/runs v0.2 schedules (or bench, case-v0.2 a552c921…)', runs }, null, 1)}\n`)
  console.log(`wrote ${runs.length} runs to ${out}`)
}
