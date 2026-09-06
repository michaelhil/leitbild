import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseProcedure, PARSER_PROCMD_VERSION } from './index.ts'
import baseline from '../fixtures/pwr-ops-baseline.json'

const fixture = (name: string) => readFileSync(`${import.meta.dir}/../fixtures/${name}`, 'utf8')
const source = fixture('conformance.md')
const parsed = parseProcedure(source)
const step = parsed.steps[0]!

describe('frozen pwr-ops corpus: immutable IDs and persisted branch-index meanings', () => {
  test('contains all 39 source documents at the recorded revision', () => expect(baseline).toHaveLength(39))
  for (const before of baseline) test(before.file, () => {
    const result = parseProcedure(fixture(`pwr-ops/${before.file}`))
    expect(result.procedureId).toBe(before.procedureId)
    expect(result.steps.map(item => ({ id: item.id, branches: item.branches.map(branch => ({
      label: branch.label, target: branch.target, targetKind: String(branch.targetKind),
    })) }))).toEqual(before.steps)
    expect(result.tags.map(tag => ({ id: tag.id, simPath: tag.simPath, units: tag.units, equipment: tag.equipment })))
      .toEqual(before.tags.map(tag => ({ id: tag.id, simPath: tag.simPath, units: tag.units, equipment: tag.equipment })))
  })
})

describe('one supported procmd format', () => {
  test('requires explicit format identity, stable unique IDs, and steps', () => {
    expect(PARSER_PROCMD_VERSION).toBe('0.7')
    for (const invalid of [source.replace('type: procedure', 'type: scenario'), source.replace('procedure-md: 0.7', 'procedure-md: 0.5'),
      source.replace('procedure-md: 0.7', ''), source.replace('[id: choose]', ''), source.replace('[id: finish]', '[id: choose]'),
      'plain text', '---\ntype: procedure', source.replace('procedure-id: TEST-1', 'procedure-id:'),
      source.slice(0, source.indexOf('## Step'))]) expect(() => parseProcedure(invalid)).toThrow()
  })
  test('preserves exact source, raw source line ranges, quoted fields and CRLF', () => {
    const crlf = source.replaceAll('\n', '\r\n')
    const result = parseProcedure(crlf)
    expect(result.rawMarkdown).toBe(crlf)
    expect(result.title).toBe('Decision and source order')
    expect(result.referencePlant).toBe('reference-only')
    expect(result.annotations).toEqual({ 'custom-key': 'author-note' })
    expect(source.split('\n')[step.sourceLine - 1]).toBe('## Step 1 [id: choose]')
    expect(step.sourceEndLine).toBe(parsed.steps[1]!.sourceLine - 1)
    expect(result.csfsMonitored).toEqual(['subcriticality', 'core-cooling'])
    expect(result.entryTriggers).toEqual(['reactor-trip'])
  })
  test('keeps Decision paths, branch order, adjacent rationale and complete tag union', () => {
    expect(step.blocks.find(block => block.kind === 'decision')?.paths).toEqual(['First path «PATH»', 'Second path'])
    expect(step.branches.map(branch => branch.targetKind)).toEqual(['step', 'procedure', 'unknown', 'unknown'])
    expect(step.branches[0]!.because).toBe('evidence «BECAUSE»')
    expect(step.branches[0]!.against).toBe('counter-evidence «AGAINST»')
    expect(step.branches[3]!.because).toBeUndefined()
    expect(step.tagIds).toEqual(['CAUTION', 'DECISION', 'PATH', 'REAL', 'DETACHED', 'BECAUSE', 'AGAINST'])
    expect(parsed.steps[1]!.branches.map(branch => branch.targetKind)).toEqual(['end', 'retry', 'abort'])
  })
  test('fences, inline code and wiki links do not create steps, branches or live tags', () => {
    expect(parsed.steps).toHaveLength(2)
    const fence = step.blocks.find(block => block.text.startsWith('```'))!
    expect(fence.tagIds).toEqual([])
    expect(fence.text).toContain('Action: fenced «FAKE»')
    expect(step.tagIds).not.toContain('FAKE')
    expect(step.tagIds).not.toContain('CODE')
    expect(step.tagIds).not.toContain('WIKI')
    expect(parseProcedure(source.replaceAll('```', '~~~~')).steps).toHaveLength(2)
  })
  test('unknown prose and unsupported semantics remain visible, not execution promises', () => {
    expect(step.blocks.some(block => block.text === 'Unclassified prose stays visible.')).toBe(true)
    expect(step.blocks.some(block => block.text === 'Future: unsupported annotation')).toBe(true)
    expect(parsed.description).toContain('Preserve this explanation after Tags.')
    expect(parsed.diagnostics.join('\n')).toContain('unsupported annotation/transition')
    expect(parsed.diagnostics.join('\n')).toContain('timing/condition/concurrency semantics are not executed')
    expect(parsed.diagnostics.join('\n')).toContain('unattached rationale')
  })
  test('Tags ends at the next section, keeps annotations, and validates range/duplicates', () => {
    expect(parsed.tags).toHaveLength(7)
    expect(parsed.tags[0]).toMatchObject({ id: 'CAUTION', simPath: 'example.caution', units: 'bar', range: [0, 100], annotations: { 'custom-tag': 'note' } })
    expect(() => parseProcedure(source.replace('[0, 100]', '[zero, 100]'))).toThrow('invalid range')
    expect(() => parseProcedure(source.replace('- id: REAL', '- id: CAUTION'))).toThrow('duplicate tag')
  })
  test('missing targets and unimplemented nested/lifecycle constructs are diagnosed', () => {
    expect(parseProcedure(source.replace('→ #finish', '→ #missing')).diagnostics.join('\n')).toContain('unresolved step target')
    expect(parseProcedure(source.replace('## Step 2 [id: finish]', '### Step 2 [id: finish, loop]')).diagnostics.join('\n')).toContain('nested step')
  })
})
