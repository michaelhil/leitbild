import { describe, expect, test } from 'bun:test'
import { rescoreRow, type Recorded } from './rescore.ts'
import { KEY_STATUS, plantAction, type EvalScenario, type EvidenceKey } from './scenarios.ts'
import { referencePlantCatalog } from './plant-catalog.ts'
import { summariseOperationOutcomes } from './report.ts'

const key = (text: string, signals: ReadonlyArray<string>): EvidenceKey => ({ key: text, kind: 'signal', signals, rationale: '', status: KEY_STATUS, use: 'P0' })
const scenario: EvalScenario = {
  id: 'x', prompt: 'Unit 2: SG B level?', expect: 'display',
  run: { scenario: 'halden-power-complex', setup: [plantAction('plant:halden-2', 'steam-generator-b-feedwater-runback', { positionPercent: 35 })], advanceMinutes: 3 },
  set: 'holdout', flaky: false, evidence: [key('SG B level', ['SG-B-LVL-NR'])],
}
const recorded: Recorded = {
  scenario,
  row: { id: 'x', decisivePass: true } as never,
  answer: { content: 'Level falls.\n```leitbild-view\nview call_1_0/display\n```' },
  composes: [{
    input: { panels: [{ kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR' }] }] },
    result: { success: true, viewRef: 'call_1_0/display', data: { signals: [{ ref: 'SG-B-LVL-NR', tagId: 'SG-B-LVL-NR', path: 'sgB.levelPercent' }], equipment: [], view: { state: '{}' } } },
  }],
}

describe('re-scoring a recorded stage with corrected keys', () => {
  test('aggregate completion counts only explicit verified success; null remains unqualified and manual cases remain absent', () => {
    expect(summariseOperationOutcomes([
      { id: 'verified', operationCorrect: true }, { id: 'contradicted', operationCorrect: false },
      { id: 'accepted-unverified', operationCorrect: null }, { id: 'missing-evidence', operationCorrect: null }, { id: 'manual' },
    ])).toEqual({ scenarios: 4, correct: 1, judged: 2, unqualified: ['accepted-unverified', 'missing-evidence'] })
  })
  test('a corrected key is scored from the recorded display, with no new run', () => {
    const corrected = { ...scenario, evidence: [key('SG B level', ['SG-B-LVL-NR']), key('feed valve B', ['MFW-B-CV-POS'])] }
    expect(rescoreRow(recorded, corrected)).toMatchObject({ decisiveSignalKeys: 2, decisiveSignalHits: 1, decisivePass: false })
  })

  test('a changed prompt or parameter needs a new run', () => {
    expect(rescoreRow(recorded, { ...scenario, prompt: 'Unit 2: SG B level now?' })).toBeNull()
    expect(rescoreRow(recorded, { ...scenario, run: { ...scenario.run, advanceMinutes: 4 } })).toBeNull()
    expect(rescoreRow(recorded, { ...scenario, run: { ...scenario.run, setup: [plantAction('plant:halden-3', 'steam-generator-b-feedwater-runback', { positionPercent: 35 })] } })).toBeNull()
    expect(rescoreRow(recorded, { ...scenario, run: { ...scenario.run, scenario: 'fixture:integrated-all-packs' } })).toBeNull()
  })

  test('old artifacts without direct receipts or task intent never become successful operation evidence', () => {
    const operating: EvalScenario = { ...scenario, taskIntent: 'operate', operation: {
      plantId: 'plant:halden-2', equipment: 'auxFeedwaterValveA', command: 'AFW-A-CV', tags: ['AFW-A-CV'], named: 'AFW valve A',
      operationId: 'world.process-plant.control.write', intent: 'execute', value: 0.4, feedback: [{ signal: 'AFW-A-CV-POS', value: 0.4 }],
    } }
    expect(rescoreRow({ ...recorded, scenario: operating, operation: { attempts: [] }, proposals: { entries: [] } }, operating)).toBeNull()
    expect(rescoreRow({ ...recorded, scenario: operating, row: { ...recorded.row, operationCorrect: true },
      resource: { workspaceId: 'workspace', moduleId: 'world', type: 'world.simulation-run', id: 'run' }, operations: [], operationsComplete: true }, operating)).toBeNull()
    const readonly = { ...scenario, taskIntent: 'read-only' as const }
    expect(rescoreRow({ ...recorded, scenario: readonly }, readonly)!.directWriteAudit).toMatchObject({ judged: false, unasked: null })
    expect(rescoreRow(recorded, scenario)!.directWriteAudit).toMatchObject({ judged: false, unasked: null })
    expect(rescoreRow(recorded, readonly)).toBeNull()
  })

  test('a new review artifact is judged from its actual native vignette references and pending proposal receipt', () => {
    const review: EvalScenario = { ...scenario, taskIntent: 'review', operation: {
      plantId: 'plant:halden-2', equipment: 'auxFeedwaterValveA', command: 'AFW-A-CV', tags: ['AFW-A-CV'], named: 'AFW valve A',
      operationId: 'world.process-plant.control.propose', intent: 'review', value: 0.4,
    } }
    const resource = { workspaceId: 'workspace', moduleId: 'world', type: 'world.simulation-run', id: 'run' }
    const current: Recorded = { ...recorded, scenario: review, resource, operationsComplete: true, operation: { attempts: [] }, controls: { items: [] },
      answer: { type: 'chat', content: 'I proposed throttling AFW valve A to 40%; it awaits your approval.\n```leitbild-view\nview call_1_0/display\n```' },
      operations: [{ operationId: 'world.process-plant.control.propose', input: { plantId: 'plant:halden-2', tagId: 'AFW-A-CV', value: 0.4 },
        result: { operationId: 'world.process-plant.control.propose', success: true, target: { kind: 'resource', ref: resource }, data: { ok: true, commandId: 'command:proposal' } } }],
      proposals: { entries: [{ id: 'command:proposal', plantId: 'plant:halden-2', path: 'auxFeedwaterValveA.position', value: 0.4, status: 'pending' }] },
      composes: [{ input: { subjects: ['plant:halden-2'] }, result: { success: true, viewRef: 'call_1_0/display', data: {
        view: { viewType: 'display.vignette', state: JSON.stringify({ views: [{ kind: 'values', refs: ['plant:halden-2#auxFeedwaterValveA.effectivePositionFraction'] }] }) },
      } } }],
    }
    // Use the model's exact command path, never an assumed property spelling.
    current.proposals.entries[0].path = referencePlantCatalog().signal('AFW-A-CV')!.path
    expect(rescoreRow(current, review)!.operationCorrect).toBe(true)
  })
})
