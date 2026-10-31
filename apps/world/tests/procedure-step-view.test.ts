import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandId, IsoTimestamp, ProcedureDocument, ProcedureRunState } from '../src/core/model/index.ts'
import { parseProcedureTagValue, type ProcedureCsfEvaluation, type ProcedureObservationPort, type ProcedureTagValue } from '../src/features/procedures/pack-observations.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { composeProcedureRunView, composeProcedureRunReadView, composeProcedureStepView, projectProcedureStepGuidance, procedureStepReadViewSchema, procedureRunReadViewSchema, procedureStepNotFoundCode, type ProcedureStepViewPorts } from '../src/features/procedures/step-view.ts'

const source = {
  sourceId: 'pwr-ops', label: 'PWR operations procedures', repository: 'leitbild-wikis/pwr-ops', ref: 'main',
  path: 'wiki/procedures', revision: 'c'.repeat(40), fetchedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  sourceUrl: 'https://github.com/leitbild-wikis/pwr-ops/tree/main/wiki/procedures',
}

const plantTime = '2026-10-13T08:01:00.000Z' as IsoTimestamp

const markdown = (csfs: string) => `---
type: procedure
procedure-md: 0.7
procedure-id: E-0
title: Reactor Trip or Safety Injection
${csfs}
---
# E-0 — Reactor Trip or Safety Injection

A preamble the step view leaves out.

## Step 1 [id: verify-reactor-trip]
Note: Simulator applicability, see [model scope](../model-and-scope.md).
Check: reactor trip breakers «TRIP-BKR-A» AND «TRIP-BKR-B» OPEN AND neutron flux «NIS-PR-AVG» decreasing
Basis: Technical basis text with [a link](../basis.md#trip) the AI does not decide by.
- Verified [outcome: normal] → #verify-turbine-trip
  Because: rapid neutron flux decrease confirms [core shutdown](../basis.md)
- Not verified [outcome: rno] → [[FR-S.1]]
## Step 2 [id: verify-turbine-trip]
Check: all turbine stop valves CLOSED
- Verified [outcome: normal] → END

## Tags

- id: TRIP-BKR-A
  description: reactor trip breaker A position
  model-note: the model reports closed as a boolean
- id: TRIP-BKR-B
  description: reactor trip breaker B position
- id: NIS-PR-AVG
  description: power range neutron flux average
  units: percent
`

const document = (csfs = 'csfs-monitored: [subcriticality, core-cooling]'): ProcedureDocument =>
  parseProcedureMarkdown({ source, sourcePath: 'wiki/procedures/E-0.md', sourceUrl: 'https://example.test/E-0.md', rawMarkdown: markdown(csfs) })

const run = (overrides: Partial<ProcedureRunState> = {}): ProcedureRunState => ({
  runId: 'procedure-run:view', sourceId: source.sourceId, sourceRevision: source.revision, sourcePath: 'wiki/procedures/E-0.md',
  procedureId: 'E-0', scope: { plantId: 'plant:unit-2', label: 'Unit 2' }, title: 'Reactor Trip or Safety Injection', status: 'active',
  startedAt: '2026-10-13T08:00:00.000Z' as IsoTimestamp, startedBy: 'actor:ai:assistant' as ActorId, currentStepId: 'verify-reactor-trip',
  driver: { kind: 'ai', actorId: 'actor:ai:assistant' as ActorId, label: 'Assistant', since: '2026-10-13T08:00:00.000Z' as IsoTimestamp },
  stepStates: [], ...overrides,
})

const value = (tagId: string, formatted: string, extra: Partial<ProcedureTagValue> = {}): ProcedureTagValue =>
  ({ tagId, label: tagId, value: 0, formatted, quality: 'good', ...extra })

const csf = (id: string, status: ProcedureCsfEvaluation['status'], extra: Partial<ProcedureCsfEvaluation> = {}): ProcedureCsfEvaluation =>
  ({ id, label: id, status, signalCount: 0, signals: [], qualification: 'reference-model-criteria', ...extra })

