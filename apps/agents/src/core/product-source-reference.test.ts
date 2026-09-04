import { describe, expect, test } from 'bun:test'
import { findProductSourceReferences, parseProductSourceReference } from './product-source-reference.ts'

describe('product source references', () => {
  test('recognises allowlisted source paths and line ranges', () => {
    expect(parseProductSourceReference('docs/adr/0015-example.md:3')).toEqual({
      path: 'docs/adr/0015-example.md', lineRanges: [{ startLine: 3, endLine: 3 }],
    })
    expect(parseProductSourceReference('apps/world/src/model.ts:5-18')).toEqual({
      path: 'apps/world/src/model.ts', lineRanges: [{ startLine: 5, endLine: 18 }],
    })
    expect(parseProductSourceReference('apps/world/src/packs/process-plant/runtime/physics.ts:10')).toEqual({
      path: 'apps/world/src/packs/process-plant/runtime/physics.ts',
      lineRanges: [{ startLine: 10, endLine: 10 }],
    })
  })

  test('recognises and normalises non-contiguous line ranges', () => {
    expect(parseProductSourceReference('apps/world/src/packs/process-plant/graph/reactor-component-definitions.ts:66-90,115-134')).toEqual({
      path: 'apps/world/src/packs/process-plant/graph/reactor-component-definitions.ts',
      lineRanges: [
        { startLine: 66, endLine: 90 },
        { startLine: 115, endLine: 134 },
      ],
    })
    expect(parseProductSourceReference('apps/world/src/model.ts:9-12, 3-8,12-14')).toEqual({
      path: 'apps/world/src/model.ts', lineRanges: [{ startLine: 3, endLine: 14 }],
    })
    expect(parseProductSourceReference('docs/architecture.md:4–8, 12—13')).toEqual({
      path: 'docs/architecture.md',
      lineRanges: [{ startLine: 4, endLine: 8 }, { startLine: 12, endLine: 13 }],
    })
    expect(parseProductSourceReference('halden-dispatch.scenario.json:20-25')).toEqual({
      path: 'halden-dispatch.scenario.json',
      lineRanges: [{ startLine: 20, endLine: 25 }],
    })
  })

  test('finds safe source references in prose without matching URL substrings', () => {
    const text = 'See apps/world/src/model.ts:5-18,25 and https://example.com/docs/guide.md.'
    expect(findProductSourceReferences(text)).toEqual([{
      path: 'apps/world/src/model.ts',
      lineRanges: [{ startLine: 5, endLine: 18 }, { startLine: 25, endLine: 25 }],
      startIndex: 4,
      endIndex: 35,
    }])
  })

  test('does not mistake ordinary code, URLs, or excluded paths for sources', () => {
    expect(parseProductSourceReference('world.simulation-run.context')).toBeNull()
    expect(parseProductSourceReference('https://example.com/doc.md')).toBeNull()
    expect(parseProductSourceReference('apps/leitbild/deploy/env.json')).toBeNull()
    expect(parseProductSourceReference('../README.md')).toBeNull()
    expect(parseProductSourceReference('docs/../../README.md')).toBeNull()
    expect(parseProductSourceReference('docs//example.md')).toBeNull()
    expect(parseProductSourceReference('apps/world/src/model.ts:18-5')).toBeNull()
    expect(parseProductSourceReference('package.json')).toBeNull()
    expect(parseProductSourceReference('package.json:10')).toEqual({
      path: 'package.json', lineRanges: [{ startLine: 10, endLine: 10 }],
    })
  })
})
