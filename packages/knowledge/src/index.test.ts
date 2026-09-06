import { describe, expect, test } from 'bun:test'
import { createKnowledge, headingsFor } from './index.ts'

const revision = 'a'.repeat(40)
const fixture = () => createKnowledge({ revision, documents: [
  { path: 'index.md', content: '# Leitbild\n\nReference knowledge.\n## Behavior\nLive state is separate.\n### Detail\nActual observations.\n## Behavior\nSecond section.' },
  { path: 'packs/example.md', content: '# Cooling\n\nA recirculation loop moves coolant.' },
  { path: 'quality/evaluation.md', content: '# Cooling answers\n\nPrivate-like test examples are not default reference.' },
] })

describe('published knowledge', () => {
  test('headings ignore fenced code and have stable duplicate anchors', () => {
    expect(headingsFor('# A\n```md\n# Not a heading\n```\n# A').map(h => h.anchor)).toEqual(['a', 'a-1'])
  })
  test('frontmatter, setext and nested fences share Markdown rendering semantics', () => {
    expect(headingsFor('---\nid: E-0\n---\n# Procedure\n\nStep\n----\n').map(h => [h.title, h.line])).toEqual([['Procedure', 4], ['Step', 6]])
    expect(headingsFor('````md\n```\n# Still code\n````\n# Real\n').map(h => h.title)).toEqual(['Real'])
  })
  test('full reads preserve source bytes, including CRLF', () => {
    const content = '# Original\r\n\r\nText\r\n'
    expect(createKnowledge({ revision, documents: [{ path: 'index.md', content }] }).read('index.md').content).toBe(content)
  })
  test('a heading repeated in a prior code example does not steal its line range', () => {
    const content = '# Page\n\n```md\n## Example\nCode-only content\n```\n\n## Example\nReal content\n## End\nEnd'
    const knowledge = createKnowledge({ revision, documents: [{ path: 'index.md', content }] })
    expect(knowledge.read('index.md', { section: 'example' }).content).toBe('## Example\nReal content')
    expect(knowledge.read('index.md', { section: 'example' }).startLine).toBe(8)
  })
  test('reads exact section including subsections and explicit continuation', () => {
    const result = fixture().read('index.md', { section: 'behavior' })
    expect(result.content).toBe('## Behavior\nLive state is separate.\n### Detail\nActual observations.')
    expect(result.nextLine).toBeUndefined()
    expect(result.sectionComplete).toBe(true)
    expect(result.revision).toBe(revision)
  })
  test('continuation advances within a long section and ends exactly at its boundary', () => {
    const content = ['# Page', '## Long', ...Array.from({ length: 100 }, (_, index) => `Line ${index}`), '## Next', 'Other section'].join('\n')
    const knowledge = createKnowledge({ revision, documents: [{ path: 'index.md', content }] })
    const first = knowledge.read('index.md', { section: 'long', lineCount: 80 })
    const second = knowledge.read('index.md', { section: 'long', startLine: first.nextLine!, lineCount: 80 })
    expect(second.startLine).toBe(82)
    expect(second.endLine).toBe(102)
    expect(second.nextLine).toBeUndefined()
    expect(second.sectionComplete).toBe(true)
    expect(second.content).not.toContain('Other section')
    expect(() => knowledge.read('index.md', { section: 'long', startLine: 103 })).toThrow('outside the selected section')
  })
  test('body search and pagination do not require metadata keywords', () => {
    expect(fixture().search('recirculation').matches[0]?.path).toBe('packs/example.md')
    expect(fixture().search('cooling').total).toBe(1)
    expect(fixture().search('cooling', { includeQuality: true }).total).toBe(2)
    expect(fixture().search('', { limit: 1 }).nextOffset).toBe(1)
  })
  test('unavailable revisions, paths and sections fail honestly', () => {
    expect(() => fixture().read('index.md', { revision: 'b'.repeat(40) })).toThrow('revision')
    expect(() => fixture().read('../secret.md')).toThrow('not found')
    expect(() => fixture().read('index.md', { section: 'missing' })).toThrow('Unknown section')
    expect(() => fixture().read('index.md', { startLine: 999 })).toThrow('outside')
  })
  test('long-line search previews stay small and exact evidence remains readable', () => {
    const content = '# Plant\n' + 'x'.repeat(5000) + ' subcooling ' + 'y'.repeat(5000)
    const knowledge = createKnowledge({ revision, documents: [{ path: 'index.md', content }] })
    const match = knowledge.search('subcooling').matches[0]!
    expect(match.snippet.length).toBeLessThanOrEqual(1200)
    expect(match.snippet).toContain('subcooling')
    expect(match.snippetTruncated).toBe(true)
    expect(knowledge.read(match.path).content).toBe(content)
  })
  test('unsafe and duplicate paths cannot enter a publication', () => {
    for (const path of ['../secret.md', '/secret.md', 'a/../b.md', '.git/a.md']) {
      expect(() => createKnowledge({ revision, documents: [{ path, content: '' }] })).toThrow()
    }
    expect(() => createKnowledge({ revision, documents: [{ path: 'a.md', content: '' }, { path: 'a.md', content: '' }] })).toThrow('duplicate')
  })
})
