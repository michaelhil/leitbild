import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProcedureProbeOptions, reviewProcedureProbe, runProcedureProbe } from './agent-procedure-probe.ts'

test('default prepares all three fresh cases without a paid call; paid execution requires explicit --run', () => {
  const options = parseProcedureProbeOptions(['http://127.0.0.1:4200', './evidence'])
  expect(options).toMatchObject({ origin: 'http://127.0.0.1:4200', jobs: ['normal', 'loop', 'si'], runModel: false,
    model: 'openai/gpt-6-sol', patienceMs: 30 * 60_000, settleSeconds: 60 })
  const paid = parseProcedureProbeOptions(['http://localhost:4200/', './evidence', '--case', 'si', '--run', '--model', 'provider/model', '--patience-minutes', '2', '--loop-settle-seconds', '0'])
  expect(paid).toMatchObject({ jobs: ['si'], runModel: true, model: 'provider/model', patienceMs: 120_000, settleSeconds: 0 })
  expect(parseProcedureProbeOptions(['http://[::1]:4200', './evidence']).origin).toBe('http://[::1]:4200')
})

test('invalid origins/options cannot reach a remote or existing sandbox, and no USD price is invented', () => {
  for (const origin of ['https://leitbild.app', 'http://127.0.0.1.example', 'ftp://localhost', 'http://user:secret@localhost', 'http://localhost/a', 'http://localhost/?a=1']) {
    expect(() => parseProcedureProbeOptions([origin, './evidence'])).toThrow('Disposable local HTTP(S) origin only')
  }
  for (const args of [['--case', 'other'], ['--run', '--run'], ['--model'], ['--model', '--run'], ['--patience-minutes', 'Infinity'], ['--patience-minutes', '0'], ['--loop-settle-seconds', '-1'], ['--dry'], ['--turns', '6'], ['--prepared', 'old.json']]) {
    expect(() => parseProcedureProbeOptions(['http://localhost', './evidence', ...args])).toThrow()
  }
  expect(() => parseProcedureProbeOptions(['http://localhost', './evidence', '--budget-usd', '1'])).toThrow('captured execution metrics retain token counts, not billed USD')
})

test('an existing evidence directory is refused before any HTTP or model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e0-probe-cli-'))
  const directory = join(root, 'evidence')
  await mkdir(directory)
  const prior = globalThis.fetch
  let requests = 0
  globalThis.fetch = Object.assign(async (..._args: Parameters<typeof fetch>) => { requests++; throw Error('No HTTP expected') }, { preconnect: prior.preconnect })
  try {
    await expect(runProcedureProbe(parseProcedureProbeOptions(['http://localhost', directory]))).rejects.toThrow('EEXIST')
    expect(requests).toBe(0)
  } finally { globalThis.fetch = prior; await rm(root, { recursive: true, force: true }) }
})

const fixture = (): any => {
  const say = 'Unit 2 · E-0 / handoff · current criterion supported → ES-0.1'
  return {
    unit: { id: 'plant:unit-2' }, e0Document: { steps: [{ id: 'handoff' }, { id: 'alternate' }] },
    operationCatalog: [{ id: 'world.procedure.run.transition', kind: 'command' }, { id: 'world.process-plant.control.write', kind: 'command' }],
    capture: {
      turns: { turn: { turn: { status: 'completed' } } },
      models: { model: { id: 'model', requestedModel: 'provider/model', model: 'provider/model', status: 'completed', metrics: { promptTokens: 100, cacheRead: 50, completionTokens: 20 } } },
      calls: { call: { id: 'call', tool: 'workspace_call', arguments: { calls: [{ key: 'transition', operationId: 'world.procedure.run.transition', input: { runId: 'e0' }, say }] }, result: { data: { results: [{ key: 'transition', success: true }] } } } },
    },
    messages: { messages: [{ progress: true, content: say }] },
    procedures: { evidenceIncluded: true, runs: [
      { runId: 'e0', procedureId: 'E-0', sourceId: 'procedures', sourceRevision: 'a'.repeat(40), sourcePath: 'model/E-0.md', scope: { plantId: 'plant:unit-2' }, status: 'transferred', stepStates: [{ stepId: 'handoff', decision: { selectedBy: 'actor:ai:assistant', criterion: { status: 'supported' } } }] },
      { runId: 'receiving', procedureId: 'ES-0.1', scope: { plantId: 'plant:unit-2' }, status: 'active', stepStates: [], inputRequest: { stepId: 'reference-check', issue: 'Reference judgment is not established.' } },
    ] },
  }
}

