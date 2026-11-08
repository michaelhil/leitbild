import { expect, test } from 'bun:test'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { procedureChipTarget, procedureUsageHref, procedureTagLabels, procedureJudgementLine, procedureInlineLayout, procedureInlineValue, procedureFoldoutItems, procedureFoldoutBeforeStart, procedurePriorFoldout, procedureDecisionAgainst, procedureTagLabel, procedureLightRows, procedureLightTone, procedureCheckVersion, procedureCategories, procedureBlockLabel, procedureEvidenceStatusWord, procedureStepCounterText, procedureReadingName, procedureReadingText, procedureRequirementText, procedureLineCheckEvidence, procedureLineChecks, procedureObservationBasis, procedureObservationEvidence, procedureObservationLabel, procedureOperatorRows, procedureSampledEvidence, procedureSourceEvidenceRequest, procedureStepItems, procedureStepTagBindings, procedureTextSegments, procedureUnitJump } from '../src/ui/procedures/procedure-view.ts'
import { procedureCriterionReadingSchema } from '../src/core/model/procedure-criteria.ts'
import { procedureTestSource } from './procedure-fixtures.ts'
import { procedureBindingStatusWord, procedureComparisonText, procedureCsfChip, procedureDescriptionText, procedureDisplayReading, procedureElapsedText, procedureStepBindingSummary } from '../src/ui/procedures/procedure-view.ts'

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
    { label: 'SG level', value: '42 %', criterion: 'at least 35 %', status: 'satisfied' },
    { label: 'Unavailable indication', value: 'unavailable', criterion: 'On', status: 'unknown', reason: 'Signal absent' },
  ])
})

test('advisory details show the actual receiving flow and protection indications in a normalized evidence frame', () => {
  const result = {
    readings: [{ signal: { label: 'Safety injection to cold leg A' }, variable: { value: 2.4, unit: 'kg/s' } }],
    evidence: [
      { readingIndex: 0, comparison: { operator: '>', value: 0, unit: 'kg/s' }, status: 'satisfied' },
      { ruleId: 'manual-si', label: 'Manual safety injection', field: 'latched', value: false, expected: false, status: 'satisfied' },
      { readingIndex: 9, reference: { tagId: 'FLOW-B' }, status: 'unknown' },
    ],
  }
  expect(procedureObservationEvidence(result)).toMatchObject([
    { label: 'Safety injection to cold leg A', value: '2.40 kg/s', criterion: 'above 0 kg/s' },
    { label: 'Manual safety injection · latched', value: 'Off', criterion: 'Off' },
    { label: 'FLOW-B', value: 'unavailable', status: 'unknown' },
  ])
})

test('observation labels use declared evidence qualification, not Pack names or an automatic safety claim', () => {
  expect(procedureObservationLabel({ basis: { qualification: 'authored-comparison' }, status: 'satisfied' })).toBe('Model comparison')
  expect(procedureObservationLabel({ status: 'satisfied' })).toBe('Read-only observation')
  expect(procedureObservationLabel({ basis: null, status: 'unknown' })).toBe('Read-only observation')
})

test('sampled response shows both current readings and a separately failed historical comparison', () => {
  const result = {
    current: {
      readings: [{ signal: { label: 'Steam generator A level' }, variable: { value: 30, unit: '%' } }],
      evidence: [{ readingIndex: 0, comparison: { operator: '>', value: 20, unit: '%' }, status: 'satisfied' }],
    },
    recordings: [{
      signal: { label: 'Steam generator A level' }, integratedSpanSeconds: 120, maximumGapMs: 1000,
      first: { simulationTime: '2026-07-12T04:00:00.000Z' }, current: { simulationTime: '2026-07-12T04:02:00.000Z' },
      notBeforeSimulationTime: '2026-07-12T03:59:59.000Z',
    }],
    evidence: [{ recordingIndex: 0, comparison: { signal: { tagId: 'SG-A-LVL-NR' }, statistic: 'minimum', operator: '>', value: 20, unit: '%' }, actual: 18, status: 'challenged' }],
  }
  expect(procedureObservationEvidence(result)).toEqual([{ label: 'Steam generator A level', value: '30 %', criterion: 'above 20 %', status: 'satisfied' }])
  expect(procedureSampledEvidence(result)).toEqual([{
    label: 'Steam generator A level (SG-A-LVL-NR) · minimum', value: '18 %', criterion: 'above 20 %', status: 'challenged',
    span: '120 s recorded', window: 'Samples 04:00:00.000 to 04:02:00.000 · largest gap 1 s · after accepted operation at 03:59:59.000',
  }])
  expect(procedureObservationEvidence({ ...result, recordings: [], evidence: [] })).toHaveLength(1)
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
  expect(procedureOperatorRows(step)).toEqual({ rows: [{ kind: 'sequence', items }], basis: [] })
  expect(items.map(item => item.kind === 'branch' ? item.branch.label : item.blocks[0].kind)).toEqual([
    'check', 'Not verified', 'action', 'decision', 'caution', 'Verified',
  ])
  expect(items.map(item => item.primary)).toEqual([true, false, true, true, true, false])
  const branches = items.filter(item => item.kind === 'branch')
  expect(branches[0]!.branch).toBe(step.branches[0]!)
  expect(branches[1]!.branch).toBe(step.branches[1]!)
  expect(branches[0]!.branch).toMatchObject({ because: 'Read «WHY».', against: 'Consider «CONFLICT».' })
  const decision = items.find(item => item.kind === 'block' && item.blocks[0].kind === 'decision')!
  expect(decision.kind === 'block' && decision.blocks[0].paths).toEqual(['Inspect «PATH».', 'Ask if uncertain.'])
})

