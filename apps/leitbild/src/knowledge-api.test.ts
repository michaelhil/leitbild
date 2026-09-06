import { expect, test } from 'bun:test'
import { createKnowledge } from '@leitbild/knowledge'
import { knowledgeResponse } from './knowledge-api.ts'

const knowledge = createKnowledge({ revision: 'a'.repeat(40), documents: [{ path: 'index.md', content: '# Test\n\nCold reactor explanation.' }] })
test('human discovery and read share the same revision and content with agent library', async () => {
  const load = async () => knowledge
  const index = await knowledgeResponse(new Request('http://local/api/knowledge/index'), load)
  expect((await index.json()).documents[0].title).toBe('Test')
  const search = await knowledgeResponse(new Request('http://local/api/knowledge/search?query=reactor'), load)
  expect(await search.json()).toEqual(knowledge.search('reactor'))
  const read = await knowledgeResponse(new Request('http://local/api/knowledge/read?path=index.md'), load)
  expect(await read.json()).toEqual(knowledge.read('index.md'))
  expect((await knowledgeResponse(new Request('http://local/api/knowledge/read?path=../secret.md'), load)).status).toBe(404)
  expect((await knowledgeResponse(new Request('http://local/api/knowledge/search?limit=-1'), load)).status).toBe(400)
})
test('feedback uses the product destination and retains old publication identity without fetching it', async () => {
  const request = new Request('http://local/api/knowledge/feedback?' + new URLSearchParams({ path: 'packs/example/procedures/E-0.md', revision: 'b'.repeat(40), section: 'verify', quote: 'Observed mismatch' }))
  const response = await knowledgeResponse(request, async () => { throw new Error('Must not fetch a document to report it') }, async () => 'https://github.com/example/product/blob/abc/')
  expect(response.status).toBe(302)
  const target = new URL(response.headers.get('location')!)
  expect(target.origin + target.pathname).toBe('https://github.com/example/product/issues/new')
  expect(target.searchParams.get('body')).toContain('b'.repeat(40))
  expect(target.searchParams.get('body')).toContain('Observed mismatch')
  expect((await knowledgeResponse(request, async () => knowledge, async () => undefined)).status).toBe(503)
  expect((await knowledgeResponse(new Request('http://local/api/knowledge/feedback?path=../../secret.md&revision=' + 'a'.repeat(40)))).status).toBe(400)
})
