import { describe, expect, test } from 'bun:test'
import { parseProductSourceReference } from './product-source-reference.ts'

describe('product source references', () => {
  test('recognises allowlisted source paths and line ranges', () => {
    expect(parseProductSourceReference('docs/adr/0015-example.md:3')).toEqual({
      path: 'docs/adr/0015-example.md', startLine: 3, endLine: 3,
    })
    expect(parseProductSourceReference('apps/world/src/model.ts:5-18')).toEqual({
      path: 'apps/world/src/model.ts', startLine: 5, endLine: 18,
    })
  })

  test('does not mistake ordinary code, URLs, or excluded paths for sources', () => {
    expect(parseProductSourceReference('world.simulation-run.context')).toBeNull()
    expect(parseProductSourceReference('https://example.com/doc.md')).toBeNull()
    expect(parseProductSourceReference('apps/agents/deploy/Caddyfile')).toBeNull()
    expect(parseProductSourceReference('../README.md')).toBeNull()
  })
})