test('explicit response pairs preserve alternate route identity and keep technical material out of the action sequence', () => {
  const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'fixture.md', sourceUrl: 'https://example.test/fixture.md', rawMarkdown: [
    '---', 'type: procedure', 'procedure-md: 0.7', 'procedure-id: FIXTURE', 'title: Fixture', '---',
    '## Step 1 [id: first]', 'Pair: [id: first-route, criterion: 2]', 'Check: Read the first indication.',
    'Pair: [id: second-route, criterion: 0]', 'Check: Read the second indication.', 'RNO: Isolate the failed path.',
    'Unknown: Obtain current readings.', 'Basis: Engineering comparison.', '```procedure-decisions',
    JSON.stringify([0, 2].map(branchIndex => ({ branchIndex, condition: {
      type: 'comparison', tagId: 'P', operator: '>', value: branchIndex, unit: 'bar', bound: 'value',
      evidence: 'instrument', source: 'basis.md', maxAgeSeconds: 2,
    } }))), '```',
    '- Second route established [outcome: normal] → END',
    '- Failed path isolated [outcome: rno] → END',
    '- First route established [outcome: normal] → END',
  ].join('\n') })
  const step = document.steps[0]!
  const { rows, basis } = procedureOperatorRows(step)
  const [first, second] = rows
  if (first?.kind !== 'pair' || second?.kind !== 'pair') throw new Error('Expected two aligned response pairs')
  expect([first.advisoryBranchIndex, second.advisoryBranchIndex]).toEqual([2, 0])
  expect(first.expected.at(-1)).toMatchObject({ branch: step.branches[2] })
  expect(second.expected.at(-1)).toMatchObject({ branch: step.branches[0] })
  expect(second.rno.at(-1)).toMatchObject({ branch: step.branches[1] })
  expect(second.other[0]).toMatchObject({ blocks: [{ kind: 'unknown' }] })
  expect(basis[0]).toMatchObject({ blocks: [{ kind: 'basis' }] })
})

test('a note after both routes remains after the two columns without breaking their pairing', () => {
  const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'fixture.md', sourceUrl: 'https://example.test/fixture.md', rawMarkdown: [
    '---', 'type: procedure', 'procedure-md: 0.7', 'procedure-id: FIXTURE', 'title: Fixture', '---',
    '## Step 1 [id: first]', 'Check: Read the indication.',
    '- Response obtained [outcome: normal] → END',
    '- Response not obtained [outcome: rno] → ↻',
    'Note: Continuing monitoring is required.',
  ].join('\n') })
  const step = document.steps[0]!
  const [row, footer] = procedureOperatorRows(step).rows
  if (row?.kind !== 'pair') throw new Error('Expected aligned normal and RNO columns')
  expect(row.expected.at(-1)).toMatchObject({ branch: step.branches[0] })
  expect(row.rno.at(-1)).toMatchObject({ branch: step.branches[1] })
  expect(footer).toMatchObject({ kind: 'sequence', items: [{ blocks: [{ kind: 'note' }] }] })
})

test('a line for two breakers has its own scoped verdict and does not treat missing or stale data as open', () => {
  const declarations = ['A', 'B', 'P'].map(tagId => ({ type: 'comparison', tagId,
    operator: '==', value: false, unit: 'boolean', evidence: 'engineering-diagnostic', source: 'basis.md', maxAgeSeconds: 2,
  }))
  const authored = (type: string) => parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'fixture.md', sourceUrl: 'https://example.test/fixture.md', rawMarkdown: [
    '---', 'type: procedure', 'procedure-md: 0.7', 'procedure-id: FIXTURE', 'title: Fixture', '---',
    '## Step 1 [id: first]', 'Pair: [id: trip, criterion: 0]',
    'Check: Both breakers open. «A» «B»', 'Check: Other indication off. «P»',
    '```procedure-decisions', JSON.stringify([{ branchIndex: 0, condition: { type, conditions: declarations } }]), '```',
    '- Response obtained [outcome: normal] → END',
  ].join('\n') }).steps[0]!
  const step = authored('all')
  const [pair] = procedureOperatorRows(step).rows
  if (pair?.kind !== 'pair') throw new Error('Expected the trip pair')
  const [breakers, other] = [...procedureLineChecks(step, pair).values()]
  expect(breakers?.text).toBe('Both breakers open.')
  const sample = '2026-07-12T04:00:00.000Z'
  const reading = (tagId: string, status: string) => procedureCriterionReadingSchema.parse({ tagId, status, sampledAt: sample, source: 'basis.md' })
  const two = [reading('A', 'supported'), reading('B', 'supported')]
  expect(procedureLineCheckEvidence(breakers!, two, sample).status).toBe('supported')
  expect(procedureLineCheckEvidence(other!, two, sample).status).toBe('unknown')
  expect(procedureLineCheckEvidence(breakers!, [two[0]!], sample).status).toBe('unknown')
  expect(procedureLineCheckEvidence(breakers!, [reading('B', 'contradicted')], sample).status).toBe('contradicted')
  expect(procedureLineCheckEvidence(breakers!, two, '2026-07-12T04:00:02.001Z').status).toBe('unknown')
  const alternate = authored('any')
  const [alternatePair] = procedureOperatorRows(alternate).rows
  if (alternatePair?.kind !== 'pair') throw new Error('Expected the alternate pair')
  expect(procedureLineChecks(alternate, alternatePair).size).toBe(0)
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

