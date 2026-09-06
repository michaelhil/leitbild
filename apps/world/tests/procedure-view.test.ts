import { expect, test } from 'bun:test'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { procedureStepItems, procedureTextSegments } from '../src/ui/procedures/procedure-view.ts'
import { procedureTestSource } from './procedure-fixtures.ts'

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
