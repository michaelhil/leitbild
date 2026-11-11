import { describe, expect, test } from 'bun:test'
import fragmentJson from '../plan/fixtures/train-a.fragment.json'
import { planInputsSchema } from '../plan/schema.ts'
import caseJson from '../../tests/harness/fixtures/train-a-case-v0.2.json'
import { trainAInputs } from '../../tests/harness/train-a-case.ts'

// Lane K's harness and lane A's fixture each convert the frozen case (a552c921) on their own. Every value
// both carry must agree, so an error in either shows here. Only the names below differ by design.
// TODO(integration): run the same comparison against lane P's Train A Definition once it lands.
const fragment = planInputsSchema.parse(fragmentJson)
const mine = trainAInputs(caseJson, { method: 'M2-swap', overtime: true, nights: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'], craneFriday: true, ectFriday: true }).inputs
const optionName: Readonly<Record<string, string>> = { rebuild: 'M1-rebuild', swap: 'M2-swap' }
// lane A names the protected items short; lane K keeps the case's own ids (the switchyard is case change C10)
const itemName: Readonly<Record<string, string>> = {
  SWB: 'serviceWaterPumpB', CCWB: 'componentCoolingWaterPumpB', RHRB: 'rhrPumpB', HHSIB: 'safetyInjectionPumpB', CSB: 'containmentSprayPumpB',
  AFWB: 'auxFeedwaterPumpMotorB', AFWTD: 'auxFeedwaterPumpTurbine', EDGB: 'dieselGeneratorB', BUSB: 'safetyBusB', SWYD: 'switchyard',
}
const byKey = <T extends { key: string }>(list: readonly T[], key: string): T => {
  const found = list.find(entry => entry.key === key)
  if (found === undefined) throw new Error(`lane K's conversion has no ${key}`)
  return found
}
const allJobs = [...mine.jobs, ...trainAInputs(caseJson, { method: 'M1-rebuild', overtime: true, nights: [], craneFriday: true, ectFriday: true }).inputs.jobs]

describe("lane K's Train A conversion agrees with lane A's fixture", () => {
  test('jobs: kind, items, isolation, duration, needs, continuity, method, release, preconditions', () => {
    for (const job of fragment.jobs) {
      const other = byKey(allJobs, job.key)
      expect([other.key, other.kind, [...other.equipment].sort(), other.isolation]).toEqual([job.key, job.kind, [...job.equipment].sort(), job.isolation])
      expect([other.duration.value, other.duration.unit, other.duration.calendar, other.duration.range]).toEqual([job.duration.value, job.duration.unit, job.duration.calendar, job.duration.range])
      expect(other.needs).toEqual(job.needs)
      expect(other.continuous).toBe(job.continuous)
      expect(other.method?.option).toBe(job.method === undefined ? undefined : optionName[job.method.option])
      expect(other.notBefore?.at).toBe(job.notBefore?.at)
      expect(other.checks.map(check => [check.equipment, check.fact, check.expect])).toEqual(job.checks.map(check => [itemName[check.equipment] ?? check.equipment, check.fact, check.expect]))
    }
  })
  test('links, with the method options named alike', () => {
    for (const link of fragment.links) {
      const method = link.method
      const other = mine.links.concat(trainAInputs(caseJson, { method: 'M1-rebuild', overtime: true, nights: [], craneFriday: true, ectFriday: true }).inputs.links)
        .find(candidate => candidate.from === link.from && candidate.to === link.to && candidate.type === link.type)
      expect(other?.lag).toEqual(link.lag)
      expect(other?.method?.option).toBe(method === undefined ? undefined : optionName[method.option])
    }
  })
  test('equipment, supports and groups', () => {
    for (const item of fragment.equipment) {
      const other = byKey(mine.equipment, itemName[item.key] ?? item.key)
      expect([other.group, other.supportedBy, other.locator, other.source?.by]).toEqual([item.group, item.supportedBy, item.locator, item.source?.by])
    }
  })
  test('calendars, resources, purchases and method costs', () => {
    for (const calendar of fragment.calendars) {
      const other = byKey(mine.calendars, calendar.key)
      expect([other.weekly, other.periods, other.except]).toEqual([calendar.weekly, calendar.periods, calendar.except])
    }
    for (const resource of fragment.resources) {
      const other = byKey(mine.resources, resource.key)
      expect([other.count, other.crewSize, other.calendar]).toEqual([resource.count, resource.crewSize, resource.calendar])
    }
    for (const purchase of fragment.purchases) {
      const other = byKey(mine.purchases, purchase.key)
      expect([other.resource, other.adds, other.replaces, other.price, other.orderBy]).toEqual([purchase.resource, purchase.adds, purchase.replaces, purchase.price, purchase.orderBy])
    }
    for (const option of fragment.methods[0]!.options) {
      expect(mine.methods[0]!.options.find(candidate => candidate.key === optionName[option.key])?.fixedCost).toBe(option.fixedCost)
    }
  })
  test('the cooling-chain limit and the protected train', () => {
    for (const limit of fragment.rules) {
      if (limit.kind !== 'span-limit') continue
      const other = mine.rules.find(rule => rule.kind === 'span-limit' && rule.group === limit.group)
      expect(other?.kind === 'span-limit' ? [other.limit, other.singleEntry] : undefined).toEqual([limit.limit, limit.singleEntry])
    }
    const mineShielded = mine.rules.flatMap(rule => rule.kind === 'protected' ? rule.equipment : [])
    const theirs = fragment.rules.flatMap(rule => rule.kind === 'protected' ? rule.equipment.map(item => itemName[item] ?? item) : [])
    expect([...mineShielded].sort()).toEqual([...theirs].sort())
  })
})