test('hazards and repeated checks remain in instruction order, separate from failed and unknown responses', () => {
  const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'fixture.md', sourceUrl: 'https://example.test/fixture.md', rawMarkdown: `---
type: procedure
procedure-md: 0.7
procedure-id: FIXTURE
title: Instruction grouping
---
## Step 1 [id: first]
Caution: The receiver has finite capacity.
Check: Confirm the first prerequisite.
Check: Confirm the second prerequisite.
Action: Operate the identified control.
Note: This indication reports position only.
Expected: The required response is observed.
RNO: Retain the failed response.
Unknown: Retain uncertain evidence.
` })
  const items = procedureStepItems(document.steps[0]!)
  expect(items.filter(item => item.primary).map(item => item.kind === 'block' && item.blocks[0].kind))
    .toEqual(['caution', 'check', 'action', 'note', 'expected'])
  expect(items[1]?.kind === 'block' && items[1].blocks.map(block => block.text))
    .toEqual(['Confirm the first prerequisite.', 'Confirm the second prerequisite.'])
  expect(items.filter(item => !item.primary).map(item => item.kind === 'block' && item.blocks[0].kind))
    .toEqual(['rno', 'unknown'])
})

test("a step's ⓘ reads each tag's live binding and its authored notes, never authored binding prose", () => {
  const document = parseProcedureMarkdown({ source: procedureTestSource, sourcePath: 'world/procedures/E-0.md', sourceUrl: `/wiki?path=world%2Fprocedures%2FE-0.md&revision=${procedureTestSource.revision}`,
    rawMarkdown: [
      '---', 'type: procedure', 'procedure-md: 0.7', 'procedure-id: E-0', 'title: Test', '---',
      '## Step 1 [id: first]', 'Check: breakers «TRIP-BKR-A» open and margin «SUB-MARGIN» and «SI-SIG»', '- Verified [outcome: normal] → #second',
      '## Step 2 [id: second]', 'Check: all turbine stop valves CLOSED', '- Done [outcome: normal] → END',
      '## Tags', '', '- id: TRIP-BKR-A', '  description: reactor trip breaker A position', '  units: enum[OPEN,CLOSED]',
      '- id: SUB-MARGIN', '  description: subcooling margin', '  model-note: the model measures a different quantity',
      '- id: SI-SIG', '  description: SI actuation signal',
    ].join('\n') })
  const [first, second] = document.steps
  const validations = new Map([
    ['TRIP-BKR-A', { status: 'resolved-with-warnings' as const, signal: { label: 'Reactor trip breaker A closed', path: 'reactorTripBreakerA.closed', unit: 'bool' }, warnings: ['requested enum[OPEN,CLOSED] unavailable'] }],
    ['SUB-MARGIN', { status: 'resolved' as const, signal: { path: 'core.subcoolingMarginC', unit: 'C' }, warnings: [] }],
    ['SI-SIG', { status: 'missing' as const, warnings: [] }],
  ])
  expect(procedureStepTagBindings(first!, document.tags, validations)).toEqual([
    { tagId: 'TRIP-BKR-A', description: 'reactor trip breaker A position', status: 'resolved-with-warnings', reads: 'Reactor trip breaker A closed (reactorTripBreakerA.closed, bool)', warnings: ['requested enum[OPEN,CLOSED] unavailable'], notes: [] },
    { tagId: 'SUB-MARGIN', description: 'subcooling margin', status: 'resolved', reads: 'core.subcoolingMarginC (C)', warnings: [], notes: [{ label: 'model note', text: 'the model measures a different quantity' }] },
    { tagId: 'SI-SIG', description: 'SI actuation signal', status: 'missing', warnings: [], notes: [] },
  ])
  expect(procedureStepTagBindings(first!, document.tags, new Map()).map(binding => binding.status)).toEqual(['unchecked', 'unchecked', 'unchecked'])
  expect(procedureStepTagBindings(second!, document.tags, validations)).toEqual([])
})

test('a unit in the strip opens the same procedure where that unit runs it, else its first active one, else the same procedure unstarted', () => {
  const es01 = { procedureId: 'ES-0.1', id: 'es01' }
  const e0 = { procedureId: 'E-0', id: 'e0' }
  expect(procedureUnitJump([es01, e0], 'E-0')).toEqual({ kind: 'run', summary: e0 })
  expect(procedureUnitJump([es01, e0], 'FR-S.1')).toEqual({ kind: 'run', summary: es01 })
  expect(procedureUnitJump([], 'FR-S.1')).toEqual({ kind: 'procedure', procedureId: 'FR-S.1' })
  expect(procedureUnitJump([], null)).toEqual({ kind: 'unit' })
})

test('readings show at an operator\'s precision: one decimal and °C for temperatures, words unchanged', () => {
  expect(procedureDisplayReading('287.871 degC')).toBe('287.9 °C')
  expect(procedureDisplayReading('15.1734 MPa')).toBe('15.17 MPa')
  expect(procedureDisplayReading('3.481e-5 percent')).toBe('3.48e-5 %')
  expect(procedureDisplayReading('42 %')).toBe('42 %')
  expect(procedureDisplayReading('OPEN')).toBe('OPEN')
  expect(procedureDisplayReading('true bool')).toBe('true bool')
  expect(procedureComparisonText('287.871 degC', '>', 280)).toBe('287.9 °C > 280 °C')
  expect(procedureComparisonText('OPEN', '==', 'OPEN')).toBe('OPEN == OPEN')
  expect(procedureElapsedText(3_723_400)).toBe('+01:02:03')
})

test("a procedure's ⓘ drops the Markdown title line the window already shows", () => {
  expect(procedureDescriptionText('# E-0 — Reactor Trip\n\nUse this document to study [it](basis.md).')).toBe('Use this document to study [it](basis.md).')
  expect(procedureDescriptionText('No heading here.')).toBe('No heading here.')
})

