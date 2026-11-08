import { expect, test } from 'bun:test'
import { parseProcedure } from './parser.ts'
import { checkProcedureLimits, procedureLimitTable, validateProcedurePublication } from './publication.ts'

const family = (name: string, units: string) => ['A', 'B', 'C', 'D'].map(letter => `- id: SG-${letter}-${name}\n  description: SG ${letter} ${name}\n  units: ${units}`).join('\n')
const tags = `## Tags

- id: POWER
  description: power range
  units: percent
- id: RATE
  description: startup rate
  units: DPM
- id: OTHER-PCT
  description: another percent reading
  units: percent
- id: FLOW
  description: total flow
  units: kg/s
- id: BKR-A-POS
  description: breaker A closed
  units: boolean
  states: CLOSED/OPEN
- id: BKR-B-POS
  description: breaker B closed
  units: boolean
  states: CLOSED/OPEN
- id: STOP-POS
  description: stop valve position
  units: fraction
  states: OPEN/CLOSED
- id: NO-WORDS
  description: a switch
  units: boolean
${family('LVL', 'percent')}
`
const doc = (body: string, front = 'ai-workable: true') => `---
type: procedure
procedure-md: 0.7
procedure-id: T
title: T
${front}
---

## Step 1 [id: s] S

Basis: [why](basis.md#limit).
${body}

${tags}`
const line = (text: string) => doc(`Pair: [id: a, criterion: 0]\nCheck: ${text}\nRNO: Act.\n\n- Met [outcome: normal] → END`)
const problems = (text: string) => checkProcedureLimits(parseProcedure(line(text)))
const all = (limit: string) => ['A', 'B', 'C', 'D'].map(letter => `«SG-${letter}-LVL ${limit}»`).join(' ')

test('correct lines pass', () => {
  for (const text of [
    'Power range — BELOW 5%. «POWER < 5»',
    'Power range — AT MOST 5%. «POWER <= 5»',
    'Total flow — AT LEAST 7000 kg/s. «FLOW >= 7000»',
    'Startup rate — ZERO OR NEGATIVE. «RATE <= 0»',
    'Breakers A and B — OPEN. «BKR-A-POS == false» «BKR-B-POS == false»',
    'Stop valve — CLOSED. «STOP-POS == 0»',
    'Breakers — AT LEAST ONE CLOSED. «any» «BKR-A-POS == true» «BKR-B-POS == true»',
    `SG levels — ALL BELOW 82%. ${all('< 82')}`,
    `SG levels A to D — 40% TO 70%. ${['A', 'B', 'C', 'D'].map(letter => `«SG-${letter}-LVL > 40» «SG-${letter}-LVL < 70»`).join(' ')}`,
    'Total flow AT LEAST 27.8 kg/s, OR ANY level ABOVE 10%. «any» «FLOW >= 27.8» «SG-A-LVL > 10» «SG-B-LVL > 10» «SG-C-LVL > 10» «SG-D-LVL > 10»',
  ]) expect([text, problems(text)]).toEqual([text, []])
})

const mutants: ReadonlyArray<readonly [string, string, string]> = [
  ['reversed comparator', 'Power range — BELOW 5%. «POWER > 5»', 'the words state BELOW 5%'],
  ['wrong tag, different unit', 'Power range — BELOW 5%. «RATE < 5»', 'RATE is in DPM'],
  ['SG D left out of ALL', 'SG levels — ALL BELOW 82%. «SG-A-LVL < 82» «SG-B-LVL < 82» «SG-C-LVL < 82»', 'SG-D-LVL is left out'],
  ['band reversed on one SG', `SG levels — ALL 40% TO 70%. «SG-A-LVL > 40» «SG-A-LVL < 70» «SG-B-LVL > 70» «SG-B-LVL < 40» «SG-C-LVL > 40» «SG-C-LVL < 70» «SG-D-LVL > 40» «SG-D-LVL < 70»`, 'not stated in the words'],
  ['ANY on a line that says ALL', 'Breakers A and B — OPEN. «any» «BKR-A-POS == false» «BKR-B-POS == false»', '«any» on a line'],
  ['number in unrelated words', 'Step 5 power range — BELOW 50%. «POWER < 5»', 'the words state BELOW 50%'],
  ['words say ANY, no any', 'Breakers — AT LEAST ONE CLOSED. «BKR-A-POS == true» «BKR-B-POS == true»', 'has no «any»'],
  ['one SG given a different limit', 'SG levels — ALL BELOW 82%. «SG-A-LVL < 82» «SG-B-LVL < 82» «SG-C-LVL < 82» «SG-D-LVL < 90»', 'different limits'],
  ['wrong letter in the words', 'SG A level — BELOW 82%. «SG-B-LVL < 82»', 'SG-B-LVL is on a line naming A'],
  ['a named letter dropped from the limits', 'Breakers A and B — OPEN. «BKR-A-POS == false»', 'the words name B'],
  ['boolean with the opposite word', 'Breakers A and B — OPEN. «BKR-A-POS == true» «BKR-B-POS == true»', 'means CLOSED'],
  ['boolean with no state words', 'Switch — ON. «NO-WORDS == true»', 'needs states:'],
  ['a limit the words never state', 'Power range is low. «POWER < 5»', 'not stated in the words'],
]
for (const [name, text, message] of mutants) test(`fails: ${name}`, () => { expect(problems(text).join('\n')).toContain(message) })

