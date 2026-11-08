import { expect, test } from 'bun:test'
import { createKnowledge } from '@leitbild/knowledge'
import { knowledgeResponse } from './knowledge-api.ts'

const knowledge = createKnowledge({ revision: 'a'.repeat(40), documents: [{ path: 'index.md', content: '# Test\n\nCold reactor explanation.' }] })
test('wiki screenshots use only exact published bytes and reject a different revision or filesystem path', async () => {
  const published = createKnowledge({ revision: knowledge.revision, documents: [{ path: 'index.md', content: '# Screen' }], images: [{ path: 'planning/images/screen.png', mediaType: 'image/png', base64: 'aGVsbG8=' }] })
  const image = (path: string, revision: string) => knowledgeResponse(new Request(`http://local/api/knowledge/image?${new URLSearchParams({ path, revision })}`), async () => published)
  const response = await image('planning/images/screen.png', knowledge.revision)
  expect(response.headers.get('Content-Type')).toBe('image/png')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(await response.text()).toBe('hello')
  expect((await image('planning/images/screen.png', 'b'.repeat(40))).status).toBe(404)
  expect((await image('../private.png', knowledge.revision)).status).toBe(404)
})
test('wiki source endpoint shares bounded product source access without requiring a room', async () => {
  const request=(path:string)=>new Request(`http://local/api/knowledge/source?path=${encodeURIComponent(path)}`)
  const response=await knowledgeResponse(request('packages/knowledge/src/index.ts'))
  expect(response.status).toBe(200)
  expect((await response.json()).content).toContain('createKnowledge')
  expect((await knowledgeResponse(request('../package.json'))).status).toBe(404)
  expect((await knowledgeResponse(request('index.ts'))).status).toBe(404)
})
test('human discovery and read share the same revision and content with agent library', async () => {
  const load = async () => knowledge
  const index = await knowledgeResponse(new Request('http://local/api/knowledge/index'), load)
  expect(await index.json()).toEqual({ revision: knowledge.revision, documents: [
    { path: 'index.md', title: 'Test', parent: null, hub: true },
  ] })
  const search = await knowledgeResponse(new Request('http://local/api/knowledge/search?query=reactor'), load)
  expect(await search.json()).toEqual(knowledge.search('reactor'))
  const read = await knowledgeResponse(new Request('http://local/api/knowledge/read?path=index.md'), load)
  expect(await read.json()).toEqual(knowledge.read('index.md'))
  expect((await knowledgeResponse(new Request('http://local/api/knowledge/read?path=../secret.md'), load)).status).toBe(404)
  expect((await knowledgeResponse(new Request('http://local/api/knowledge/search?limit=-1'), load)).status).toBe(400)
})
test('obsolete feedback redirect is not exposed', async () => {
  const response = await knowledgeResponse(new Request('http://local/api/knowledge/feedback'), async () => knowledge)
  expect(response.status).toBe(404)
  expect(response.headers.has('location')).toBe(false)
})

test('article reads reject a publication change after navigation, while scoped search remains discoverable', async () => {
  const updated = createKnowledge({ revision: 'b'.repeat(40), documents: [
    { path: 'world/read.md', content: '# Reading\n\nActual coolant observation.' },
    { path: 'archive/read.md', content: '# Archived reading\n\nOld coolant observation.' },
  ] })
  const read = await knowledgeResponse(new Request(`http://local/api/knowledge/read?path=world/read.md&revision=${knowledge.revision}`), async () => updated)
  expect(read.status).toBe(404)
  expect((await read.json()).error).toContain('Knowledge revision is not available')
  const scoped = await knowledgeResponse(new Request('http://local/api/knowledge/search?query=coolant&prefix=archive/'), async () => updated)
  expect(await scoped.json()).toMatchObject({ revision: updated.revision, total: 1, matches: [{ path: 'archive/read.md' }] })
})

test('procedure article supplies only its discovered target metadata for exact cross-step rendering', async () => {
  const procedure = (id: string, destination: string) => `---
type: procedure
procedure-md: 0.7
procedure-id: ${id}
title: ${id}
---
# ${id}

## Step 1 [id: check] Verify
Action: Check.
- Continue → ${destination}
`
  const library = createKnowledge({ revision: knowledge.revision, documents: [
    { path: 'procedures/one.md', content: procedure('ONE', '[[TWO#check]]') },
    { path: 'procedures/two.md', content: procedure('TWO', 'END') },
    { path: 'procedures/unrelated.md', content: procedure('OTHER', 'END') },
  ] })
  const response = await knowledgeResponse(new Request(`http://local/api/knowledge/read?path=procedures/one.md&revision=${library.revision}`), async () => library)
  expect(await response.json()).toEqual({
    ...library.read('procedures/one.md'),
    procedures: [{ path: 'procedures/two.md', procedureId: 'TWO', steps: [{ id: 'check', anchor: 'step-1-id-check-verify' }] }],
  })
})