test('a CSF chip keeps its last colour when stale and is never blank before a read', () => {
  expect(procedureCsfChip('core-cooling', { label: 'Core Cooling', status: 'orange' }, true)).toEqual({ tone: 'orange', glyph: '◆', label: 'Core Cooling', stale: true })
  expect(procedureCsfChip('core-cooling', { label: 'Core Cooling', status: 'green' }, false)).toEqual({ tone: 'green', glyph: '●', label: 'Core Cooling', stale: false })
  expect(procedureCsfChip('core-cooling', undefined, true)).toEqual({ tone: 'pending', glyph: '…', label: 'core-cooling', stale: false })
  expect(procedureCsfChip('heat-sink', { label: 'Heat Sink', status: 'not-monitored' }, false).glyph).toBe('—')
  expect(procedureCsfChip('heat-sink', { label: 'Heat Sink', status: 'unknown' }, false).glyph).toBe('?')
})

test("a step's ⓘ heads its tags with counts and takes the colour of its worst binding", () => {
  const binding = (status: 'resolved' | 'resolved-with-warnings' | 'missing' | 'unchecked') => ({ tagId: status, status, warnings: [], notes: [] })
  expect(procedureStepBindingSummary([binding('resolved'), binding('resolved-with-warnings'), binding('resolved-with-warnings')])).toEqual({ text: '3 tags · 2 with warnings · 0 missing', worst: 'resolved-with-warnings' })
  expect(procedureStepBindingSummary([binding('resolved'), binding('missing')]).worst).toBe('missing')
  expect(procedureStepBindingSummary([binding('resolved')])).toEqual({ text: '1 tag · 0 with warnings · 0 missing', worst: 'resolved' })
  expect(procedureStepBindingSummary([]).worst).toBe('none')
  expect(procedureBindingStatusWord('resolved-with-warnings')).toBe('Warnings')
})

test('a long float reads rounded, with the requirement in the words lines use', () => {
  expect(procedureReadingText(55.858770158142825, 'percent')).toBe('55.9 %')
  expect(procedureReadingText(7.671234, 'MPa')).toBe('7.67 MPa')
  expect(procedureReadingText(false, 'boolean')).toBe('Off')
  expect(procedureReadingText(undefined, 'MPa')).toBe('unavailable')
  expect(procedureRequirementText('>', 10, 'percent')).toBe('above 10 %')
  expect(procedureRequirementText('<=', 0.063, 'kg/s')).toBe('at most 0.063 kg/s')
  expect(procedureRequirementText('==', false, 'boolean')).toBe('Off')
  expect(procedureEvidenceStatusWord('challenged')).toBe('not met')
  expect(procedureEvidenceStatusWord('supported')).toBe('met')
})

test('readings that share a description name their equipment', () => {
  const tags = [
    { id: 'SG-A-PRESS', description: 'Steam generator pressure', equipment: 'sgA' },
    { id: 'SG-B-PRESS', description: 'Steam generator pressure', equipment: 'sgB' },
    { id: 'MFW-PUMP-A-RUNNING', description: 'Running', equipment: 'mainFeedwaterPumpA' },
    { id: 'CSPRAY-B-RUNNING', description: 'Running', equipment: 'containmentSprayPumpB' },
    { id: 'CTMT-PR', description: 'Containment pressure', equipment: 'containment' },
    { id: 'X-1', description: 'Flow' },
    { id: 'X-2', description: 'Flow' },
    { id: 'BARE' },
  ] as unknown as Parameters<typeof procedureReadingName>[1]
  expect(procedureReadingName('SG-A-PRESS', tags)).toBe('SG A: steam generator pressure')
  expect(procedureReadingName('MFW-PUMP-A-RUNNING', tags)).toBe('Main feedwater pump A: running')
  expect(procedureReadingName('CSPRAY-B-RUNNING', tags)).toBe('Containment spray pump B: running')
  expect(procedureReadingName('CTMT-PR', tags)).toBe('Containment pressure')
  expect(procedureReadingName('X-2', tags)).toBe('Flow (X-2)')
  expect(procedureReadingName('BARE', tags)).toBeUndefined()
  expect(procedureObservationEvidence({ evidence: [{ signal: { tagId: 'SG-B-PRESS', label: 'Steam generator pressure' }, variable: { value: 7.6, unit: 'MPa' }, comparison: { operator: '<', value: 8.1, unit: 'MPa' }, status: 'satisfied' }] }, tags))
    .toMatchObject([{ label: 'SG B: steam generator pressure' }])
})

test('the step counter is a place over the number of steps, not a label', () => {
  const steps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  expect(procedureStepCounterText(steps, 'a')).toBe('step 1/3')
  expect(procedureStepCounterText(steps, 'c')).toBe('step 3/3')
})

test('a chip that is not green names its procedure, and a green one names none', () => {
  expect(procedureCsfChip('heat-sink', { label: 'Heat Sink', status: 'orange', procedure: 'FR-H.2' }, false).procedure).toBe('FR-H.2')
  expect(procedureCsfChip('heat-sink', { label: 'Heat Sink', status: 'green', procedure: 'FR-H.2' }, false).procedure).toBeUndefined()
  expect(procedureCsfChip('heat-sink', { label: 'Heat Sink', status: 'yellow' }, false).procedure).toBeUndefined()
})

test('a document left as it was sits under Not revised, by its category', () => {
  const item = (procedureId: string, category: string) => ({ procedureId, category }) as unknown as Parameters<typeof procedureCategories>[0][number]
  const groups = procedureCategories([item('ES-1.3', 'model-scoped simulator task'), item('E-0', 'model-entry-response'), item('RHR-1', 'model-scoped simulator task')])
  expect(groups.map(group => [group.label, group.procedures.map(procedure => procedure.procedureId)])).toEqual([['Not revised', ['ES-1.3', 'RHR-1']], ['model entry response', ['E-0']]])
})

