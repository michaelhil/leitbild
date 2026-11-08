import { afterEach, expect, test } from 'bun:test'
import { renderCalculation } from './render.ts'
import type { CalculationReceipt } from './model.ts'

// Test-only DOM surface records exactly which elements the renderer creates.
interface Node { tag: string; textContent: string; children: Node[]; attributes: Record<string,string>; append: (...nodes: Node[]) => void; replaceChildren: (...nodes: Node[]) => void; setAttribute: (key:string,value:string) => void; addEventListener: () => void }
const made: Node[] = []
const node = (tag:string): Node => {
  const value: Node = { tag, textContent: '', children: [], attributes: {}, append: (...nodes) => value.children.push(...nodes), replaceChildren: (...nodes) => { value.children = nodes }, setAttribute: (key,item) => { value.attributes[key] = item }, addEventListener: () => {} }
  made.push(value); return value
}
const saved = globalThis.document
afterEach(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: saved }); made.length = 0 })
test('hostile result, title and source text stay inert; failed output is explicit and code stays disclosed', () => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: node, createTextNode: (text:string) => ({ ...node('#text'), textContent: text }) } })
  const hostile = '<img src=x onerror="globalThis.pwned=true">'
  const receipt = { kind: 'engineering-calculation', title: hostile, mode: 'exploratory-script', createdAt: 'now', inputs: [], sources: [], request: { operation: 'run', input: { bindings: [] } }, outcome: { status: 'failed', error: { message: hostile } }, qualification: 'research-only', inputDigest: 'digest', programSource: '<script>evil()</script>' } as CalculationReceipt
  let runs = 0
  renderCalculation(node('main') as unknown as HTMLElement, receipt, [], { run: () => { runs += 1 } })
  expect(runs).toBe(0)
  expect(made.some(item => ['img', 'script', 'iframe', 'a'].includes(item.tag))).toBe(false)
  expect(made.some(item => item.textContent === hostile)).toBe(true)
  expect(made.some(item => item.textContent === 'No program output was retained.')).toBe(true)
  expect(made.some(item => item.attributes.role === 'alert' && item.textContent.includes('failed'))).toBe(true)
  expect(made.some(item => item.tag === 'details' && item.children.some(child => child.tag === 'pre' && child.textContent.includes('<script>')))).toBe(true)
})
