import { expect, test } from 'bun:test'
import { createFeedbackSubmitter } from './bugs.ts'
const request = (
  body: unknown = {
    title: 'Wiki feedback',
    description: 'Document: index.md\nFeedback: Test',
  },
) =>
  new Request('http://local/api/system/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
test('submission acknowledges only a created issue with a valid receipt', async () => {
  let sent: Record<string, unknown> | undefined
  const handler = createFeedbackSubmitter({
    token: 'test-only',
    repo: 'example/product',
    fetchImpl: async (url, init) => {
      expect(url).toBe('https://api.github.com/repos/example/product/issues')
      sent = JSON.parse(String(init.body))
      return Response.json(
        {
          id: 101,
          number: 7,
          html_url: 'https://github.com/example/product/issues/7',
        },
        { status: 201 },
      )
    },
  })
  const response = await handler(request(), crypto.randomUUID())
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    ok: true,
    number: 7,
    htmlUrl: 'https://github.com/example/product/issues/7',
  })
  expect(sent?.body).toContain('Document: index.md')
})
test('HTTP success without issue evidence is never acknowledged as submission', async () => {
  for (const [status, body] of [
    [201, {}],
    [201, { id: 1, number: 2, html_url: 'https://other.invalid/issues/2' }],
    [200, { id: 1, number: 2 }],
  ] as const) {
    const handler = createFeedbackSubmitter({
      token: 'test-only',
      repo: 'example/product',
      fetchImpl: async () => Response.json(body, { status }),
    })
    const response = await handler(request(), crypto.randomUUID())
    expect(response.status).toBe(502)
    expect(await response.json()).not.toHaveProperty('ok')
  }
})
test('configuration, upstream failures and oversized input fail without false receipts', async () => {
  let calls = 0
  const unavailable = createFeedbackSubmitter({
    token: '',
    repo: 'example/product',
    fetchImpl: async () => {
      ++calls
      throw new Error('Must not call')
    },
  })
  expect((await unavailable(request(), crypto.randomUUID())).status).toBe(503)
  const handler = createFeedbackSubmitter({
    token: 'test-only',
    repo: 'example/product',
    fetchImpl: async () => {
      ++calls
      throw new Error('Network lost')
    },
  })
  expect(
    (
      await handler(
        request({ title: 'x', description: 'x'.repeat(70_000) }),
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(413)
  expect(calls).toBe(0)
  expect((await handler(request(), crypto.randomUUID())).status).toBe(502)
  expect(calls).toBe(1)
})