test('an accepted command ends a light sample on a paused clock, and not on a running one', () => {
  const running = { paused: false, currentTime: '2026-07-12T04:00:10.000Z' }
  const paused = { paused: true, currentTime: '2026-07-12T04:00:10.000Z' }
  expect(procedureCheckVersion(1, '1:0', running)).toBe(procedureCheckVersion(1, '2:0', running))
  expect(procedureCheckVersion(1, '1:0', { ...running, currentTime: '2026-07-12T04:00:11.000Z' })).toBe(procedureCheckVersion(1, '1:0', running))
  expect(procedureCheckVersion(1, '1:0', paused)).not.toBe(procedureCheckVersion(1, '2:0', paused))
  expect(procedureCheckVersion(1, '1:0', paused)).not.toBe(procedureCheckVersion(1, '1:0', { ...paused, currentTime: '2026-07-12T04:00:11.000Z' }))
  expect(procedureCheckVersion(1, '1:0', running)).not.toBe(procedureCheckVersion(2, '1:0', running))
  expect(procedureCheckVersion(1, '1:0', running)).not.toBe(procedureCheckVersion(1, '1:0', paused))
})

const limitDocument = (lines: string) => parseProcedureMarkdown({
  source: procedureTestSource, sourcePath: 'TEST.md', sourceUrl: '/wiki?path=TEST.md&revision=r',
  rawMarkdown: ['---', 'type: procedure', 'procedure-md: 0.7', 'procedure-id: TEST', 'title: Limits', '---', '# Limits', '', '## Step 1 [id: one] One', 'Pair: [id: row, criterion: 0]', lines, 'RNO: Act.', 'Basis: [why](basis.md#one).', '- Go on [outcome: normal] → END', '', '## Tags', '',
    ...['A', 'B'].flatMap(id => [`- id: ${id}`, '  description: Breaker closed', '  units: boolean', `  equipment: breaker${id}`, '  states: CLOSED/OPEN']),
    '- id: L', '  description: Level', '  units: percent', ''].join('\n'),
})
const at = '2026-11-08T08:00:10.000Z'
const rowsOf = (document: ReturnType<typeof limitDocument>) => {
  const step = document.steps[0]!
  const row = procedureOperatorRows(step).rows.find(item => item.kind === 'pair')!
  return [...procedureLineChecks(step, row as Extract<typeof row, { kind: 'pair' }>).values()]
}
const read = (tagId: string, operator: string, expected: number | boolean, value: number | boolean, status: 'supported' | 'contradicted' | 'unknown', sampledAt = at, extra = {}) =>
  ({ source: 'basis', tagId, operator, expected, value, unit: typeof value === 'boolean' ? 'boolean' : 'percent', sampledAt, status, ...extra }) as Parameters<typeof procedureLineCheckEvidence>[1][number]

test('a line with limits lights by its comparisons: any red gives red, else any grey gives grey, else green', () => {
  const [line] = rowsOf(limitDocument('Check: Breakers A and B — OPEN. «A == false» «B == false»'))
  expect(line!.text).toBe('Breakers A and B — OPEN.')
  const green = [read('A', '==', false, false, 'supported'), read('B', '==', false, false, 'supported')]
  expect(procedureLineCheckEvidence(line!, green, at).status).toBe('supported')
  expect(procedureLineCheckEvidence(line!, [green[0]!, read('B', '==', false, true, 'contradicted')], at).status).toBe('contradicted')
  expect(procedureLineCheckEvidence(line!, [green[0]!, read('B', '==', false, false, 'unknown')], at).status).toBe('unknown')
  expect(procedureLineCheckEvidence(line!, [green[0]!], at).status).toBe('unknown')
  expect(procedureLineCheckEvidence(line!, [read('A', '==', false, true, 'contradicted'), read('B', '==', false, false, 'unknown')], at).status).toBe('contradicted')
})

test('a band finds each reading by its comparison, so one side cannot read as the other', () => {
  const [line] = rowsOf(limitDocument('Check: Level — 40% TO 70%. «L > 40» «L < 70»'))
  const evidence = procedureLineCheckEvidence(line!, [read('L', '>', 40, 90, 'supported'), read('L', '<', 70, 90, 'contradicted')], at)
  expect(evidence.status).toBe('contradicted')
  expect(procedureLightRows(evidence.operands, []).map(row => [row.limit, row.state])).toEqual([['above 40 %', 'supported'], ['below 70 %', 'contradicted']])
})

test('an any line is green on one, red only when all are red, else grey', () => {
  const [line] = rowsOf(limitDocument('Check: Breakers — AT LEAST ONE OPEN. «any» «A == false» «B == false»'))
  const open = (id: string) => read(id, '==', false, false, 'supported'), closed = (id: string) => read(id, '==', false, true, 'contradicted')
  expect(procedureLineCheckEvidence(line!, [closed('A'), open('B')], at).status).toBe('supported')
  expect(procedureLineCheckEvidence(line!, [closed('A'), closed('B')], at).status).toBe('contradicted')
  expect(procedureLineCheckEvidence(line!, [closed('A'), read('B', '==', false, false, 'unknown')], at).status).toBe('unknown')
})

test('a WHEN line has no colour until met and never shows red', () => {
  const [line] = rowsOf(limitDocument('When: Level — BELOW 75%. «L < 75»'))
  expect(line!.limits?.when).toBe(true)
  expect(line!.text).toBe('WHEN Level — BELOW 75%.')
  expect(procedureLightTone(line!, 'supported')).toBe('supported')
  expect(procedureLightTone(line!, 'contradicted')).toBe('waiting')
  expect(procedureLightTone(line!, 'unknown')).toBe('waiting')
})

