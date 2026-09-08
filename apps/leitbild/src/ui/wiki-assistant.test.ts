import { describe, expect, test } from 'bun:test'
import { wikiAssistantPrompt } from './wiki-assistant.ts'

describe('Wiki Assistant context', () => {
  test('includes only the visible source reference and exact publication, not document contents', () => {
    const page = { path: 'world/packs/process-plant/reference-designs/ld-01/index.md', title: 'LD-01', revision: 'published-revision' }
    expect(wikiAssistantPrompt('Which cooling paths are specified?', page)).toBe(
      'Which cooling paths are specified?\n\nWiki page I am viewing: LD-01\nSource: knowledge/world/packs/process-plant/reference-designs/ld-01/index.md\nKnowledge revision: published-revision',
    )
  })
  test('does not invent a source when the page has not loaded', () => {
    expect(wikiAssistantPrompt('Help me find the wiki', null)).toBe('Help me find the wiki')
  })
})
