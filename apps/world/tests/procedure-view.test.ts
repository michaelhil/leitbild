import { expect, test } from 'bun:test'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { procedureBlockLabel, procedureObservationBasis, procedureObservationEvidence, procedureObservationLabel, procedureSourceEvidenceRequest, procedureStepItems, procedureTextSegments } from '../src/ui/procedures/procedure-view.ts'
import { procedureTestSource } from './procedure-fixtures.ts'

test('technical basis links keep the selected knowledge revision and executable URLs stay inert', () => {
  const source = '/wiki?path=world%2Fprocedures%2FE-0.md&revision=abc123'
  const segments = procedureTextSegments('[Basis](../engineering/levels.md#sg) [Unsafe](javascript:alert) ` [Example](https://example.test)`', [], source)
  expect(segments.filter(item => item.kind === 'link')).toEqual([{ kind: 'link', text: 'Basis', href: '/wiki?path=world%2Fengineering%2Flevels.md&revision=abc123#sg' }])
  expect(procedureBlockLabel('rno')).toBe('Response not obtained')
  expect(procedureBlockLabel('unknown')).toBe('Unknown or unreliable indication')
  expect(procedureBlockLabel('basis')).toBe('Technical basis')
  expect(procedureTextSegments('[Code](source:apps/world/src/packs/process-plant/model.ts#L12)', [], source)).toEqual([
    { kind: 'link', text: 'Code', href: '/api/knowledge/source?path=apps%2Fworld%2Fsrc%2Fpacks%2Fprocess-plant%2Fmodel.ts%23L12' },
  ])
})

test('retained Basis request uses exact procedure publication identity and does not reinterpret external links', () => {
  const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'world/procedures/E-0.md', sourceUrl: `/wiki?path=world%2Fprocedures%2FE-0.md&revision=${procedureTestSource.revision}`,
    rawMarkdown: '---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: E-0\ntitle: Test\n---\n## Step 1 [id: first]\nAction: Read basis.' })
  expect(procedureSourceEvidenceRequest(`/wiki?path=world%2Fbasis%2Flevels.md&revision=${document.source.revision}#steam-generator`, document)).toEqual({
    sourceId: document.source.sourceId, sourceRevision: document.source.revision, sourcePath: 'world/basis/levels.md', section: 'steam-generator', lineCount: 100,
  })
  expect(procedureSourceEvidenceRequest('/wiki?path=world/basis/levels.md&revision=different', document)).toBeUndefined()
  expect(procedureSourceEvidenceRequest('https://example.test/basis.md', document)).toBeUndefined()
  expect(procedureSourceEvidenceRequest(`/wiki?path=world%2Fbasis%2Flevels.md&revision=${document.source.revision}#bad%ZZ`, document)).toBeUndefined()
})

test('authored observation presentation retains measured value, criterion and unknown evidence', () => {
  const result = { basis: { description: 'Model criterion', source: '[Source](../basis.md)' }, evidence: [
    { signal: { label: 'SG level' }, variable: { value: 42, unit: '%' }, comparison: { operator: '>=', value: 35, unit: '%' }, status: 'satisfied' },
    { comparison: { operator: '==', value: true, unit: 'bool' }, status: 'unknown', reason: 'Signal absent' },
  ] }
  expect(procedureObservationBasis(result)).toContain('[Source](../basis.md)')
  expect(procedureObservationEvidence(result)).toEqual([
    { label: 'SG level', value: '42 %', criterion: '>= 35 %', status: 'satisfied' },
    { label: 'Unavailable signal', value: 'unavailable', criterion: '== true bool', status: 'unknown', reason: 'Signal absent' },
  ])
})

test('observation labels use declared evidence qualification, not Pack names or an automatic safety claim', () => {
  expect(procedureObservationLabel({ basis: { qualification: 'authored-comparison' }, status: 'satisfied' })).toBe('Model comparison')
  expect(procedureObservationLabel({ status: 'satisfied' })).toBe('Read-only observation')
  expect(procedureObservationLabel({ basis: null, status: 'unknown' })).toBe('Read-only observation')
})

test('World procedure presentation preserves source reading order, decisions and original branch identity', () => {
  const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'E-0.md', sourceUrl: 'https://example.test/E-0.md', rawMarkdown: `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Source-order fixture
---
## Step 1 [id: first]
Check: Observe «CHECK».
- Not verified → #last
  Because: Read «WHY».
  Against: Consider «CONFLICT».
Action: This was authored after the first branch.
Decision: Choose a path.
1. Inspect «PATH».
2. Ask if uncertain.
Caution: Read before the next branch.
- Verified → #last
## Step 2 [id: last]
Action: End.
` })
  const step = document.steps[0]!
  const items = procedureStepItems(step)
  expect(items.map(item => item.kind === 'branch' ? item.branch.label : item.block.kind)).toEqual([
    'check', 'Not verified', 'action', 'decision', 'caution', 'Verified',
  ])
  expect(items.map(item => item.primary)).toEqual([true, false, true, true, false, false])
  const branches = items.filter(item => item.kind === 'branch')
  expect(branches[0]!.branch).toBe(step.branches[0]!)
  expect(branches[1]!.branch).toBe(step.branches[1]!)
  expect(branches[0]!.branch).toMatchObject({ because: 'Read «WHY».', against: 'Consider «CONFLICT».' })
  const decision = items.find(item => item.kind === 'block' && item.block.kind === 'decision')!
  expect(decision.kind === 'block' && decision.block.paths).toEqual(['Inspect «PATH».', 'Ask if uncertain.'])
})

test('tag links require parsed references and do not activate fenced or inline examples', () => {
  const text = 'Use «RCP», not `«RCP»` or «UNKNOWN». Example: ```\n«RCP»\n```'
  const segments = procedureTextSegments(text, ['RCP'])
  expect(segments.filter(segment => segment.kind === 'tag')).toEqual([{ kind: 'tag', text: 'RCP' }])
  expect(segments.map(segment => segment.kind === 'tag' ? `«${segment.text}»` : segment.text).join('')).toBe(text)
  expect(procedureTextSegments('«RCP»', [])).toEqual([{ kind: 'text', text: '«RCP»' }])
  const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'E-0.md', sourceUrl: 'https://example.test/E-0.md', rawMarkdown: `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Inert example fixture
---
## Step 1 [id: first]
Check: «RCP».
\`\`\`text
Action: «RCP» is an example, not an instrument request.
\`\`\`
` })
  const example = document.steps[0]!.blocks.find(block => block.kind === 'text')!
  expect(example.tagIds).toEqual([])
  expect(procedureTextSegments(example.text, example.tagIds).every(segment => segment.kind === 'text')).toBe(true)
})
