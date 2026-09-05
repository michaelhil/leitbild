import { describe, expect, test } from 'bun:test'
import { AUTO_BUDGET_FALLBACK, OUTPUT_RESERVE, SAFETY_MARGIN, computeContextBudget } from './budget.ts'

const estimate = (text: string): number => Math.ceil(text.length / 4)
const tool = { name: 'read', description: 'Read a Resource.', parameters: { type: 'object', properties: { id: { type: 'string' } } } }

describe('computeContextBudget', () => {
  test('always reserves the actual tool surface, output, and safety margin', () => {
    const result = computeContextBudget({ contextMax: 128_000, toolDefinitions: [tool] }, estimate)
    expect(result.budget).toBe(128_000 - result.toolDefinitionTokens - OUTPUT_RESERVE - SAFETY_MARGIN)
    expect(result.toolDefinitionTokens).toBeGreaterThan(0)
  })

  test('uses an explicit fallback for an unknown model', () => {
    const result = computeContextBudget({ contextMax: 0, toolDefinitions: [tool] }, estimate)
    expect(result.budget).toBe(AUTO_BUDGET_FALLBACK - result.toolDefinitionTokens - OUTPUT_RESERVE - SAFETY_MARGIN)
    expect(result.reason).toContain('unknown-model')
  })

  test('does not invent capacity for a pathological tool surface', () => {
    const tools = Array.from({ length: 5_000 }, (_, index) => ({ ...tool, name: `read_${index}`, description: 'large '.repeat(100) }))
    expect(computeContextBudget({ contextMax: 32_000, toolDefinitions: tools }, estimate).budget).toBe(0)
  })
})
