import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { diagramCandidates, type DiagramGraph, type DiagramProfile } from '../src/features/displays/diagram/index.ts'

// Captured engine input from a real core detail after independent injection
// returns were added. A downstream strand was already last in every layer;
// the former retry selected it forever instead of resolving the actual cycle.
const input: { graph: DiagramGraph; profile: DiagramProfile } = JSON.parse(readFileSync(new URL('./fixtures/diagrams/shared-strand-cycle.json', import.meta.url), 'utf8'))
const room = { maxWidth: 1488, maxHeight: 912 }

test('conflicting shared strands terminate by resolving actual cycles, retaining the complete graph and existing quality rules', () => {
  expect(input.graph.nodes).toHaveLength(40)
  expect(input.graph.edges).toHaveLength(47)
  const before = structuredClone(input), candidates = diagramCandidates(input.graph, input.profile)
  // This wide scope crosses too many pipes. The ordinary scope ladder can
  // now try a nearer/one-service detail instead of blocking the UI forever.
  expect(candidates.layout(room)).toEqual({ ok: false, reasons: [{ kind: 'density', limit: 'crossings', count: 40, max: 12 }] })
  expect(candidates.leastHeight(room.maxWidth)).toBeNull()
  expect(input).toEqual(before)
  const ids = new Map(input.graph.nodes.map((node, index) => [node.id, `renamed-${index}`]))
  const renamed: DiagramGraph = { nodes: [...input.graph.nodes].reverse().map(node => ({ ...node, id: ids.get(node.id)! })), edges: [...input.graph.edges].reverse().map((edge, index) => ({ ...edge, id: `edge-${index}`, from: { ...edge.from, node: ids.get(edge.from.node)! }, to: { ...edge.to, node: ids.get(edge.to.node)! } })) }
  expect(diagramCandidates(renamed, input.profile).layout(room)).toEqual(candidates.layout(room))
})
