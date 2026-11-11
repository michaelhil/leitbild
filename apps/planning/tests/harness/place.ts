// Test harness, not shipped logic: places one job at a given start with a given choice of resources and
// writes its dated row. The harnesses use it to try alternatives (a job moved earlier, every schedule of
// a small instance); the product checker still judges every row it writes, so a mistake here shows up as
// a refused row, never as a passed one.
import type { PlanInputs } from '../../src/plan/schema.ts'
import { jobDuration, type CheckRow, type Context } from '../../src/check/check.ts'

type Job = PlanInputs['jobs'][number]

/** For each need, the resources that serve it, and whether the resources' permitted purchases may be used. */
export interface Choice { readonly resources: readonly string[]; readonly buy: boolean }

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z')

/** Every choice of one resource per unit of each need, with and without the permitted purchases. */
export const choicesFor = (context: Context, job: Job): Choice[] => {
  let combos: string[][] = [[]]
  for (const need of job.needs) {
    const next: string[][] = []
    for (const combo of combos) for (const resource of need.anyOf) next.push([...combo, ...Array.from({ length: need.amount }, () => resource)])
    combos = next
  }
  const anyPurchase = job.needs.some(need => need.anyOf.some(key => context.inputs.purchases.some(purchase => purchase.resource === key && context.permitted.has(purchase.key))))
  return combos.flatMap(resources => anyPurchase ? [{ resources, buy: false }, { resources, buy: true }] : [{ resources, buy: false }])
}

const sourcesOf = (context: Context, resource: string, buy: boolean): Array<{ readonly purchase?: string; readonly slots: Uint8Array }> => {
  const entry = context.resources.get(resource)
  if (entry === undefined) return []
  const base = context.calendars.get(entry.calendar) ?? new Uint8Array(context.grid.slots)
  const bought = buy ? context.inputs.purchases.filter(purchase => purchase.resource === resource && context.permitted.has(purchase.key)).map(purchase => ({ purchase: purchase.key, slots: context.added.get(purchase.key)! })) : []
  return [{ slots: base }, ...bought]
}

/** The row for `job` started at `startSlot` with `choice`, or undefined when it cannot be placed there. */
export const placeJob = (context: Context, job: Job, startSlot: number, choice: Choice): CheckRow | undefined => {
  const duration = jobDuration(context, job, new Set(choice.resources))
  if (!duration.ok) return undefined
  const { grid } = context
  const perResource = choice.resources.map(resource => sourcesOf(context, resource, choice.buy))
  const workingAt = (slot: number): boolean => perResource.every(sources => sources.some(source => source.slots[slot] === 1))
  const worked: number[] = []
  if (job.duration.calendar === 'elapsed' || duration.slots === 0 || job.needs.length === 0) {
    for (let slot = startSlot; slot < startSlot + duration.slots; slot++) worked.push(slot)
  } else if (job.continuous) {
    for (let slot = startSlot; slot < startSlot + duration.slots; slot++) { if (slot >= grid.slots || !workingAt(slot)) return undefined; worked.push(slot) }
  } else {
    if (!workingAt(startSlot)) return undefined
    for (let slot = startSlot; slot < grid.slots && worked.length < duration.slots; slot++) if (workingAt(slot)) worked.push(slot)
    if (worked.length < duration.slots) return undefined
  }
  const at = (slot: number): number => context.windowStart + slot * grid.slotMs
  const uses: Array<{ resource: string; from: string; to: string; purchase?: string }> = []
  choice.resources.forEach((resource, index) => {
    let open: { purchase?: string | undefined; from: number; to: number } | undefined
    const close = () => { if (open !== undefined) uses.push({ resource, from: iso(at(open.from)), to: iso(at(open.to)), ...(open.purchase === undefined ? {} : { purchase: open.purchase }) }); open = undefined }
    for (const slot of worked) {
      const source = perResource[index]!.find(candidate => candidate.slots[slot] === 1)
      if (source === undefined) { close(); continue }   // elapsed time outside the calendar: the checker refuses it
      if (open !== undefined && open.to === slot && open.purchase === source.purchase) { open.to = slot + 1; continue }
      close()
      open = { purchase: source.purchase, from: slot, to: slot + 1 }
    }
    close()
  })
  const finishSlot = worked.length === 0 ? startSlot : worked[worked.length - 1]! + 1
  return { job: job.key, start: iso(at(startSlot)), finish: iso(at(finishSlot)), uses }
}
