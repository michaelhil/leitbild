import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { createKnowledge } from '../../knowledge/src/index.ts'
import { createTurnCards } from '../../../apps/agents/src/agents/answer-cards.ts'
import { computeContextBudget, OUTPUT_RESERVE, SAFETY_MARGIN } from '../../../apps/agents/src/agents/budget.ts'
import { fitToolEvidence, formatToolDataForLLM } from '../../../apps/agents/src/agents/evaluation.ts'
import type { ChatRequest } from '../../../apps/agents/src/core/types/llm.ts'
import { DEFAULT_WORKSPACE_PROMPT } from '../../../apps/agents/src/core/workspaces/settings.ts'
import { estimateRequestSize } from '../../../apps/agents/src/llm/request-size.ts'
import { createWorkspaceCapabilityTools, workspaceCallResultForModel } from '../../../apps/agents/src/tools/built-in/workspace-capability-tools.ts'
import { handleWorldModuleApi } from '../../../apps/world/src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createProcedureSourceService } from '../../../apps/world/src/features/procedures/source.ts'
import { procedureRunReadViewSchema, projectProcedureStepGuidance, type ProcedureStepView } from '../../../apps/world/src/features/procedures/step-view.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../../../apps/world/src/packs/process-plant/index.ts'
import { decodeProcessPlantSampleTimeRuns, expandProcessPlantProcedureEvidence, readProcessPlantProcedureEvidence,
  type ProcessPlantProcedureEvidenceFrame, type ProcessPlantSampleTimeRun } from '../../../apps/world/src/packs/process-plant/procedure-evidence-facts.ts'
import { builtinScenarioDefinitions } from '../../../apps/world/src/scenarios/definitions.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from '../../../apps/world/tests/helpers.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation() })

const revision = 'a'.repeat(40), sourceId = 'evidence-context-fixture', procedureId = 'EVIDENCE-CONTEXT'
const plantId = 'plant:halden-2', basisSource = '../basis.md#protocol-only'
const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: plantId, loopCount: 4 }))
const basis = { modelRef: compiled.modelRef, modelDigest: compiled.modelDigest, source: basisSource,
  description: 'Protocol/context fixture only. Its generous finite comparisons are not operating criteria, ES-0.1 qualification or stability claims.' }
const loops = ['A', 'B', 'C', 'D'] as const
const numericSignals = [
  ['NIS-PR-AVG', 'percent'], ['SUB-MARGIN', 'degC'], ['CET-AVG', 'degC'], ['PZR-LVL', 'percent'],
  ['RCS-LEAK-RATE', 'kg/s'], ['CTMT-PR', 'MPa'], ['CTMT-RAD', 'mSv/h'], ['CST-LVL', 'percent'], ['AFW-FLOW', 'kg/s'],
  ...loops.flatMap(loop => [[`SG-${loop}-LVL-NR`, 'percent'], [`SG-${loop}-PRESS`, 'MPa'], [`SG-${loop}-N16`, 'mSv/h'], [`AFW-${loop}-FLOW`, 'kg/s']]),
] as const
const comparison = (tagId: string, unit: string, operator = '<', value: number | boolean = 1e12) => ({ type: 'comparison', signal: { tagId }, operator, value, unit })
const guard = { type: 'all', conditions: [
  ...numericSignals.map(([tagId, unit]) => comparison(tagId, unit)),
  // Repeated independent operands match the full current guard's cardinality;
  // this fixture is intentionally not a second copy of an operating procedure.
  ...loops.flatMap(loop => [comparison(`SG-${loop}-LVL-NR`, 'percent', '>', -1e12), comparison(`SG-${loop}-PRESS`, 'MPa', '>', -1e12)]),
  comparison('PZR-LVL', 'percent', '>', -1e12),
  comparison('TRIP-BKR-A-POS', 'boolean', '==', true), comparison('TRIP-BKR-B-POS', 'boolean', '==', true),
  comparison('ROD-BOTTOM', 'boolean', '==', false), comparison('TURB-STOP-POS', 'fraction', '>', -1e12),
  comparison('PORV-456A-POS', 'fraction', '>', -1e12), comparison('MOV-8000A-POS', 'fraction', '>', -1e12),
  comparison('PSV-8010-OPEN', 'boolean', '==', false),
  ...numericSignals.slice(0, 8).map(([tagId, unit]) => comparison(tagId, unit, '>', -1e12)),
] }
const comparisons = [
  ...numericSignals.map(([tagId, unit]) => ({ signal: { tagId }, statistic: 'maximum', operator: '<', value: 1e12, unit })),
  ...['PZR-LVL', ...loops.map(loop => `SG-${loop}-LVL-NR`)].map(tagId => ({ signal: { tagId }, statistic: 'minimum', operator: '>', value: -1e12, unit: 'percent' })),
]
const observation = (capabilityId: string, input: unknown) => ({ capabilityId, input, source: basisSource, maxAgeSeconds: 0 })
const earlyQuery = { basis, condition: guard, windowSeconds: 5,
  comparisons: loops.map(loop => ({ signal: { path: `sg${loop}.secondaryInventoryKg` }, statistic: 'minimum', operator: '>', value: 0, unit: 'kg' })) }
