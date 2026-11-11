// Test support: the Supply run (maint/case2.json v1.1, converted by lane A) with a recorded-facts fixture.
// World values are never stored, so tests supply these TEST INPUTS (not World recordings, not schedule
// numbers): every truck's on-scene time is 180 s as in the Scenario; arrival seconds are chosen for the test.
import { planInputsSchema, type PlanInputs } from '../../plan/schema.ts'
import supplyRunJson from '../../plan/fixtures/supply-run.case2.json'

const arrivals: Record<string, number> = {
  'unit:truck-4/arrival-seconds/task:sports-hall-tank': 120,
  'unit:truck-1/arrival-seconds/task:sports-hall-tank': 300,
  'unit:truck-3/arrival-seconds/task:field-kitchen': 240,
  'unit:truck-4/arrival-seconds/task:field-kitchen': 200,
  'unit:truck-1/arrival-seconds/task:field-kitchen': 360,
}
const payloads: Record<string, number> = { 'unit:truck-1/property/payloadKg': 300, 'unit:truck-3/property/payloadKg': 800, 'unit:truck-4/property/payloadKg': 1_500 }

export const supplyRunBase = planInputsSchema.parse(supplyRunJson)
const refs = [...new Set(JSON.stringify(supplyRunBase).match(/"locator":"[^"]+","fact":"[^"]+"/g) ?? [])].map(text => JSON.parse(`{${text}}`) as { locator: string; fact: string })
const facts = refs.map(ref => {
  const value = ref.fact.endsWith('/service-seconds') ? 180 : arrivals[ref.fact] ?? payloads[ref.fact]
  if (value === undefined) throw new Error(`The facts fixture lacks ${ref.fact}`)
  return { locator: ref.locator, id: ref.fact, label: ref.fact, quantity: ref.fact.includes('payload') ? 'mass' : 'duration', unit: ref.fact.includes('payload') ? 'kg' : 's', value, basis: ref.fact.includes('payload') ? 'configured' : 'owner-estimate', at: '2026-09-03T08:00:00Z' }
})
export const withFacts = (inputs: PlanInputs): PlanInputs => planInputsSchema.parse({ ...inputs, world: { refreshedAt: '2026-09-03T08:00:00Z', facts } })
export const supplyRun = withFacts(supplyRunBase)
/** VS1: Truck 2 is announced late and joins at 08:05:00. */
export const lateTruck = planInputsSchema.parse({ ...supplyRun, calendars: supplyRun.calendars.map(calendar => (calendar.key === 'joins-0802' ? { ...calendar, periods: [{ start: '2026-09-03T08:05:00Z', end: '2026-09-03T08:30:00Z' }] } : calendar)) })