// Test-only ports: a plant clock and Pack answers per tag.
const ports = (config: {
  readonly reads?: Readonly<Record<string, ProcedureTagValue | Error | 'missing'>>
  readonly csfs?: ReadonlyMap<string, ProcedureCsfEvaluation> | Error
  readonly calls?: string[]
  readonly observation?: Readonly<Record<string, unknown>>
} = {}): ProcedureStepViewPorts => ({
  sequence: () => 42,
  events: () => [],
  clock: () => ({ currentTime: plantTime, paused: false }),
  observations: (): ProcedureObservationPort => ({
    validateTags: async tags => new Map(tags.map(tag => [tag.id, {
      id: tag.id, status: config.reads?.[tag.id] === 'missing' ? 'missing' as const : 'resolved' as const, warnings: tag.id === 'NIS-PR-AVG' ? ['requested percent unavailable'] : [],
    }])),
    readObservation: async () => { if (config.observation) return config.observation; throw new Error('No declared query in this test port') },
  readTags: async tags => new Map(tags.map(tag => {
      config.calls?.push(tag.id)
      const value = config.reads?.[tag.id]
      return [tag.id, value === undefined || value === 'missing' ? new Error(`no ${tag.id}`) : value] as const
    })),
    readTag: async tag => {
      config.calls?.push(tag.id)
      const read = config.reads?.[tag.id]
      if (read === undefined || read === 'missing') throw new Error(`no ${tag.id}`)
      if (read instanceof Error) throw read
      return read
    },
    evaluateCsfs: async ids => {
      config.calls?.push(`csfs:${ids.join(',')}`)
      if (config.csfs instanceof Error) throw config.csfs
      return config.csfs ?? new Map()
    },
  }),
})