test('a popover row holds the reading, limit, time and quality, in the words the tag declares', () => {
  const document = limitDocument('Check: Breakers A and B — OPEN. «A == false» «B == false»')
  const [line] = rowsOf(document)
  const old = '2026-11-08T08:00:01.000Z'
  const evidence = procedureLineCheckEvidence(line!, [read('A', '==', false, true, 'contradicted'), read('B', '==', false, false, 'supported', old)], at)
  const rows = procedureLightRows(evidence.operands, document.tags)
  expect(rows[0]).toEqual({ tagId: 'A', name: 'Breaker A: breaker closed', value: 'CLOSED', limit: 'OPEN', state: 'contradicted', quality: 'good', sampledAt: at })
  expect(rows[1]).toEqual({ tagId: 'B', name: 'Breaker B: breaker closed', value: 'OPEN', limit: 'OPEN', state: 'unknown', quality: 'stale', sampledAt: old })
  const bad = procedureLightRows(procedureLineCheckEvidence(line!, [read('A', '==', false, false, 'unknown', at, { reason: 'Signal quality is bad.' })], at).operands, document.tags)
  expect(bad[0]!.quality).toBe('Signal quality is bad.')
  expect(bad[1]).toMatchObject({ value: 'no value', state: 'unknown', quality: 'no reading' })
})

test('a tag button names the equipment on a rewritten document and keeps its id on any other', () => {
  const tags = [{ id: 'RX-TRIP-MAN', equipment: 'manualReactorTrip' }, { id: 'BARE' }] as unknown as Parameters<typeof procedureTagLabel>[1] extends infer D ? D extends { tags: infer T } ? T : never : never
  expect(procedureTagLabel('RX-TRIP-MAN', { tags, annotations: { 'ai-workable': 'true' } })).toBe('Manual reactor trip')
  expect(procedureTagLabel('BARE', { tags, annotations: { 'ai-workable': 'true' } })).toBe('BARE')
  expect(procedureTagLabel('RX-TRIP-MAN', { tags })).toBe('RX-TRIP-MAN')
})

test('a press against red says what was not met, and any other press says nothing', () => {
  const tags = [{ id: 'A', description: 'Breaker closed', equipment: 'breakerA' }, { id: 'B', description: 'Breaker closed', equipment: 'breakerB' }, { id: 'P', description: 'Power range' }] as unknown as Parameters<typeof procedureDecisionAgainst>[1]
  const reading = (tagId: string, status: string) => ({ source: 'basis', tagId, status }) as Parameters<typeof procedureLineCheckEvidence>[1][number]
  expect(procedureDecisionAgainst({ criterion: { status: 'contradicted', readings: [reading('A', 'supported'), reading('B', 'contradicted'), reading('P', 'unknown')] } }, tags)).toEqual(['Breaker B: breaker closed', 'Power range'])
  expect(procedureDecisionAgainst({ criterion: { status: 'supported', readings: [reading('A', 'supported')] } }, tags)).toBeUndefined()
  expect(procedureDecisionAgainst({}, tags)).toBeUndefined()
  expect(procedureDecisionAgainst(undefined, tags)).toBeUndefined()
})

test('a foldout reads as items with headlines', () => {
  expect(procedureFoldoutItems('- **SI.** IF SI actuates, THEN go. «SI-ACTUATED»\n- **RCP stop.** IF low\n  THEN stop.\n- Keep level.')).toEqual([
    { name: 'SI.', text: 'IF SI actuates, THEN go. «SI-ACTUATED»' }, { name: 'RCP stop.', text: 'IF low THEN stop.' }, { text: 'Keep level.' },
  ])
})

test('a foldout waits for the step its heading names', () => {
  const steps = [{ id: 'a', label: '1' }, { id: 'b', label: '5' }, { id: 'c', label: '6' }]
  expect(procedureFoldoutBeforeStart('Foldout: applies from Step 5', steps, 'a')).toBe(true)
  expect(procedureFoldoutBeforeStart('Foldout: applies from Step 5', steps, undefined)).toBe(true)
  expect(procedureFoldoutBeforeStart('Foldout: applies from Step 5', steps, 'b')).toBe(false)
  expect(procedureFoldoutBeforeStart('Foldout: applies from Step 5', steps, 'c')).toBe(false)
  expect(procedureFoldoutBeforeStart('Foldout: applies at every step', steps, 'a')).toBe(false)
})

test('a reference document inherits the foldout of the procedure that sent the Run there, along the chain', () => {
  const run = (procedureId: string, target: string, status = 'transferred', plantId = 'plant:a', simulationTime = '2026-11-08T08:00:00.000Z') => ({ procedureId, status, scope: { plantId }, stepStates: [{ decision: { targetKind: 'procedure', target, simulationTime } }] }) as unknown as Parameters<typeof procedurePriorFoldout>[0][number]
  const foldout = { title: 'Foldout: applies from Step 5', text: '- Keep.', tagIds: [], sourceLine: 1 }
  const documents = { 'E-0': { procedureId: 'E-0', foldout }, 'E-2': { procedureId: 'E-2' } } as unknown as Record<string, ReturnType<Parameters<typeof procedurePriorFoldout>[1]>>
  const documentFor = (item: { procedureId: string }) => documents[item.procedureId]
  const scope = { plantId: 'plant:a' }
  expect(procedurePriorFoldout([run('E-0', 'E-2')], documentFor, scope, 'E-2')).toMatchObject({ procedureId: 'E-0', foldout })
  expect(procedurePriorFoldout([run('E-0', 'E-2'), run('E-2', 'ECA-2.1')], documentFor, scope, 'ECA-2.1')).toMatchObject({ procedureId: 'E-0', foldout })
  expect(procedurePriorFoldout([run('E-0', 'E-2', 'active')], documentFor, scope, 'E-2')).toBeUndefined()
  expect(procedurePriorFoldout([run('E-0', 'E-2', 'transferred', 'plant:b')], documentFor, scope, 'E-2')).toBeUndefined()
  expect(procedurePriorFoldout([run('E-2', 'E-3'), run('E-3', 'E-2')], documentFor, scope, 'E-3')).toBeUndefined()
})

