import { expect, test } from 'bun:test'
import { estimateRequestSize } from './request-size.ts'

test('reports unmeasured image payloads without charging base64 as text tokens', () => {
  const estimate = estimateRequestSize({ model: 'test', messages: [{ role: 'user', content: 'look', images: [{ mimeType: 'image/png', dataUrl: `data:image/png;base64,${'a'.repeat(1_000_000)}` }] }] })
  expect(estimate.estimatedInputTokens).toBe(5)
  expect(estimate.images).toBe(1)
  expect(estimate.requestedOutputTokens).toBeUndefined()
})

test('an absent continuation has no estimated payload', () => {
  expect(estimateRequestSize({ model: 'test', messages: [{ role: 'assistant', content: '', continuation: undefined }] }).continuationBytes).toBe(0)
})
