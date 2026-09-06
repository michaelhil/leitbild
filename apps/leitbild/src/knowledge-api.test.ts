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