const inlineTags = [
  ...['A', 'B'].flatMap(letter => [{ id: `SG-${letter}-PRESS`, description: 'Steam generator pressure', equipment: `sg${letter}`, units: 'MPa' }, { id: `SG-${letter}-LVL`, description: 'Steam generator level', equipment: `sg${letter}`, units: 'percent' }]),
  { id: 'SI', description: 'SI actuated', units: 'boolean', annotations: { states: 'ACTUATED/NOT ACTUATED' } },
  { id: 'PZR', description: 'Pressurizer pressure', equipment: 'pressurizer', units: 'MPa' },
] as unknown as Parameters<typeof procedureInlineLayout>[1]

test('a judgement line lays its readings out by equipment where they form a grid, and as named rows where not', () => {
  expect(procedureInlineLayout(['SG-A-PRESS', 'SG-B-PRESS', 'SG-A-LVL', 'SG-B-LVL'], inlineTags)).toEqual({
    heads: ['SG A', 'SG B'],
    rows: [{ label: 'Steam generator pressure', tagIds: ['SG-A-PRESS', 'SG-B-PRESS'] }, { label: 'Steam generator level', tagIds: ['SG-A-LVL', 'SG-B-LVL'] }],
  })
  const named = [{ id: 'PA', description: 'SG A pressure', equipment: 'sgA' }, { id: 'PB', description: 'SG B pressure', equipment: 'sgB' }] as unknown as Parameters<typeof procedureInlineLayout>[1]
  expect(procedureInlineLayout(['PA', 'PB'], named)).toEqual({ heads: ['SG A', 'SG B'], rows: [{ label: 'Pressure', tagIds: ['PA', 'PB'] }] })
  expect(procedureInlineLayout(['SI', 'PZR'], inlineTags)).toEqual({ heads: [], rows: [{ label: 'SI actuated', tagIds: ['SI'] }, { label: 'Pressurizer pressure', tagIds: ['PZR'] }] })
  expect(procedureInlineLayout(['SG-A-PRESS', 'SG-B-PRESS', 'SG-A-LVL'], inlineTags).heads).toEqual([])
})

test('a judgement reading has no verdict, and says when it cannot be trusted', () => {
  const now = Date.parse('2026-11-08T08:00:10.000Z')
  const read = (tagId: string, extra: object) => ({ tagId, binding: 'resolved', sampledAt: '2026-11-08T08:00:10.000Z', ...extra }) as Parameters<typeof procedureInlineValue>[2][number]
  expect(procedureInlineValue('SG-A-PRESS', inlineTags, [read('SG-A-PRESS', { value: 7.67123, unit: 'MPa' })], now)).toEqual({ value: '7.67 MPa', stale: false })
  expect(procedureInlineValue('SI', inlineTags, [read('SI', { value: false, unit: 'boolean' })], now)).toEqual({ value: 'NOT ACTUATED', stale: false })
  expect(procedureInlineValue('SG-A-PRESS', inlineTags, [read('SG-A-PRESS', { value: 7.67, unit: 'MPa', sampledAt: '2026-11-08T08:00:01.000Z' })], now)).toEqual({ value: '7.67 MPa', stale: true, note: 'stale' })
  expect(procedureInlineValue('SG-A-PRESS', inlineTags, [read('SG-A-PRESS', { value: 7.67, unit: 'MPa', quality: 'bad' })], now)).toEqual({ value: '7.67 MPa', stale: true, note: 'bad' })
  expect(procedureInlineValue('SG-A-PRESS', inlineTags, [read('SG-A-PRESS', { reason: 'unbound' })], now)).toEqual({ value: '–', stale: true, note: 'unbound' })
  expect(procedureInlineValue('PZR', inlineTags, [], now)).toEqual({ value: '–', stale: true })
})

test('only a limit-free line ending in tags reads as a judgement', () => {
  const block = (kind: string, text: string, tagIds: string[], limits?: object) => ({ kind, text, tagIds, ...(limits ? { limits } : {}) }) as Parameters<typeof procedureJudgementLine>[0]
  expect(procedureJudgementLine(block('check', 'Is any SG uncontrolled? «A» «B»', ['A', 'B']))).toEqual({ text: 'Is any SG uncontrolled?', tagIds: ['A', 'B'] })
  expect(procedureJudgementLine(block('check', 'Level — BELOW 5%. «A»', ['A'], { any: false, comparisons: [] }))).toBeUndefined()
  expect(procedureJudgementLine(block('rno', 'Press it. «A»', ['A']))).toBeUndefined()
  expect(procedureJudgementLine(block('check', 'Read «A» then act.', ['A']))).toBeUndefined()
  expect(procedureJudgementLine(block('check', 'No tags here.', []))).toBeUndefined()
})