test('what words cannot show still passes, and is in the table a person reads', () => {
  for (const text of ['Power range — BELOW 5%. «OTHER-PCT < 5»', 'Affected SG level — BELOW 82%. «SG-B-LVL < 82»', 'Power range — BELOW 50%. «POWER < 50»']) expect(problems(text)).toEqual([])
  const table = procedureLimitTable(parseProcedure(line('Power range — BELOW 5%. «OTHER-PCT < 5»')))
  expect(table.split('\n').at(-1)).toBe('| 1 | Power range — BELOW 5%. | OTHER-PCT | another percent reading | < 5 percent | all | Met | basis.md#limit |')
})

test('a marked document states every limit as a limit, except on an IF line', () => {
  const stated = 'Pair: [id: a]\nCheck: Level — BELOW 5%. «POWER»\n\n- Met [outcome: normal] → END'
  expect(checkProcedureLimits(parseProcedure(doc(stated))).join()).toContain('states a limit and carries none')
  expect(checkProcedureLimits(parseProcedure(doc(stated, 'category: x')))).toEqual([])
  expect(checkProcedureLimits(parseProcedure(doc('Pair: [id: a]\nCheck: IF power is ABOVE 5%: breakers OPEN. «POWER»\n\n- Met [outcome: normal] → END')))).toEqual([])
  expect(checkProcedureLimits(parseProcedure(doc('Pair: [id: a]\nCheck: Is any SG uncontrolled? «SG-A-LVL»\n\n- None [outcome: normal] → END')))).toEqual([])
})

test('a marked document has no decision block, and an unmarked one may', () => {
  const fence = 'Pair: [id: a]\nCheck: Level. «POWER»\n\n```procedure-decisions\n[{"branchIndex":0,"condition":{"type":"manual","description":"d","tagIds":[],"source":"basis.md#limit"}}]\n```\n\n- Met [outcome: normal] → END'
  expect(checkProcedureLimits(parseProcedure(doc(fence))).join()).toContain('has no decision block')
  expect(checkProcedureLimits(parseProcedure(doc(fence, 'category: x')))).toEqual([])
})

test('a fork names its tags on a line of the step, and its numbers in the step\'s words', () => {
  const fork = (question: string, label: string) => doc(`Pair: [id: fork]\nCheck: ${question}\n\n- ${label} [outcome: normal] → END`)
  expect(checkProcedureLimits(parseProcedure(fork('Is power below 5%? «POWER»', 'Low «POWER < 5»')))).toEqual([])
  expect(checkProcedureLimits(parseProcedure(fork('Is power low?', 'Low «POWER < 5»'))).join()).toContain('named on no line')
  expect(checkProcedureLimits(parseProcedure(fork('Is power low? «POWER»', 'Low «POWER < 5»'))).join()).toContain('that number is on no line')
  const table = procedureLimitTable(parseProcedure(fork('Is power below 5%? «POWER»', 'Low «POWER < 5»')))
  expect(table.split('\n').at(-1)).toContain('(fork) Low')
})

test('publication refuses a limit problem and an undeclared foldout tag, and leaves documents with neither alone', () => {
  const check = (content: string) => validateProcedurePublication([{ path: 'p/T.md', content }])
  expect(() => check(line('Power range — BELOW 5%. «POWER > 5»'))).toThrow('Procedure limits in p/T.md')
  expect(() => check(line('Power range — BELOW 5%. «POWER < 5»'))).not.toThrow()
  const foldout = (tag: string) => line('Power range — BELOW 5%. «POWER < 5»').replace('## Step 1', `### Foldout\n\nKeep ${tag} on.\n\n## Step 1`)
  expect(() => check(foldout('«POWER»'))).not.toThrow()
  expect(() => check(foldout('«NOPE»'))).toThrow('Undeclared tag NOPE')
})