const monitorQuery = { basis, condition: guard, windowSeconds: 300, comparisons }
const recovery = (tagId: string, unit: string) => observation('world.process-plant.procedure-condition.evaluate', {
  basis, condition: { type: 'all', conditions: [guard, comparison(tagId, unit, '<', -1)] },
})
const decisions = (rows: unknown) => `\`\`\`procedure-decisions\n${JSON.stringify(rows)}\n\`\`\``
const source = `---
type: procedure
procedure-md: 0.7
procedure-id: ${procedureId}
title: Procedure evidence protocol fixture
csfs-monitored: [subcriticality, core-cooling, heat-sink, rcs-integrity, containment, rcs-inventory]
---
# Evidence protocol fixture
This tests real Module acquisition, projection, retained proof and Agent request size. It is not a reactor operating instruction.
## Step 1 [id: acquire]
Check: observe real five-second receiver samples before the protocol monitor.
${decisions([{ branchIndex: 0, observation: observation('world.process-plant.response.evaluate', earlyQuery) }])}
- Samples available [outcome: normal] → #monitor
## Step 2 [id: monitor]
Check: retain all sampled and current deciding facts. Repeat actual thirty-second reviews; no claim of an uninterrupted hold.
${decisions([
  { branchIndex: 0, observation: observation('world.process-plant.response.evaluate', monitorQuery) },
  { branchIndex: 1, observation: recovery('SG-A-LVL-NR', 'percent') },
  { branchIndex: 2, observation: recovery('SG-A-PRESS', 'MPa') },
  { branchIndex: 3, condition: { type: 'manual', description: 'Human disposition of unmodeled context is not implied by this protocol fixture.', tagIds: [], source: basisSource } },
])}
- Reviewed samples [outcome: normal] → #monitor
- Feed deviation [outcome: rno] → #acquire
- Steam deviation [outcome: rno] → #acquire
- Other disposition [outcome: rno] → END
`

type Wire = Record<string, any>
type Message = ChatRequest['messages'][number]
const expanded = (frame: Wire): ReadonlyArray<Wire> => expandProcessPlantProcedureEvidence(frame as ProcessPlantProcedureEvidenceFrame)

const expectSummaryParity = (summary: Wire, full: Wire) => {
  expect(summary.detail).toBe('summary')
  expect(full.detail).toBe('full')
  expect(summary.assessments.map((row: Wire) => row.id)).toEqual(full.assessments.map((row: Wire) => row.id))
  for (const current of summary.assessments as Wire[]) {
    const complete = full.assessments.find((row: Wire) => row.id === current.id)
    const { path, checks, ...facts } = complete
    const { checks: summaryChecks, unresolved, ...currentFacts } = current
    expect(currentFacts).toEqual(facts)
    expect(current).not.toHaveProperty('path')
    expect(summaryChecks).toHaveLength(checks.length)
    for (const [index, check] of checks.entries()) {
      const projection = summaryChecks[index]
      if (check.met !== 'yes') expect(projection).toEqual(check)
      else {
        const { comparisons, ...metadata } = check
        const { unresolved: exceptions, ...actualMetadata } = projection
        expect(actualMetadata).toEqual(metadata)
        const expected = comparisons.filter((row: Wire) => row.answer === 'unknown' || row.reason !== undefined)
        expect(exceptions ?? []).toEqual(expected)
      }
    }
    expect(unresolved).toEqual(path.flatMap((step: Wire) => {
      const comparisons = step.comparisons.filter((row: Wire) => row.answer === 'unknown' || row.reason !== undefined)
      return comparisons.length === 0 ? [] : [{ ...step, comparisons }]
    }))
  }
}