test('tag buttons of one family repeat only the letter', () => {
  const document = { tags: ['A', 'B', 'C'].map(letter => ({ id: `V-${letter}`, equipment: `auxFeedwaterValve${letter}` })).concat({ id: 'P', equipment: 'pump' }), annotations: { 'ai-workable': 'true' } } as unknown as Parameters<typeof procedureTagLabels>[1]
  const tag = (text: string) => ({ kind: 'tag' as const, text }), space = { kind: 'text' as const, text: ' ' }
  const labels = procedureTagLabels([{ kind: 'text', text: 'Open. ' }, tag('V-A'), space, tag('V-B'), space, tag('V-C'), space, tag('P')], document)
  expect(labels.filter(Boolean).map(item => item!.shown)).toEqual(['Aux feedwater valve A', 'B', 'C', 'Pump'])
  expect(labels.filter(Boolean).map(item => item!.full)).toEqual(['Aux feedwater valve A', 'Aux feedwater valve B', 'Aux feedwater valve C', 'Pump'])
  expect(procedureTagLabels([tag('V-A'), { kind: 'text', text: ' then ' }, tag('V-B')], document).filter(Boolean).map(item => item!.shown)).toEqual(['Aux feedwater valve A', 'Aux feedwater valve B'])
  expect(procedureTagLabels([tag('V-A'), space, tag('V-B')], { tags: [] }).filter(Boolean).map(item => item!.shown)).toEqual(['V-A', 'V-B'])
})

test('a step with line limits ends with its boxes, whichever row its lights test', () => {
  const document = parseProcedureMarkdown({
    source: procedureTestSource, sourcePath: 'TEST.md', sourceUrl: '/wiki?path=TEST.md&revision=r',
    rawMarkdown: ['---', 'type: procedure', 'procedure-md: 0.7', 'procedure-id: TEST', 'title: Rows', '---', '# Rows', '', '## Step 1 [id: one] One',
      'Pair: [id: a, criterion: 0]', 'Check: Level — BELOW 5%. «L < 5»', 'RNO: Act.', 'Pair: [id: b]', 'Check: Is it steady? «L»', 'RNO: Act again.', 'Basis: [why](basis.md#one).',
      '- Go on [outcome: normal] → END', '', '## Tags', '', '- id: L', '  description: Level', '  units: percent', ''].join('\n'),
  })
  const rows = procedureOperatorRows(document.steps[0]!).rows.filter(row => row.kind === 'pair') as Array<Extract<ReturnType<typeof procedureOperatorRows>['rows'][number], { kind: 'pair' }>>
  expect(rows.map(row => row.expected.filter(item => item.kind === 'branch').length)).toEqual([0, 1])
  expect(rows[0]!.advisoryBranchIndex).toBe(0)
  expect(procedureLineChecks(document.steps[0]!, rows[0]!).size).toBe(1)
})

test('a rewritten document links its usage page at its own revision', () => {
  const sourceUrl = '/wiki?path=world%2Fpacks%2Fprocess-plant%2Fprocedures%2FE-0.md&revision=abc'
  expect(procedureUsageHref({ sourceUrl, annotations: { 'ai-workable': 'true' } })).toBe('/wiki?path=world%2Fpacks%2Fprocess-plant%2Fprocedures%2Fusage.md&revision=abc')
  expect(procedureUsageHref({ sourceUrl })).toBeUndefined()
})

test('two tags on one piece of equipment say which is which', () => {
  const document = { tags: [{ id: 'PORV-456A', description: 'Pressurizer PORV A demand', equipment: 'pressurizer' }, { id: 'MOV-8000A', description: 'PORV A block valve demand', equipment: 'pressurizer' }], annotations: { 'ai-workable': 'true' } } as unknown as Parameters<typeof procedureTagLabels>[1]
  const tag = (text: string) => ({ kind: 'tag' as const, text })
  expect(procedureTagLabels([tag('PORV-456A'), { kind: 'text', text: ' ' }, tag('MOV-8000A')], document).filter(Boolean).map(item => item!.shown)).toEqual(['Pressurizer PORV A demand', 'PORV A block valve demand'])
  expect(procedureTagLabels([tag('PORV-456A')], document).filter(Boolean).map(item => item!.shown)).toEqual(['Pressurizer'])
})

test('pressing a chip goes to the procedure it names, if that is listed and not already shown', () => {
  const procedures = [{ procedureId: 'FR-H.3' }, { procedureId: 'E-0' }]
  expect(procedureChipTarget({ procedure: 'FR-H.3' }, procedures, 'E-0')).toBe('FR-H.3')
  expect(procedureChipTarget({ procedure: 'FR-H.3' }, procedures, 'FR-H.3')).toBeUndefined()
  expect(procedureChipTarget({ procedure: 'FR-Z.9' }, procedures, 'E-0')).toBeUndefined()
  expect(procedureChipTarget({}, procedures, 'E-0')).toBeUndefined()
})

test('a tag family differs by its letters wherever they sit, and a tag with no equipment reads by its description', () => {
  const document = { tags: ['A', 'B'].map(letter => ({ id: `AFW-FCV-${letter}-MOTOR-POWER`, description: `AFW valve ${letter} motor power` })).concat(['A', 'B'].map(letter => ({ id: `L-${letter}`, equipment: `auxFeedwaterValve-${letter}-to-sg-${letter}`, description: '' }))), annotations: { 'ai-workable': 'true' } } as unknown as Parameters<typeof procedureTagLabels>[1]
  const tag = (text: string) => ({ kind: 'tag' as const, text }), space = { kind: 'text' as const, text: ' ' }
  expect(procedureTagLabels([tag('AFW-FCV-A-MOTOR-POWER'), space, tag('AFW-FCV-B-MOTOR-POWER')], document).filter(Boolean).map(item => item!.shown)).toEqual(['AFW valve A motor power', 'B'])
  expect(procedureTagLabels([tag('L-A'), space, tag('L-B')], document).filter(Boolean).map(item => item!.shown)).toEqual(['Aux feedwater valve A to SG A', 'B'])
})
