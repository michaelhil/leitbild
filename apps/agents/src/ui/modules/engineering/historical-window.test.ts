import { afterEach, describe, expect, test } from 'bun:test'
import type { EngineeringInputBasis } from '@leitbild/contracts'
import { calculationRequest, snapshotRefreshSupported, type CalculationReceipt } from './model.ts'
import { renderCalculation } from './render.ts'

const source = { workspaceId: '11111111-1111-4111-8111-111111111111', moduleId: 'world', type: 'world.simulation-run', id: 'run-thermal' } as EngineeringInputBasis['source']
const first: EngineeringInputBasis = { source, profile: 'plant-thermal', profileRevision: 'engineering-research-1', subjectId: 'plant:thermal', digest: 'a'.repeat(64),
  frame: { epoch: '22222222-2222-4222-8222-222222222222', scenarioDigest: 'c'.repeat(64), restrictionRevision: 0, sequence: 1, simulationAt: '2026-11-08T12:00:00.000Z', observedAt: '2026-11-08T12:00:01.000Z' },
  quantities: [{ id: 'temperature', label: 'Temperature', quantity: 'temperature', unit: 'degC', value: 180, quality: 'good' }],
}
const later: EngineeringInputBasis = { ...first, digest: 'b'.repeat(64), frame: { ...first.frame, sequence: 2, simulationAt: '2026-11-08T12:01:00.000Z' }, quantities: [{ ...first.quantities[0]!, value: 177 }] }
const receipt = (sources: EngineeringInputBasis[]): CalculationReceipt => ({ kind: 'engineering-calculation', title: 'Captured cooling interval', mode: 'reviewed-method', createdAt: '2026-11-08T12:01:01.000Z', inputs: [
  { name: 'initialTemperature', value: 180, quantity: 'temperature', unit: 'degC', simulationAt: first.frame.simulationAt, origin: 'observation', quality: 'good' },
  { name: 'finalTemperature', value: 177, quantity: 'temperature', unit: 'degC', simulationAt: later.frame.simulationAt, origin: 'observation', quality: 'good' },
], sources, observationRefs: [{ name: 'finalTemperature', basisDigest: later.digest, quantityId: 'temperature' }, { name: 'initialTemperature', basisDigest: first.digest, quantityId: 'temperature' }],
request: { operation: 'calculate', input: { title: 'Captured cooling interval', bindings: [], calculation: { method: 'sample_changes', names: ['initialTemperature', 'finalTemperature'] } } }, outcome: { method: 'sample_changes', qualification: 'arithmetic-only' }, qualification: 'research-only', inputDigest: 'd'.repeat(64),
})

describe('historical observations in the calculation pane', () => {
  test('a historical window cannot become a fresh instant, but still supports explicit rerun', () => {
    const history = receipt([first, later])
    expect(snapshotRefreshSupported(history)).toBe(false)
    expect(() => calculationRequest(history, new Map(), true)).toThrow('historical window')
    expect(calculationRequest(history, new Map(), false)).toEqual(history.request)
    expect(snapshotRefreshSupported(receipt([first, { ...later, frame: { ...first.frame, sequence: 2 } }]))).toBe(false)
  })
  test('source identity is independent of JSON key order; distinct subjects and Runs keep their own instant', () => {
    const reordered = { id: source.id, type: source.type, moduleId: source.moduleId, workspaceId: source.workspaceId }
    expect(snapshotRefreshSupported(receipt([first, { ...later, source: reordered }]))).toBe(false)
    expect(snapshotRefreshSupported(receipt([first, { ...later, subjectId: 'plant:other' }]))).toBe(true)
    expect(snapshotRefreshSupported(receipt([first, { ...later, source: { ...source, id: 'run-other' as typeof source.id } }]))).toBe(true)
    expect(snapshotRefreshSupported(receipt([first, { ...first, digest: 'e'.repeat(64) }]))).toBe(true)
    expect(snapshotRefreshSupported(receipt([]))).toBe(true)
  })
})

interface Node {
  tag: string; textContent: string; children: Node[]; disabled?: boolean; attributes: Record<string,string>
  append: (...nodes: Node[]) => void; replaceChildren: (...nodes: Node[]) => void; setAttribute: (key:string,value:string) => void; addEventListener: () => void
}
const made: Node[] = []
const node = (tag:string): Node => {
  const value: Node = { tag, textContent: '', children: [], attributes: {}, append: (...nodes) => value.children.push(...nodes), replaceChildren: (...nodes) => { value.children = nodes }, setAttribute: (key,item) => { value.attributes[key] = item }, addEventListener: () => {} }
  made.push(value); return value
}
const saved = globalThis.document
afterEach(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: saved }); made.length = 0 })
const testDocument = (): void => { Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: node, createTextNode: (text:string) => ({ ...node('#text'), textContent: text }) } }) }

test('historical pane disables refresh with an explanation, preserves rerun and opens without executing', () => {
  testDocument()
  let runs = 0
  renderCalculation(node('main') as unknown as HTMLElement, receipt([later, first]), [{ allowed: true }, { allowed: true }], { run: () => { runs += 1 } })
  expect(runs).toBe(0)
  expect(made.find(item => item.tag === 'button' && item.textContent === 'Refresh from current Run')?.disabled).toBe(true)
  expect(made.find(item => item.tag === 'button' && item.textContent === 'Rerun these inputs')?.disabled).toBe(false)
  expect(made.some(item => item.textContent.includes('captures one instant and cannot replace this interval'))).toBe(true)
  expect(made.some(item => item.textContent.includes('readings remain from the displayed simulation time'))).toBe(true)
})

test('observation names resolve their exact source digest, not input/source order or a guessed current Run', () => {
  testDocument()
  const other = { ...later, source: { ...source, id: 'run-grid' as typeof source.id }, subjectId: 'grid:engineering' }
  const view = receipt([other, first])
  renderCalculation(node('main') as unknown as HTMLElement, view, [{ allowed: true }, { allowed: true }], { run: () => { throw new Error('Opening must not execute') } })
  const rows = made.filter(item => item.tag === 'tr').map(item => item.children.map(cell => cell.textContent))
  expect(rows).toContainEqual(['finalTemperature', 'run-grid', 'grid:engineering', 'temperature'])
  expect(rows).toContainEqual(['initialTemperature', 'run-thermal', 'plant:thermal', 'temperature'])
  expect(made.find(item => item.tag === 'button' && item.textContent === 'Refresh from current Run')?.disabled).toBe(false)
})
