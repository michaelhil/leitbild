import { describe, expect, test } from 'bun:test'
import { reasoningEffortChoices } from './model-group.ts'
import { REASONING_EFFORTS } from '../../../core/types/llm.ts'
import type { ModelInfo } from '../../../core/types/model-info.ts'

const info = (reasoning?: ModelInfo['reasoning']): ModelInfo => ({ id: 'fixture', provider: 'openrouter', contextMax: 0, source: 'provider_api', ...(reasoning ? { reasoning } : {}) })
describe('reasoning effort choices', () => {
  test('null means all gateway values; omission is not support', () => {
    expect(reasoningEffortChoices(info({ supportedEfforts: null }))).toEqual(REASONING_EFFORTS)
    expect(reasoningEffortChoices(info({}))).toEqual([])
    expect(reasoningEffortChoices(info())).toEqual([])
    expect(reasoningEffortChoices()).toEqual([])
  })
  test('provider order is retained; mandatory removes none; unknown values are not guessed', () => {
    expect(reasoningEffortChoices(info({ supportedEfforts: ['high', 'new-effort', 'low', 'none'], mandatory: true }))).toEqual(['high', 'low'])
    expect(reasoningEffortChoices(info({ supportedEfforts: ['none'], defaultEffort: 'none' }))).toEqual(['none'])
  })
})
