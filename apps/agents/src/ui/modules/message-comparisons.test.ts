import { describe, expect, test } from 'bun:test'
import { pinnedComparisonModels } from './message-comparisons.ts'
import type { ModelCatalogResponse } from './model-select.ts'

describe('comparison model selection', () => {
  test('uses only pinned models with explicit providers, even for identical model IDs', () => {
    const catalog: ModelCatalogResponse = {
      defaultModel: 'baseline',
      providers: ['openai', 'openrouter'].map(name => ({
        name,
        availability: { sub: 'ok', reason: '', retryAt: null },
        models: [
          { id: 'same-model', contextMax: 100000, recommended: true, pinned: true },
          { id: 'recommended-not-pinned', contextMax: 100000, recommended: true },
        ],
      })),
    }
    expect(pinnedComparisonModels(catalog).map(model => model.value)).toEqual(['openai:same-model', 'openrouter:same-model'])
  })

  test('retains unavailable pinned models and their reason rather than silently substituting', () => {
    const result = pinnedComparisonModels({ defaultModel: '', providers: [{
      name: 'provider',
      availability: { sub: 'no_key', reason: 'API key missing', retryAt: null },
      models: [{ id: 'model', contextMax: 100000, recommended: false, pinned: true }],
    }] })
    expect(result).toEqual([{ value: 'provider:model', label: 'model · provider', available: false, reason: 'API key missing' }])
    expect(pinnedComparisonModels({ defaultModel: 'unpinned', providers: [] })).toEqual([])
  })

  test('disables unknown context capacity without hiding pins or imposing reasoning restrictions', () => {
    const models = pinnedComparisonModels({ defaultModel: '', providers: [{
      name: 'provider',
      availability: { sub: 'ok', reason: '', retryAt: null },
      models: [0, -1, NaN, 100000].map((contextMax, index) => ({ id: `model-${index}`, contextMax, recommended: false, pinned: true })),
    }] })
    expect(models).toHaveLength(4)
    expect(models.map(model => model.available)).toEqual([false, false, false, true])
    expect(models.slice(0, 3).every(model => model.reason.includes('Context capacity is unknown'))).toBe(true)
    expect(models[3]!.value).toBe('provider:model-3')
  })
})
