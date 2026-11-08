import { expect, test } from 'bun:test'
import { assessmentLeaves } from './assessment.ts'
import { parseProcedure } from './parser.ts'

const tags = `## Tags

- id: A
  units: percent
- id: B
  units: boolean
- id: C
  units: boolean
- id: NOUNIT
  description: x`
const doc = (steps: string, preamble = '') => `---
type: procedure
procedure-md: 0.7
procedure-id: T
title: T
---

${preamble}

${steps}

${tags}`
const step = (body: string) => doc(`## Step 1 [id: s] S

Basis: [why](basis.md#limit), [more](other.md#x).
${body}`)

test('a limit at the end of a line compiles into the comparison leaf of its pair\'s normal branch', () => {
  const parsed = parseProcedure(step(`Pair: [id: a, criterion: 0]
Check: Level — BELOW 5%. «A < 5»
Check: Valves — OPEN. «B == false» «C == false»
RNO: Act.

- Met [outcome: normal] → END
- Not met [outcome: rno] → ↻`))
  const [one, two] = parsed.steps[0]!.blocks.filter(block => block.kind === 'check')
  expect(one!.text).toBe('Level — BELOW 5%. «A»')
  expect(one!.tagIds).toEqual(['A'])
  expect(one!.limits).toEqual({ any: false, comparisons: [{ type: 'comparison', tagId: 'A', operator: '<', value: 5, unit: 'percent', bound: 'value', evidence: 'engineering-diagnostic', source: 'basis.md#limit', maxAgeSeconds: 2 }] })
  expect(two!.text).toBe('Valves — OPEN. «B» «C»')
  expect(parsed.steps[0]!.decisions).toEqual([{ branchIndex: 0, condition: { type: 'all', conditions: [...one!.limits!.comparisons, ...two!.limits!.comparisons] } }])
  expect(parsed.steps[0]!.tagIds).toEqual(['A', 'B', 'C'])
  expect(parsed.steps[0]!.pairs).toMatchObject([{ id: 'a', advisoryBranchIndex: 0 }])
  expect(parsed.diagnostics).toEqual([])
})

test('any means at least one, a band repeats a tag, and two pairs may test one normal branch', () => {
  const parsed = parseProcedure(step(`Pair: [id: a, criterion: 0]
Check: Buses — AT LEAST ONE ENERGIZED. «any» «B == true» «C == true»
RNO: Act.

Pair: [id: b, criterion: 0]
Expected: Level — 40% TO 70%. «A > 40» «A < 70»
RNO: Act.

- Met [outcome: normal] → END`))
  const [first, second] = parsed.steps[0]!.blocks.filter(block => block.limits)
  expect(first!.limits!.any).toBe(true)
  expect(first!.text).toBe('Buses — AT LEAST ONE ENERGIZED. «B» «C»')
  expect(second!.text).toBe('Level — 40% TO 70%. «A»')
  const condition = parsed.steps[0]!.decisions![0]!.condition!
  expect(condition).toMatchObject({ type: 'all', conditions: [{ type: 'any', conditions: [{ tagId: 'B' }, { tagId: 'C' }] }, { tagId: 'A', operator: '>' }, { tagId: 'A', operator: '<' }] })
})

test('a fork tests a branch from the branch line, naming no line and lighting nothing', () => {
  const parsed = parseProcedure(step(`Pair: [id: fork]
Check: Is B actuated? «B» «A»

- Actuated «B == true» [outcome: normal] → #s
- Not required «B == false» «A < 5» [outcome: normal] → END`))
  const [actuated, required] = parsed.steps[0]!.branches
  expect(actuated!.label).toBe('Actuated')
  expect(actuated!.limits!.comparisons.map(item => item.tagId)).toEqual(['B'])
  expect(required!.label).toBe('Not required')
  expect(required!.tagIds).toEqual(['B', 'A'])
  expect(parsed.steps[0]!.decisions!.map(decision => decision.branchIndex)).toEqual([0, 1])
  expect(assessmentLeaves(parsed.steps[0]!.decisions![1]!.condition!).map(leaf => leaf.type)).toEqual(['comparison', 'comparison'])
  expect(parsed.steps[0]!.pairs![0]!.advisoryBranchIndex).toBeUndefined()
})

test('a When line carries limits into its branch without a diagnostic; without limits it stays advisory', () => {
  const withLimit = parseProcedure(step(`Pair: [id: a, criterion: 0]
When: Level — BELOW 75%. «A < 75»

- Go on [outcome: normal] → END`))
  expect(withLimit.steps[0]!.blocks.find(block => block.kind === 'when')!.limits!.comparisons[0]!.value).toBe(75)
  expect(withLimit.steps[0]!.decisions).toHaveLength(1)
  expect(withLimit.diagnostics).toEqual([])
  const plain = parseProcedure(step(`Pair: [id: a]
Check: Level.
When: Level falls.

- Go on [outcome: normal] → END`))
  expect(plain.diagnostics.join(' ')).toContain('source guidance only')
})

