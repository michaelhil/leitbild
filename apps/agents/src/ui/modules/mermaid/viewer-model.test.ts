import { describe, expect, test } from 'bun:test'
import { createDiagramVersions, flowDirection, withFlowDirection } from './viewer-model.ts'

describe('diagram versions in a mounted view', () => {
  test('retains the original and later versions when editing an earlier selection', () => {
    const versions = createDiagramVersions('original')
    versions.add('first', 'Source edit')
    versions.add('second', 'Agent change')
    expect(versions.select(0)).toBe(true)
    versions.add('branch', 'Source edit')
    expect(versions.count()).toBe(4)
    expect(versions.current().source).toBe('branch')
    versions.select(2)
    expect(versions.current().source).toBe('second')
    versions.select(0)
    expect(versions.current()).toEqual({ source: 'original', label: 'Original' })
  })

  test('a late Agent result can be retained without replacing a newer selection', () => {
    const versions = createDiagramVersions('original')
    const base = versions.change()
    versions.add('manual', 'Source edit')
    const activates = versions.change() === base
    versions.add('late reply', 'Agent change', activates)
    expect(versions.current().source).toBe('manual')
    expect(versions.count()).toBe(3)
    expect(versions.select(20)).toBe(false)
    expect(versions.current().source).toBe('manual')
  })
})

describe('local flowchart orientation', () => {
  test('changes only the explicit root direction, preserving labels, edges, comments and subgraph direction', () => {
    const source = '%% direction LR is a comment\n\nflowchart TB\n  A["LR entry"] -->|"yes"| B{Ready}\n  subgraph child\n    direction RL\n    B --> C[Done]\n  end'
    expect(flowDirection(source)).toBe('TD')
    expect(withFlowDirection(source, 'LR')).toBe(source.replace('flowchart TB', 'flowchart LR'))
    expect(withFlowDirection('graph TD; A-->B', 'RL')).toBe('graph RL; A-->B')
  })

  test('does not guess how to rewrite other diagram grammars or frontmatter', () => {
    for (const source of ['sequenceDiagram\nA->>B: flowchart LR', '---\ntitle: test\n---\nflowchart TD\nA-->B', 'flowchart\nA-->B', '%% only comment']) {
      expect(flowDirection(source)).toBeUndefined()
      expect(withFlowDirection(source, 'LR')).toBeUndefined()
    }
  })
})