const setup = async (richGuidance = false) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'procedure-evidence-context-'))
  let registry: WorldWorkspaceRuntimeRegistry | undefined
  cleanup.push(async () => { await registry?.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const definition = structuredClone(builtinScenarioDefinitions.find(row => row.id === 'halden-station-blackout')!)
  definition.id = 'evidence-context-protocol'
  definition.title = 'Ordinary full-power protocol fixture'
  definition.timeline = { cues: [] }; definition.objectives = []
  const richSource = source.replace('Check: observe real five-second receiver samples before the protocol monitor.',
    'Check: observe real five-second receiver samples. Read «NIS-PR-AVG», «AFW-A-CV» and «KNOWN-ABSENT-TAG» for the software projection test.') + `
## Tags
- id: NIS-PR-AVG
  description: Native power operand description for the projection test
  sim-path: core.powerRangePercent
  units: percent
  equipment: core
  source: ${basisSource}
  model-note: Authored reference context; acquired quality remains a separate current fact
- id: AFW-A-CV
  description: Writable valve demand; current feedback must remain distinct
  sim-path: auxFeedwaterValveA.positionFraction
  units: fraction
  equipment: auxFeedwaterValveA
  source: ${basisSource}
- id: KNOWN-ABSENT-TAG
  description: Deliberately absent source binding; not an instrument failure
  units: boolean
  source: ${basisSource}
`
  const knowledge = createKnowledge({ revision, documents: [
    { path: `procedures/${procedureId}.md`, content: richGuidance ? richSource : source },
    { path: 'basis.md', content: '# Basis\n## Protocol only\nSoftware protocol and context-size fixture. Not operating criteria or physical ES-0.1 qualification.' },
  ] })
  registry = createWorldWorkspaceRuntimeRegistry({
    dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), scenarioDefinitions: [definition],
    runtimeAdapters: createTestPackRuntimeAdapters(),
    procedureSourceService: createProcedureSourceService({ sources: [{ sourceId, label: 'Protocol fixture', repository: 'test', ref: 'publication', procedurePath: 'procedures' }],
      retentionDirectory: join(dataDir, 'procedure-publications'), loadKnowledge: async () => knowledge }),
  })
  const workspaceId = newWorkspaceId()
  const provision = new Request(`http://world.test/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
  expect((await handleWorldModuleApi(provision, new URL(provision.url), registry))!.status).toBe(201)
  const runtime = registry.getLoaded(workspaceId)!, run = await runtime.simulationRuns.create({ scenarioId: definition.id })
  await run.setClock({ paused: true })
  const actualRegistry = registry
  const cards = createTurnCards(), transcript: Message[] = [{ role: 'user', content: 'Exercise the test-only initial acquisition, then twenty thirty-second reviews. Leave the active procedure paused. This does not qualify physical ES-0.1.' }]
  const recordedCalls: Array<{ capabilityId: string; input: unknown; result: Wire }> = []
  const tools = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'http://host.test', getRoomScope: () => undefined })
    .map(({ name, description, parameters }) => ({ name, description, parameters }))
  // This is the capacity of the actual configured serving model observed for
  // this qualification, not a new product quota or a raised model budget.
  const observedProviderContextMax = 1_050_000
  const budget = computeContextBudget({ contextMax: observedProviderContextMax, toolDefinitions: tools }, text => Math.ceil(text.length / 4))
  let replayTargetOverages = 0
  const invoke = async (capabilityId: string, input: unknown, retain = true, expectedRefusal?: number): Promise<Wire> => {
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'evidence-contract-agent' } })
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, capabilityId,
        resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }),
    })
    const response = (await handleWorldModuleApi(request, new URL(request.url), actualRegistry))!
    const body = await response.json() as Wire
    if (expectedRefusal !== undefined) {
      expect(response.status).toBe(expectedRefusal)
      expect(body).toHaveProperty('error')
      return body
    }
    expect(response.status, JSON.stringify(body).slice(0, 1500)).toBeGreaterThanOrEqual(200)
    expect(response.status, JSON.stringify(body).slice(0, 1500)).toBeLessThan(300)
    const result = body.result as Wire
    if (retain) {
      const id = `call_${recordedCalls.length}_0`
      const raw = { success: true, data: { results: [{ key: 'result', operationId: capabilityId, success: true, data: result }] } }
      const formatted = formatToolDataForLLM(workspaceCallResultForModel(raw, cards).data)
      const assistant: Message = { role: 'assistant', content: '', toolCalls: [{ id, function: { name: 'workspace_call', arguments: { calls: [{ key: 'result', operationId: capabilityId, input }] } } }] }
      const tool: Message = { role: 'tool', name: 'workspace_call', toolCallId: id, content: formatted }
      const priorLength = transcript.length
      const fitted = fitToolEvidence(transcript, assistant, [tool], budget.budget, 0, 0)
      expect(fitted.droppedHistory).toBe(0)
      expect(transcript.length).toBe(priorLength + 2)
      expect(transcript.at(-1)).toEqual(tool)
      if (fitted.overBudget) replayTargetOverages++
      recordedCalls.push({ capabilityId, input, result })
    }
    return result
  }
  const advance = async (seconds: number) => {
    const started = await invoke('world.simulation-run.execution.advance', { minutes: seconds / 60, onComplete: 'pause' })
    const target = started.acceleration.targetSimulationTime
    let waited = await invoke('world.simulation-run.wait', { untilSimulationTime: target })
    while (waited.reason === 'timeout') waited = await invoke('world.simulation-run.wait', { untilSimulationTime: target })
    expect(waited.reason).toBe('simulation-time')
    while ((await runtime.simulationRuns.executionStatus(run.id)).acceleration?.status === 'running') await new Promise<void>(resolve => setImmediate(resolve))
    expect(run.snapshot().clock!.paused).toBe(true)
  }
  return { run, invoke, advance, transcript, recordedCalls, tools, observedProviderContextMax, replayTargetOverages: () => replayTargetOverages }
}

describe('procedure evidence across World and the Agent protected turn', () => {
  test('complete operational evidence, notes and waits fit the configured capacity without replay truncation, while exact proofs remain discoverable', async () => {
    expect(comparisons).toHaveLength(30)
    expect(new Set(comparisons.map(row => row.signal.tagId)).size).toBe(25)
    const f = await setup()
    const started = await f.invoke('world.procedure.run.start', { sourceId, procedureId, scope: { plantId } })
    const runId = started.pinned.runId
    const read = (includeGuidance = false) => f.invoke('world.procedure.run.step.read', { runId, includeGuidance })
    let previousComment: string | undefined
    const note = async (label: string) => {
      const comment = `${label}; actual simulation time ${f.run.snapshot().clock!.currentTime}; retained observations are sampled, not continuous. `
        + 'Current review uses every receiver, source, physical flow, pressure, subcooling and integrity operand; unavailable or challenged operands remain explicit. '.repeat(4)
      expect(comment.length).toBeGreaterThan(500)
      const ack = await f.invoke('world.procedure.step.update', { runId, stepId: label.startsWith('initial') ? 'acquire' : 'monitor', comment })
      expect(ack.ok).toBe(true)
      expect(ack).not.toHaveProperty('next')
      expect(f.run.snapshot().procedures!.runs.find(run => run.runId === runId)!.stepStates.find(step => step.stepId === (label.startsWith('initial') ? 'acquire' : 'monitor'))!.comment).toBe(comment)
      previousComment = comment
    }
    const select = async (stepId: string) => f.invoke('world.procedure.run.transition', { runId, stepId, branchIndex: 0, basis: 'Supported sampled test-protocol evidence; no physical operating qualification.' })
    // Initial response uses real advancing five-second acquisitions and full
    // note acknowledgements, rather than replaying one manufactured frame.
    for (let index = 0; index < 26; index++) {
      await f.advance(5)
      const view = await read()
      expect(view.guidanceIncluded).toBe(false)
      expect(view.step).not.toHaveProperty('blocks')
      expect(view.step).not.toHaveProperty('branches')
      if (index === 0 || index === 25) {
        const full = await f.invoke('world.procedure.run.step.read', { runId }, false)
        expect(view).toEqual(projectProcedureStepGuidance(full as ProcedureStepView, false))
      }
      if (previousComment !== undefined) expect(view.step.state.comment).toBe(previousComment)
      expect(view.step.branchAssessments[0].status).toBe(index === 0 ? 'unknown' : 'supported')
      if (index === 0) expect(view.step.branchAssessments[0].observation.result.evidence.every((row: Wire) => row.reason.includes('left boundary'))).toBe(true)
      await note(`initial review ${index + 1}`)
    }
    const entered = await select('acquire')
    expect(entered.next).not.toHaveProperty('guidanceIncluded')
    expect(entered.next.step.id).toBe('monitor')
    expect(entered.next.step.blocks.length).toBeGreaterThan(0)
    expect(entered.next.step.branches).toHaveLength(4)
    const initialCallCount = f.recordedCalls.length
    const pinned = entered.next.step.definition
    const discovered = await f.invoke(pinned.capabilityId, pinned.input)
    const authored = discovered.steps[0].decisions.find((row: Wire) => row.branchIndex === 0).observation.input
    expect(authored).toEqual(monitorQuery)
    const guardQuery = { targetObjectId: plantId, condition: authored.condition, basis: authored.basis }
    const assess = async () => {
      const current = await f.invoke('world.process-plant.procedure-condition.evaluate', guardQuery)
      expect(current.status).toBe('satisfied')
      expect(current.evidence).toHaveLength(49)
      expect(current.readings).toHaveLength(32)
      const facts = expanded(current)
      expect(new Set(facts.map((row: Wire) => row.variable.path)).size).toBe(32)
      expect(facts.every((row: Wire) => row.quality.status === 'good' && row.comparison && row.variable && row.reference)).toBe(true)
      const functions = await f.invoke('world.process-plant.assessments.evaluate', { plantId, detail: 'summary' })
      expect(functions.assessments).toHaveLength(6)
      expect(functions.assessments.every((row: Wire) => row.status === 'green' || row.status === 'not-monitored')).toBe(true)
      expectSummaryParity(functions, await f.invoke(functions.inspect.capabilityId, functions.inspect.input, false))
      const selectedSignal = facts.find((row: Wire) => row.reference.tagId === 'SG-A-LVL-NR')!.variable.path
      const capture = await f.invoke('world.simulation-run.history-series.list', { subjectId: plantId, signalId: selectedSignal })
      // Capture health and this one actual series selection are checked before
      // advancing. This does not establish the complete 25-series window;
      // every required series is independently qualified when that window is due.
      expect(capture.status.captureState).toBe('recording')
      expect(capture.status.lastError).toBeNull()
      expect(capture.status.discardedSinceOpen).toBe(0)
      expect(capture.total).toBe(1)
      expect(capture.hasMore).toBe(false)
      expect(capture.series[0]).toMatchObject({ subjectId: plantId, signalId: selectedSignal })
      return current
    }
    // Initial admission and each later advance have actual current evidence.
    // A clock-only wait does not ask World to evaluate an unfinished 300s
    // history and both recovery branches at every intermediate checkpoint.
    await assess()
    let firstLocator: Wire | undefined, canonicalProof: Wire | undefined
    previousComment = undefined
    for (let review = 1; review <= 20; review++) {
      await f.advance(30)
      const guardRead = await assess()
      await note(`monitor review ${review}`)
      if (review % 10 !== 0) continue
      const latestView = await read()
      if (previousComment !== undefined) expect(latestView.step.state.comment).toBe(previousComment)
      expect(latestView.step.branchAssessments.map((row: Wire) => row.status)).toEqual(['supported', 'contradicted', 'contradicted', 'unknown'])
      const current = latestView.step.branchAssessments[0]
      expect(current.observation).not.toHaveProperty('input')
      expect(current.observation.result.evidence).toHaveLength(30)
      expect(current.observation.result.recordings).toHaveLength(25)
      expect(current.observation.result.current.evidence).toHaveLength(49)
      expect(current.observation.result.current.readings).toHaveLength(32)
      expect(current.observation.result.current.evidence).toEqual(guardRead.evidence)
      expect(current.observation.result.current.readings).toEqual(guardRead.readings)
      expect(expanded(current.observation.result.current)).toEqual(expanded(guardRead))
      for (const recording of current.observation.result.recordings as Wire[]) {
        const offsets = decodeProcessPlantSampleTimeRuns(recording.sampleTimeRuns as ProcessPlantSampleTimeRun[])
        expect(offsets).toHaveLength(recording.storedSampleCount)
        expect(recording).not.toHaveProperty('sampleOffsetsMs')
        expect(recording.signal.path).toBeString()
        expect(recording.quality.status).toBe('good')
        expect(recording.maximumGapMs).toBeLessThanOrEqual(recording.maximumRecognizedGapMs)
        expect(recording.integratedSpanSeconds).toBeGreaterThanOrEqual(300)
        expect(recording.firstSequence).toBeLessThanOrEqual(recording.lastSequence)
      }
      if (review === 20) {
        expect(latestView.step.state.decision).not.toHaveProperty('criterion')
        expect(latestView.step.state.decision).not.toHaveProperty('evidence')
        expect(latestView.step.state.decision.criterionStatus).toBe('supported')
        expect(latestView.step.state.decision.proof).toMatchObject({ kind: 'event', capabilityId: 'world.procedure.decision.read' })
      }
      const selected = await select('monitor')
      if (firstLocator === undefined) {
        firstLocator = JSON.parse(selected.view.state)
        const originalProof = await f.invoke('world.procedure.decision.read', firstLocator, false)
        expect(originalProof.event.criterion.observation.input).toEqual(monitorQuery)
        expect(originalProof.event.criterion.observation.result.recordings).toHaveLength(25)
        canonicalProof = structuredClone(originalProof)
        expect(originalProof.event).toEqual(f.run.events().find(event => event.id === originalProof.event.id))
      }
    }
    if (firstLocator === undefined || canonicalProof === undefined) throw new Error('Both actual sampled episode decisions must have been acquired')
    expect(await f.invoke('world.procedure.decision.read', firstLocator, false)).toEqual(canonicalProof)
    const last = await read()
    expect(last.step.state.comment).toBe(previousComment)
    expect(Date.parse(last.step.state.decision.simulationTime) - Date.parse(canonicalProof.event.simulationTime)).toBe(300_000)
    expect(last.step.definition).toEqual({ capabilityId: 'world.procedure.document.read', input: {
      sourceId, procedureId, sourceRevision: revision, sourcePath: `procedures/${procedureId}.md`, stepId: 'monitor',
    } })
    const detailed = await f.invoke(last.step.definition.capabilityId, last.step.definition.input, false)
    expect(JSON.stringify(detailed)).toContain('comparisons')
    expect(JSON.stringify(detailed)).toContain(compiled.modelDigest)
    // clock.updatedAt is a wall-clock clock/acquisition stamp; compare
    // physical time, pause, objects and procedure state instead.
    const before = structuredClone(f.run.snapshot()), eventCount = f.run.events().length
    const direct = await f.invoke('world.process-plant.response.evaluate', { targetObjectId: plantId, ...monitorQuery }, false)
    const projected = (await f.invoke('world.procedure.run.step.read', { runId }, false)).step.branchAssessments[0].observation.result
    expect(projected).toEqual(direct)
    const after = f.run.snapshot()
    expect(after.objects).toEqual(before.objects)
    expect(after.procedures).toEqual(before.procedures)
    expect(after.clock!.currentTime).toBe(before.clock!.currentTime)
    expect(after.clock!.paused).toBe(before.clock!.paused)
    expect(f.run.events()).toHaveLength(eventCount)
    expect(last).toMatchObject({ paused: true, run: { runId, currentStepId: 'monitor', status: 'active' } })
    const runnerSkill = await readFile(new URL('../../../apps/agents/skills/procedure-runner/SKILL.md', import.meta.url), 'utf8')
    const request: ChatRequest = { model: 'configured-capacity-fixture', messages: f.transcript,
      tools: f.tools.map(definition => ({ type: 'function', function: definition })),
      systemBlocks: [{ text: DEFAULT_WORKSPACE_PROMPT }, { text: runnerSkill },
        { text: 'Software protocol context fixture. All active-turn tool evidence is protected; discovery supplies static metadata and canonical historical proofs on demand.' }] }
    const size = estimateRequestSize(request)
    const bytes = (value: unknown) => JSON.stringify(value)?.length ?? 0
    const byOperation: Record<string, { calls: number; initialBytes: number; monitoringBytes: number }> = {}
    f.recordedCalls.forEach((call, index) => {
      const entry = byOperation[call.capabilityId] ??= { calls: 0, initialBytes: 0, monitoringBytes: 0 }
      entry.calls++
      entry[index < initialCallCount ? 'initialBytes' : 'monitoringBytes'] += bytes(call.result)
    })
    const stepFields: Record<string, number> = {}
    const initialFields: Record<string, number> = {}
    const addInitial = (key: string, value: unknown) => { initialFields[key] = (initialFields[key] ?? 0) + bytes(value) }
    for (const call of f.recordedCalls.filter(call => call.capabilityId === 'world.procedure.run.step.read' && call.result.step?.id === 'acquire')) {
      const view = call.result
      for (const [key, value] of Object.entries({ all: view, blocks: view.step.blocks, branches: view.step.branches, tags: view.tags,
        csfs: view.csfs, state: view.step.state, definition: view.step.definition, run: view.run, branchAssessments: view.step.branchAssessments })) addInitial(key, value)
      for (const branch of view.step.branchAssessments as Wire[]) {
        addInitial('assessment.readings', branch.readings)
        addInitial('assessment.condition', branch.condition)
        addInitial('assessment.applicability', branch.applicability)
        const response = branch.observation?.result
        if (response === undefined) continue
        addInitial('observation.result', response)
        addInitial('response.current', response.current)
        addInitial('response.current.readings', response.current.readings)
        addInitial('response.current.evidence', response.current.evidence)
        addInitial('response.recordings', response.recordings)
        addInitial('response.evidence', response.evidence)
      }
    }
    let currentFactCharacters = 0, uniqueCurrentFactCharacters = 0
    const add = (key: string, value: unknown) => { stepFields[key] = (stepFields[key] ?? 0) + bytes(value) }
    const readViews = f.recordedCalls.map(call => call.result.next ?? call.result).filter(result => result.step !== undefined)
    for (const view of readViews) {
      const uniqueCurrentFacts = new Set<string>()
      add('step.blocks', view.step.blocks)
      add('step.branches', view.step.branches)
      add('step.state', view.step.state)
      add('tags', view.tags)
      add('csfs', view.csfs)
      for (const branch of view.step.branchAssessments as Wire[]) {
        const observation = branch.observation?.result
        if (observation === undefined) continue
        add('branch.observation.result', observation)
        add('branch.observation.recordings', observation.recordings)
        add('branch.observation.sampledEvidence', observation.recordings === undefined ? undefined : observation.evidence)
        const currentFrame = observation.current ?? observation
        const leaves = expanded(currentFrame)
        add('branch.current.readings', currentFrame.readings)
        add('branch.current.comparisonLeaves', currentFrame.evidence)
        add('expanded.current.leaves', leaves)
        for (const reading of currentFrame.readings) {
          add('reading.signal', reading.signal)
          add('reading.variable', reading.variable)
          add('reading.quality', reading.quality)
        }
        for (const leaf of leaves) {
          const facts = JSON.stringify({ reference: leaf.reference, signal: leaf.signal, variable: leaf.variable, quality: leaf.quality,
            provenance: leaf.provenance, instrumentationValidity: leaf.instrumentationValidity, rangeValidity: leaf.rangeValidity })
          currentFactCharacters += facts.length
          uniqueCurrentFacts.add(facts)
          add('leaf.comparison', leaf.comparison)
        }
      }
      uniqueCurrentFactCharacters += [...uniqueCurrentFacts].reduce((sum, facts) => sum + facts.length, 0)
    }
    console.info('procedure-evidence-context contributors', JSON.stringify({ byOperation, stepFields, initialFields, readViews: readViews.length,
      currentFactCharacters, uniqueCurrentFactCharacters, duplicateCurrentFactCharactersWithinViews: currentFactCharacters - uniqueCurrentFactCharacters,
      outputCharacters: f.transcript.filter(message => message.role === 'tool').reduce((sum, message) => sum + message.content.length, 0),
      argumentCharacters: f.transcript.filter(message => message.role === 'assistant').reduce((sum, message) => sum + bytes(message.toolCalls), 0) }))
    expect(f.replayTargetOverages()).toBeGreaterThan(0)
    expect(f.transcript.filter(message => message.role === 'tool')).toHaveLength(f.recordedCalls.length)
    expect(f.transcript.filter(message => message.role === 'assistant')).toHaveLength(f.recordedCalls.length)
    console.info('procedure-evidence-context qualification', JSON.stringify({ protocolFixture: true, reviews: 20, initialFiveSecondReviews: 26,
      sampledComparisons: 30, sampledSeries: 25, actualToolResults: f.recordedCalls.length, estimatedInputTokens: size.estimatedInputTokens,
      providerContextMax: f.observedProviderContextMax, historyReplayTargetOverages: f.replayTargetOverages(), protectedMessagesDropped: 0,
      limitation: 'Transparent production size estimate, not provider-tokenizer or physical ES-0.1 qualification; no production quota added.' }))
    expect(size.estimatedInputTokens + OUTPUT_RESERVE + SAFETY_MARGIN).toBeLessThan(f.observedProviderContextMax)
  }, 120_000)

  test('operational CSF status and full inspection agree before and during an actual shutdown transient', async () => {
    const f = await setup()
    for (const tripped of [false, true]) {
      if (tripped) {
        await f.invoke('world.process-plant.control.write', { plantId, tagId: 'RX-TRIP-MAN', value: true })
        await f.advance(3)
      }
      const summary = await f.invoke('world.process-plant.assessments.evaluate', { plantId, detail: 'summary' })
      const full = await f.invoke(summary.inspect.capabilityId, summary.inspect.input, false)
      expectSummaryParity(summary, full)
      expect(full.assessments.every((row: Wire) => Array.isArray(row.path))).toBe(true)
      if (tripped) expect(summary.assessments.some((row: Wire) => row.status === 'red')).toBe(true)
      expect(f.run.snapshot().clock!.paused).toBe(true)
    }
  }, 30_000)

  test('current reading references preserve unknown comparisons and actual I&C state without a legacy shape fallback', async () => {
    const f = await setup()
    const missing = { tagId: 'MISSING-EVIDENCE-FIXTURE' }
    const refused = await f.invoke('world.process-plant.procedure-condition.evaluate', { targetObjectId: plantId, basis,
      condition: { type: 'comparison', signal: missing, operator: '>', value: 0, unit: 'kg/s' } }, false, 404)
    expect(refused.error.code).toBe('capability_target_not_found')
    // Admission does not fabricate a reading for a nonexistent tag. A real
    // existing signal with a wrong requested unit is an explicit unknown leaf.
    const response = await f.invoke('world.process-plant.procedure-condition.evaluate', { targetObjectId: plantId, basis,
      condition: { type: 'all', conditions: [guard, { type: 'comparison', signal: { tagId: 'NIS-PR-AVG' }, operator: '>', value: 0, unit: 'kg/s' },
        { type: 'ic-rule-state', ruleId: 'safety-injection-manual', field: 'latched', value: false, source: basisSource }] } })
    expect(response.status).toBe('unknown')
    expect(response.evidence).toHaveLength(51)
    expect(response.readings).toHaveLength(32)
    const facts = expanded(response)
    const unresolved = facts.find(row => row.reference?.tagId === 'NIS-PR-AVG' && row.comparison.unit === 'kg/s')!
    expect(unresolved.status).toBe('unknown')
    expect(unresolved.quality.status).toBe('good')
    expect(unresolved.reason).toBeString()
    expect(unresolved.variable.unit).toBe('percent')
    expect(facts.at(-1)).toMatchObject({ type: 'ic-rule-state', ruleId: 'safety-injection-manual', field: 'latched', value: false, status: 'satisfied' })
    expect(facts.at(-1)).not.toHaveProperty('readingIndex')
    const first = response.evidence[0]
    expect(readProcessPlantProcedureEvidence(response as ProcessPlantProcedureEvidenceFrame, first.readingIndex)).toEqual(response.readings[first.readingIndex])
    expect(() => readProcessPlantProcedureEvidence(response as ProcessPlantProcedureEvidenceFrame, -1)).toThrow()
    expect(() => expanded({ readings: response.readings, evidence: [{ ...first, readingIndex: response.readings.length }] })).toThrow()
    expect(() => expanded({ readings: response.readings, evidence: [{ ...first, reference: { tagId: 'SG-A-PRESS' } }] })).toThrow()
    expect(() => expanded({ readings: response.readings, evidence: [{ ...first, reference: { path: 'sgA.pressureMPa' } }] })).toThrow()
    expect(() => expanded({ evidence: facts })).toThrow()
    expect(() => expanded({ readings: [], evidence: response.evidence })).toThrow()
    const existingExternalReference = await f.invoke('world.process-plant.procedure-condition.evaluate', { targetObjectId: plantId, basis,
      condition: { type: 'comparison', signal: { tagId: 'nis.power_range.avg' }, operator: '>', value: 0, unit: 'percent' } })
    expect(existingExternalReference.status).toBe('satisfied')
    expect(expanded(existingExternalReference)[0]).toMatchObject({ reference: { tagId: 'nis.power_range.avg' }, signal: { tagId: 'NIS-PR-AVG' }, quality: { status: 'good' } })
  }, 30_000)

  test('known-step guidance projection preserves actual tag caveats, missing bindings, comments and default full recovery through both public reads', async () => {
    const f = await setup(true)
    const started = await f.invoke('world.procedure.run.start', { sourceId, procedureId, scope: { plantId } })
    const runId = started.pinned.runId
    await f.invoke('world.procedure.step.update', { runId, stepId: 'acquire', comment: 'Retain this actual operator note and its timing anchors.' })
    const full = await f.invoke('world.procedure.run.step.read', { runId })
    const lean = await f.invoke('world.procedure.run.step.read', { runId, includeGuidance: false })
    expect(lean).toEqual(projectProcedureStepGuidance(full as ProcedureStepView, false))
    expect(lean.guidanceIncluded).toBe(false)
    expect(lean.step.branchAssessments).toEqual(full.step.branchAssessments)
    expect(lean.step.state).toEqual(full.step.state)
    expect(lean.run).toEqual(full.run)
    expect(lean.csfs).toEqual(full.csfs)
    expect(lean.step.definition).toEqual(full.step.definition)
    expect(full.tags.some((row: Wire) => row.description && row.notes)).toBe(true)
    for (const tag of full.tags as Wire[]) {
      const { description: _description, notes: _notes, ...facts } = tag
      expect(lean.tags.find((row: Wire) => row.id === tag.id)).toEqual(facts)
    }
    expect(lean.tags.find((row: Wire) => row.id === 'AFW-A-CV').reading.note).toContain('Writable command or demand')
    expect(lean.tags.find((row: Wire) => row.id === 'KNOWN-ABSENT-TAG').unavailable).toBeString()
    const waited = await f.invoke('world.simulation-run.wait', { untilSimulationTime: full.simulationTime, procedureRunId: runId, includeGuidance: false })
    expect(waited.next).toEqual(lean)
    const defaultAgain = await f.invoke('world.procedure.run.step.read', { runId })
    expect(defaultAgain).toEqual(full)
    expect(defaultAgain).not.toHaveProperty('guidanceIncluded')
    const badWait = await f.invoke('world.simulation-run.wait', { untilSimulationTime: full.simulationTime, includeGuidance: false }, false, 400)
    expect(badWait.error.code).toBe('invalid_request')
    const delivered = JSON.parse(f.transcript.findLast(message => message.role === 'tool' && message.content.includes('"guidanceIncluded":false'))!.content)
    expect(delivered.results[0].data.guidanceIncluded ?? delivered.results[0].data.next.guidanceIncluded).toBe(false)
    const observations = spyOn(f.run, 'procedureObservations')
    try {
      const before = structuredClone(f.run.snapshot())
      const control = await f.invoke('world.procedure.run.read', { runId })
      expect(control).toEqual(procedureRunReadViewSchema.parse(control))
      expect(control).toMatchObject({ observationsAcquired: false, sequence: before.seq, simulationTime: before.clock!.currentTime, paused: true })
      expect(control.run).toEqual(full.run)
      const canonical = before.procedures!.runs.find(run => run.runId === runId)!.stepStates.find(step => step.stepId === 'acquire')!
      expect(control.step.state).toEqual(canonical)
      expect(control.step.definition).toEqual(full.step.definition)
      expect(control).not.toHaveProperty('tags')
      expect(control).not.toHaveProperty('csfs')
      expect(control.step).not.toHaveProperty('branchAssessments')
      expect(control.step).not.toHaveProperty('blocks')
      expect(observations).not.toHaveBeenCalled()
      expect(f.run.snapshot().procedures).toEqual(before.procedures)
      expect(f.run.snapshot().objects).toEqual(before.objects)
      expect(f.run.snapshot().seq).toBe(before.seq)
      const modelRead = JSON.parse(f.transcript.at(-1)!.content)
      expect(modelRead.results[0].data).toEqual(control)
      expect(modelRead.results[0].data.step.state.comment).toBe(canonical.comment)
    } finally { observations.mockRestore() }
  }, 30_000)
})