describe('procedure step view', () => {
  test('a canonical current-state read includes the complete stored current step without acquiring Pack observations', () => {
    const calls: string[] = [], comment = 'Current human note — keep every word. '.repeat(30)
    const state = { stepId: 'verify-reactor-trip', assessment: 'unknown' as const, favorite: true, comment,
      updatedAt: plantTime, updatedBy: 'actor:person:operator' as ActorId }
    const current = composeProcedureRunReadView({ run: run({ stepStates: [state] }), document: document(), ports: ports({ calls }) })
    expect(procedureRunReadViewSchema.parse(current)).toEqual(current)
    expect(current).toMatchObject({ sequence: 42, simulationTime: plantTime, paused: false, observationsAcquired: false })
    expect(current.step!.state).toEqual(state)
    expect(current.step!.definition.input).toMatchObject({ sourceRevision: source.revision, stepId: state.stepId })
    for (const field of ['tags', 'csfs']) expect(current).not.toHaveProperty(field)
    for (const field of ['blocks', 'branches', 'branchAssessments']) expect(current.step).not.toHaveProperty(field)
    expect(calls).toEqual([])
  })

  test('opted-out guidance omits only authored static fields and preserves all current facts, source and authority', async () => {
    const doc = document()
    const comment = 'Complete current checkpoint: '.repeat(40)
    const current = await composeProcedureStepView({ document: doc, run: run({ stepStates: [{ stepId: 'verify-reactor-trip', assessment: 'blank',
      favorite: false, comment, updatedAt: plantTime, updatedBy: 'actor:ai:assistant' as ActorId }] }), ports: ports({
      reads: {
        'TRIP-BKR-A': value('TRIP-BKR-A', 'true boolean', { value: true, writable: true, quality: 'uncertain', warning: 'A current writable-demand caveat.' }),
        'TRIP-BKR-B': new Error('Actual feedback unavailable'),
        'NIS-PR-AVG': value('NIS-PR-AVG', '4 MW', { conversionStatus: 'unavailable', warning: 'No conversion to requested percent.' }),
      },
      csfs: new Map([['subcriticality', csf('subcriticality', 'unknown', { reason: 'Missing independent indication.' })]]),
    }) })
    const original = structuredClone(current)
    const projected = projectProcedureStepGuidance(current, false)
    expect(procedureStepReadViewSchema.parse(projected)).toEqual(projected)
    expect(projected).toHaveProperty('guidanceIncluded', false)
    expect(projected.step).not.toHaveProperty('blocks')
    expect(projected.step).not.toHaveProperty('branches')
    const { blocks: _blocks, branches: _branches, branchAssessments, ...facts } = current.step!
    expect(projected.step).toEqual({ ...facts, branchAssessments: branchAssessments.map(({ condition: _condition, applicability: _applicability, ...currentFacts }) => currentFacts) })
    expect(projected.run).toEqual(current.run)
    expect(projected.csfs).toEqual(current.csfs)
    expect(projected.tags).toEqual(current.tags!.map(({ description: _description, notes: _notes, ...tag }) => tag))
    expect(projected.tags![0]!.reading!.note).toContain('Writable command or demand')
    expect(projected.tags![0]!.reading!.note).toContain('A current writable-demand caveat.')
    expect(projected.tags![1]).toMatchObject({ binding: 'resolved', unavailable: 'Actual feedback unavailable' })
    expect(projected.tags![2]).toMatchObject({ warnings: ['requested percent unavailable'], reading: { note: 'No conversion to requested percent.' } })
    expect(projected.step!.state!.comment).toBe(comment)
    expect(projected.step!.definition).toEqual(current.step!.definition)
    expect(current).toEqual(original)
    expect(projectProcedureStepGuidance(current)).toBe(current)
    expect(projectProcedureStepGuidance(current, true)).toBe(current)
    expect(current).not.toHaveProperty('guidanceIncluded')
  })

  test('the step view carries a precise pending human-input request', async () => {
    const inputRequest = { requestId: 'command:input' as CommandId, stepId: 'verify-reactor-trip', issue: 'Confirm local indication.',
      requestedAt: plantTime, requestedBy: 'actor:ai:assistant' as ActorId }
    const view = await composeProcedureStepView({ run: run({ inputRequest }), document: document(), ports: ports() })
    expect(view.run.inputRequest).toEqual(inputRequest)
    expect(view.run.plantId).toBe('plant:unit-2')
  })

  test('reads the current step compactly: branches with the AI verdict, step tags with readings and plant time, CSF colours, sequence', async () => {
    const view = await composeProcedureStepView({ run: run(), document: document(), ports: ports({
      reads: {
        'TRIP-BKR-A': value('TRIP-BKR-A', 'false boolean', { value: false, path: 'reactorTripBreakerA.closed' }),
        'TRIP-BKR-B': value('TRIP-BKR-B', 'false', { quality: 'uncertain' }),
        'NIS-PR-AVG': value('NIS-PR-AVG', '3.1 MW', { conversionStatus: 'unavailable', warning: 'requested percent is not available' }),
      },
      csfs: new Map([['subcriticality', csf('subcriticality', 'green', { reason: 'subcritical' })], ['core-cooling', csf('core-cooling', 'orange', { procedure: 'FR-C.2', reason: 'core exit hot' })]]),
    }) })
    expect(view.sequence).toBe(42)
    expect(view.simulationTime).toBe(plantTime)
    expect(view.paused).toBeUndefined()
    expect(view.run).toEqual({ sourceId: source.sourceId, sourceRevision: source.revision, sourcePath: 'wiki/procedures/E-0.md', runId: 'procedure-run:view', procedureId: 'E-0', title: 'Reactor Trip or Safety Injection', status: 'active',
      plantId: 'plant:unit-2', unit: 'Unit 2', driver: run().driver, currentStepId: 'verify-reactor-trip', stepNumber: 1, totalSteps: 2 })
    expect(view.step!.blocks.map(block => block.kind)).toEqual(['note', 'check'])
    expect(view.step!.blocks[0]!.text).toBe('Simulator applicability, see model scope.')
    expect(JSON.stringify(view)).not.toContain('preamble')
    expect(JSON.stringify(view)).not.toContain('basis.md')
    expect(view.step!.branches).toEqual([
      { index: 0, label: 'Verified', outcome: 'normal', targetKind: 'step', target: 'verify-turbine-trip', targetLabel: '2', because: 'rapid neutron flux decrease confirms core shutdown' },
      { index: 1, label: 'Not verified', outcome: 'rno', targetKind: 'procedure', target: 'FR-S.1' },
    ])
    expect(view.tags).toEqual([
      { id: 'TRIP-BKR-A', description: 'reactor trip breaker A position', binding: 'resolved', notes: { 'model-note': 'the model reports closed as a boolean' },
        reading: { formatted: 'false boolean', signal: 'reactorTripBreakerA.closed', quality: 'good' } },
      { id: 'TRIP-BKR-B', description: 'reactor trip breaker B position', binding: 'resolved', reading: { formatted: 'false', quality: 'uncertain' } },
      { id: 'NIS-PR-AVG', description: 'power range neutron flux average', binding: 'resolved', warnings: ['requested percent unavailable'],
        reading: { formatted: '3.1 MW', quality: 'good', note: 'requested percent is not available' } },
    ])
    expect(view.csfs).toEqual([{ id: 'subcriticality', status: 'green' }, { id: 'core-cooling', status: 'orange', procedure: 'FR-C.2', reason: 'core exit hot' }])
    expect(view.step!.state).toBeUndefined()
  })

  test('a writable demand binding is explicit rather than presented as equipment response', async () => {
    const doc = document('csfs-monitored: []')
    const command = parseProcedureTagValue(doc.tags[0]!, { signals: [{ signal: { path: 'test.tripDemand', label: 'Trip demand', unit: 'boolean', writable: true },
      variable: { value: false }, quality: { status: 'good' } }] })
    expect(command.writable).toBe(true)
    const view = await composeProcedureStepView({ run: run(), document: doc, ports: ports({ reads: { 'TRIP-BKR-A': command } }) })
    expect(view.tags![0]!.reading).toMatchObject({ note: 'Writable command or demand; use response feedback to confirm equipment state.' })
  })

  test('current Pack facts remain complete while the static query definition is focused and discoverable', async () => {
    const doc = document('csfs-monitored: []')
    const authored = { capabilityId: 'world.test.observe', input: { condition: { exact: 'authored-query-tree' } }, source: 'owner.md#criteria', maxAgeSeconds: 2 }
    const nativeFacts = { status: 'challenged', targetObjectId: 'plant:unit-2', simulationTime: plantTime,
      evidenceKind: 'engineering-diagnostic', provenance: 'runtime-model',
      ownerSpecificFacts: { path: 'observed.pressure', value: 8, unit: 'MPa', quality: { status: 'good' }, rangeValidity: 'valid', threshold: 7.5, reason: 'Pressure above the current objective.' },
    }
    const declared = { ...doc, steps: doc.steps.map((step, index) => index ? step : { ...step, decisions: [{ branchIndex: 0, observation: authored }] }) }
    const result = await composeProcedureStepView({ run: run(), document: declared, ports: ports({ observation: nativeFacts }) })
    expect(result.step!.branchAssessments[0]).toMatchObject({ status: 'contradicted', observation: { capabilityId: authored.capabilityId, source: authored.source, maxAgeSeconds: 2, result: nativeFacts } })
    expect(result.step!.branchAssessments[0]!.observation).not.toHaveProperty('input')
    expect(result.step!.definition).toEqual({ capabilityId: 'world.procedure.document.read', input: {
      sourceId: source.sourceId, procedureId: doc.procedureId, sourceRevision: source.revision, sourcePath: doc.sourcePath, stepId: doc.steps[0]!.id,
    } })
    expect(declared.steps[0]!.decisions![0]!.observation!.input).toEqual(authored.input)
  })

  test('known-step reads retain failed applicability, missing observations, manual and held evidence without repeating authored definitions', async () => {
    const doc = document('csfs-monitored: []')
    const applicability = { description: 'Only this authored model', source: 'owner.md#scope', model: { ref: 'test.model', digest: 'a'.repeat(64) } }
    const comparison = { type: 'comparison', tagId: 'TRIP-BKR-A', operator: '==', value: false, unit: 'boolean',
      evidence: 'engineering-diagnostic', source: 'owner.md#trip', maxAgeSeconds: 2 } as const
    const observation = { capabilityId: 'world.test.observe', input: { exact: 'pinned-query' }, source: 'owner.md#criteria', maxAgeSeconds: 2 }
    const mismatchedFacts = { targetObjectId: 'plant:unit-2', status: 'satisfied', simulationTime: plantTime,
      evidenceKind: 'engineering-diagnostic', provenance: 'runtime-model', modelRef: 'test.model', modelDigest: 'b'.repeat(64),
      currentValue: { value: 1.2345678901234567, unit: 'kg/s', quality: 'good' } }
    type Decision = NonNullable<ProcedureDocument['steps'][number]['decisions']>[number]
    const cases: { decision: Decision; observation?: Readonly<Record<string, unknown>>; reason: string }[] = [
      { decision: { branchIndex: 0, condition: comparison, applicability }, reason: 'model identity does not match' },
      { decision: { branchIndex: 0, condition: { type: 'held', durationSeconds: 60, condition: comparison }, applicability }, reason: 'continuous evidence' },
      { decision: { branchIndex: 0, condition: { type: 'manual', description: 'Confirm local inspection', tagIds: [], source: 'owner.md#local' }, applicability }, reason: 'Human judgment required' },
      { decision: { branchIndex: 0, observation, applicability }, reason: 'No declared query in this test port' },
      { decision: { branchIndex: 0, observation, applicability }, observation: mismatchedFacts, reason: 'model identity does not match' },
    ]
    for (const scenario of cases) {
      const declared = { ...doc, steps: doc.steps.map((step, index) => index ? step : { ...step, decisions: [scenario.decision] }) }
      const current = await composeProcedureStepView({ run: run(), document: declared, ports: ports({
        ...(scenario.observation === undefined ? {} : { observation: scenario.observation }),
        reads: { 'TRIP-BKR-A': value('TRIP-BKR-A', 'false boolean', { value: false, unit: 'boolean', scopeId: 'plant:unit-2', signalTagId: 'TRIP-BKR-A', writable: false,
          evidence: { kind: 'engineering-diagnostic', provenance: 'runtime-model', sampledAt: plantTime, modelRef: 'test.model', modelDigest: 'b'.repeat(64) } }) },
      }) })
      const original = structuredClone(current), projected = projectProcedureStepGuidance(current, false)
      const { condition: _condition, applicability: _applicability, ...facts } = current.step!.branchAssessments[0]!
      expect(projected.step!.branchAssessments[0]).toEqual(facts)
      expect(facts.status).toBe('unknown')
      expect(facts.reasons.join(' ')).toContain(scenario.reason)
      expect(projected.step!.branchAssessments[0]).not.toHaveProperty('condition')
      expect(projected.step!.branchAssessments[0]).not.toHaveProperty('applicability')
      expect(projected.step!.definition).toEqual(current.step!.definition)
      expect(projected.run).toEqual(current.run)
      expect(procedureStepReadViewSchema.parse(projected)).toEqual(projected)
      expect(current).toEqual(original)
      expect(current.step!.branchAssessments[0]!.applicability).toEqual(applicability)
      if (scenario.observation) expect(projected.step!.branchAssessments[0]!.observation!.result).toEqual(mismatchedFacts)
    }
  })

  test('a missing or unreadable tag is reported with its reason, never dropped', async () => {
    const calls: string[] = []
    const view = await composeProcedureStepView({ run: run(), document: document('csfs-monitored: []'), ports: ports({ calls,
      reads: { 'TRIP-BKR-A': 'missing', 'TRIP-BKR-B': new Error('runtime unavailable'), 'NIS-PR-AVG': 'missing' } }) })
    expect(view.tags).toEqual([
      { id: 'TRIP-BKR-A', description: 'reactor trip breaker A position', binding: 'missing', notes: { 'model-note': 'the model reports closed as a boolean' }, unavailable: 'procedure tag is not bound to this Plant' },
      { id: 'TRIP-BKR-B', description: 'reactor trip breaker B position', binding: 'resolved', unavailable: 'runtime unavailable' },
      { id: 'NIS-PR-AVG', description: 'power range neutron flux average', binding: 'missing', warnings: ['requested percent unavailable'], unavailable: 'procedure tag is not bound to this Plant' },
    ])
    // CSFs only when the procedure monitors them.
    expect(view.csfs).toBeUndefined()
    expect(calls.some(call => call.startsWith('csfs:'))).toBe(false)

    const failed = await composeProcedureStepView({ run: run(), document: document(), ports: ports({ csfs: new Error('assessment query refused') }) })
    expect(failed.csfs).toEqual([
      { id: 'subcriticality', status: 'unknown', reason: 'unavailable: assessment query refused' },
      { id: 'core-cooling', status: 'unknown', reason: 'unavailable: assessment query refused' },
    ])
  })

  test('an explicit step, its decision and observation; an unknown step; the run alone after a transfer or END', async () => {
    const decided = run({
      currentStepId: 'verify-turbine-trip',
      observations: [{ stepId: 'verify-turbine-trip', simulationTime: '2026-10-13T08:00:50.000Z' as IsoTimestamp, result: { status: 'unknown', reason: 'no binding' } }],
      stepStates: [{ stepId: 'verify-reactor-trip', assessment: 'complete', favorite: false, comment: 'x'.repeat(600),
        updatedAt: '2026-10-13T08:00:40.000Z' as IsoTimestamp, updatedBy: 'actor:ai:assistant' as ActorId,
        decision: { branchIndex: 0, label: 'Verified', outcome: 'normal', targetKind: 'step', target: 'verify-turbine-trip', basis: 'Breakers open.',
          evidence: [{ tagId: 'TRIP-BKR-A', reading: 'false' }], selectedBy: 'actor:ai:assistant' as ActorId, selectedByLabel: 'Assistant',
          simulationTime: '2026-10-13T08:00:40.000Z' as IsoTimestamp } }],
    })
    const earlier = await composeProcedureStepView({ run: decided, document: document('csfs-monitored: []'), stepId: 'verify-reactor-trip', ports: ports() })
    expect(earlier.run.stepNumber).toBe(1)
    expect(earlier.step!.state!.decision).toMatchObject({ basis: 'Breakers open.', selectedByLabel: 'Assistant', proof: { kind: 'run-state',
      capabilityId: 'world.procedure.runs.list', input: { includeEvidence: true }, runId: decided.runId, stepId: 'verify-reactor-trip' } })
    expect(earlier.step!.state!.decision).not.toHaveProperty('evidence')
    expect(earlier.step!.state!.comment).toHaveLength(600)
    expect(projectProcedureStepGuidance(earlier, false).step!.state).toEqual(earlier.step!.state)

    const current = await composeProcedureStepView({ run: decided, document: document('csfs-monitored: []'), ports: ports() })
    expect(current.step).toMatchObject({ id: 'verify-turbine-trip', observation: { status: 'unknown', reason: 'no binding', simulationTime: '2026-10-13T08:00:50.000Z' } })
    expect(current.tags).toBeUndefined()
    expect(current.step!.branches).toEqual([{ index: 0, label: 'Verified', outcome: 'normal', targetKind: 'end', target: 'END' }])

    await expect(composeProcedureStepView({ run: decided, document: document(), stepId: 'no-such-step', ports: ports() }))
      .rejects.toMatchObject({ code: procedureStepNotFoundCode })

    const closed = composeProcedureRunView({ run: run({ status: 'completed' }), document: document(), ports: ports() })
    expect(closed).toEqual({ sequence: 42, simulationTime: plantTime,
      run: expect.objectContaining({ status: 'completed', totalSteps: 2 }) })
    expect(closed.step).toBeUndefined()
  })
})