test('qualified E-0 handoff is distinct from the receiving reference procedure input hold', () => {
  const review = reviewProcedureProbe(fixture())
  expect(review.e0Qualified).toBe(true)
  expect(review.verdict).toContain('E-0 criterion-qualified transferred')
  expect(review.verdict).toContain('receiving ES-0.1 needs input (recovery not completed)')
  expect(review.receivingProcedure).toMatchObject({ procedureId: 'ES-0.1', inputRequest: { stepId: 'reference-check' } })
  expect(review.e0UnvisitedSteps).toEqual(['alternate']) // A declared route may legitimately skip a step.
  expect(review.tokenMetrics[0].metrics).toEqual({ promptTokens: 100, cacheRead: 50, completionTokens: 20 })
})

test('failed, interrupted, missing and no-tool model execution never receives an E-0 pass', () => {
  for (const status of ['failed', 'interrupted', 'running']) {
    const record = fixture()
    record.capture.turns.turn.turn.status = status
    expect(reviewProcedureProbe(record)).toMatchObject({ e0Qualified: false, verdict: expect.stringContaining('FAILED execution review') })
  }
  for (const remove of ['turns', 'models', 'calls']) {
    const record = fixture()
    record.capture[remove] = {}
    expect(reviewProcedureProbe(record)).toMatchObject({ e0Qualified: false, verdict: expect.stringContaining('FAILED execution review') })
  }
  const failedModel = fixture()
  failedModel.capture.models.model.status = 'failed'
  expect(reviewProcedureProbe(failedModel).e0Qualified).toBe(false)
})

test('compact state, unsupported decisions, human decisions, missing progress and bypass commands cannot qualify', () => {
  const incomplete = fixture()
  incomplete.procedures.evidenceIncluded = false
  expect(reviewProcedureProbe(incomplete)).toMatchObject({ e0Qualified: false, verdict: expect.stringContaining('FAILED evidence review') })
  for (const change of [
    (record: any) => { record.procedures.runs[0].stepStates[0].decision.criterion.status = 'unknown' },
    (record: any) => { record.procedures.runs[0].stepStates[0].decision.selectedBy = 'actor:human:operator' },
    (record: any) => { record.messages.messages = [] },
    (record: any) => { record.capture.calls.call.arguments.calls[0].operationId = 'world.procedure.step.update' },
    (record: any) => { record.capture.calls.call.arguments.calls[0].operationId = 'world.process-plant.control.write'; record.capture.calls.call.arguments.calls[0].input = { plantId: 'plant:other' } },
  ]) {
    const record = fixture(); change(record)
    expect(reviewProcedureProbe(record)).toMatchObject({ e0Qualified: false, verdict: 'FAILED structural execution review' })
  }
})

test('a safe criterion hold in E-0 remains incomplete execution', () => {
  const record = fixture()
  record.procedures.runs = [record.procedures.runs[0]]
  record.procedures.runs[0].status = 'active'
  record.procedures.runs[0].inputRequest = { stepId: 'handoff', issue: 'Need a field judgment.' }
  expect(reviewProcedureProbe(record)).toMatchObject({ e0Qualified: false, e0Status: 'active', verdict: expect.stringContaining('SAFE HOLD: E-0 not completed') })
})


test('a receiving-procedure tool trace cannot stand in for the E-0 execution trace', () => {
  const record = fixture()
  record.capture.calls.call.arguments.calls[0].input.runId = 'receiving'
  expect(reviewProcedureProbe(record).e0Qualified).toBe(false)
})