const refusals: ReadonlyArray<readonly [string, string, string]> = [
  ['mid-line', 'Pair: [id: a, criterion: 0]\nCheck: Level «A < 5» is low.\n\n- Met [outcome: normal] → END', 'limits must end the line'],
  ['followed by words', 'Pair: [id: a, criterion: 0]\nCheck: Level «A < 5».\n\n- Met [outcome: normal] → END', 'limits must end the line'],
  ['malformed value', 'Pair: [id: a, criterion: 0]\nCheck: Level. «A < low»\n\n- Met [outcome: normal] → END', 'malformed limit'],
  ['unsupported operator', 'Pair: [id: a, criterion: 0]\nCheck: Level. «A => 5»\n\n- Met [outcome: normal] → END', 'malformed limit'],
  ['ordered boolean', 'Pair: [id: a, criterion: 0]\nCheck: B. «B < true»\n\n- Met [outcome: normal] → END', 'boolean assessment comparison'],
  ['any alone', 'Pair: [id: a, criterion: 0]\nCheck: B. «any» «B == true»\n\n- Met [outcome: normal] → END', '«any» needs at least two'],
  ['undeclared tag', 'Pair: [id: a, criterion: 0]\nCheck: Z. «Z < 5»\n\n- Met [outcome: normal] → END', 'limit tag Z is not declared with units'],
  ['tag with no units', 'Pair: [id: a, criterion: 0]\nCheck: N. «NOUNIT < 5»\n\n- Met [outcome: normal] → END', 'limit tag NOUNIT is not declared with units'],
  ['on an RNO line', 'Pair: [id: a]\nCheck: Level.\nRNO: Act. «A < 5»\n\n- Met [outcome: normal] → END', 'a limit belongs on'],
  ['pair names no branch', 'Pair: [id: a]\nCheck: Level. «A < 5»\n\n- Met [outcome: normal] → END', 'needs its Pair to name the branch'],
  ['no pair', 'Check: Level. «A < 5»\n\n- Met [outcome: normal] → END', 'needs its Pair to name the branch'],
  ['criterion on an RNO', 'Pair: [id: a, criterion: 0]\nCheck: Level. «A < 5»\n\n- Not met [outcome: rno] → END', 'deterministic normal branch'],
  ['pair criterion on a row with no limit', 'Pair: [id: a, criterion: 0]\nCheck: Level. «A < 5»\nPair: [id: b, criterion: 0]\nCheck: Judge it.\n\n- Met [outcome: normal] → END', 'its own lines carry limits'],
  ['limits on a branch a pair names', 'Pair: [id: a, criterion: 0]\nCheck: Level. «A < 5»\n\n- Met «B == true» [outcome: normal] → END', 'a branch a Pair names'],
  ['beside a decision block', 'Pair: [id: a, criterion: 0]\nCheck: Level. «A < 5»\n\n```procedure-decisions\n[{"branchIndex":0,"condition":{"type":"manual","description":"d","tagIds":[],"source":"s.md#x"}}]\n```\n\n- Met [outcome: normal] → END', 'cannot both decide'],
]
for (const [name, body, message] of refusals) test(`refused: ${name}`, () => { expect(() => parseProcedure(step(body))).toThrow(message) })

test('a limit needs a Basis link to a section on its own step', () => {
  const body = 'Pair: [id: a, criterion: 0]\nCheck: Level. «A < 5»\n\n- Met [outcome: normal] → END'
  expect(() => parseProcedure(doc(`## Step 1 [id: s] S\n\n${body}`))).toThrow('a limit needs a Basis link')
  expect(() => parseProcedure(doc(`## Step 1 [id: s] S\n\nBasis: [why](basis.md).\n${body}`))).toThrow('a limit needs a Basis link')
})

test('the foldout is parsed out of the preamble with its tags, once, and carries no limits', () => {
  const body = 'Pair: [id: a]\nCheck: Level.\n\n- Met [outcome: normal] → END'
  const parsed = parseProcedure(doc(`## Step 1 [id: s] S\n\n${body}`, `# T\n\nIntro.\n\n### Foldout: applies from Step 5\n\n- **Level.** IF level «A» is low, THEN act.\n- Keep «B» on.\n\n### Other\n\nAfter.`))
  expect(parsed.foldout).toEqual({ title: 'Foldout: applies from Step 5', text: '- **Level.** IF level «A» is low, THEN act.\n- Keep «B» on.', tagIds: ['A', 'B'], sourceLine: 12 })
  expect(parsed.description).toContain('Intro.')
  expect(parsed.description).toContain('After.')
  expect(parsed.description).not.toContain('Keep')
  expect(parsed.diagnostics).toEqual([])
  expect(parseProcedure(doc(`## Step 1 [id: s] S\n\n${body}`, '# T')).foldout).toBeUndefined()
  expect(() => parseProcedure(doc(`## Step 1 [id: s] S\n\n${body}`, '### Foldout\n\nKeep. «A < 5»'))).toThrow('a foldout has no limits')
  expect(() => parseProcedure(doc(`## Step 1 [id: s] S\n\n${body}`, '### Foldout\n\nx\n\n### Foldout again\n\ny'))).toThrow('one foldout')
})
