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
})
