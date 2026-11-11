import { describe, expect, test } from 'bun:test'
import {
  planningFactSchema, planningFactsInputSchema, planningLocatorSchema, planningProjectionInputSchema, planningSubjectSchema,
} from './planning-facts.ts'

const fact = { id: 'unit:truck-4/property/payloadKg', label: 'Payload', quantity: 'payload', unit: 'kg', value: 1500, basis: 'configured', at: '2026-09-03T08:00:00Z' }
const locators = (count: number) => Array.from({ length: count }, (_, index) => `einsatz/unit/unit%3Atruck-${index}`)

describe('World planning facts contract', () => {
  test('a number fact carries its unit; text and boolean facts need none', () => {
    expect(planningFactSchema.parse(fact).unit).toBe('kg')
    const { unit: _unit, ...withoutUnit } = fact
    const refused = planningFactSchema.safeParse(withoutUnit)
    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.path).toEqual(['unit'])
    expect(planningFactSchema.parse({ ...withoutUnit, value: true, basis: 'observed' }).value).toBe(true)
    expect(planningFactSchema.parse({ ...withoutUnit, value: 'en-route', basis: 'observed' }).value).toBe('en-route')
  })

  test('the four basis words are the only ones', () => {
    for (const basis of ['design', 'configured', 'observed', 'owner-estimate']) expect(planningFactSchema.safeParse({ ...fact, basis }).success).toBe(true)
    for (const basis of ['observation', 'estimate', '']) expect(planningFactSchema.safeParse({ ...fact, basis }).success).toBe(false)
  })

  test('a locator starts with its owning Pack segment', () => {
    expect(planningLocatorSchema.parse('process-plant/plant%3Atrain-a/serviceWaterPumpA')).toBe('process-plant/plant%3Atrain-a/serviceWaterPumpA')
    for (const locator of ['serviceWaterPumpA', '/unit/truck-1', 'Einsatz/unit/truck-1', 'unit:truck-1', '1pack/x']) {
      expect(planningLocatorSchema.safeParse(locator).success).toBe(false)
    }
    expect(planningSubjectSchema.safeParse({ locator: 'truck-1', label: 'Truck 1', kind: 'unit', facts: [] }).success).toBe(false)
  })

  test('detail reads at most 32 subjects, in one request', () => {
    expect(planningFactsInputSchema.parse({ subjects: locators(32) }).subjects).toHaveLength(32)
    expect(planningFactsInputSchema.safeParse({ subjects: locators(33) }).success).toBe(false)
    expect(planningFactsInputSchema.safeParse({ subjects: [] }).success).toBe(false)
    expect(planningProjectionInputSchema.parse({ subjects: locators(32), detail: 'facts' }).subjects).toHaveLength(32)
    expect(planningProjectionInputSchema.safeParse({ subjects: locators(33), detail: 'facts' }).success).toBe(false)
  })

  test('exact subjects are not mixed with a search', () => {
    expect(planningFactsInputSchema.parse({ text: 'truck', kind: 'unit', limit: 20 }).limit).toBe(20)
    expect(planningFactsInputSchema.safeParse({ text: 'truck', limit: 21 }).success).toBe(false)
    for (const extra of [{ text: 'truck' }, { kind: 'unit' }, { limit: 5 }]) {
      expect(planningFactsInputSchema.safeParse({ subjects: locators(2), ...extra }).success).toBe(false)
    }
  })
})
