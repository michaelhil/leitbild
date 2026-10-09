// Cycle breaking: the Eades–Lin–Smyth greedy feedback arc set. Edges that run
// against the resulting node sequence are reversed for layering and drawn as
// return runs. When no source or sink is left, a hub goes first: loops are
// drawn leaving the hub and returning to it, which is the classic loop drawing.
import type { Model } from './model.ts'

/** Per edge, whether it is reversed (a return run). */
export const breakCycles = (model: Model): ReadonlyArray<boolean> => {
  const count = model.nodes.length
  const remaining = new Array<boolean>(count).fill(true)
  const outDegree = new Array<number>(count).fill(0)
  const inDegree = new Array<number>(count).fill(0)
  const outgoing = model.nodes.map(() => [] as number[])
  const incoming = model.nodes.map(() => [] as number[])
  for (const edge of model.edges) {
    outDegree[edge.from]!++
    inDegree[edge.to]!++
    outgoing[edge.from]!.push(edge.to)
    incoming[edge.to]!.push(edge.from)
  }
  const remove = (node: number): void => {
    remaining[node] = false
    for (const to of outgoing[node]!) inDegree[to]!--
    for (const from of incoming[node]!) outDegree[from]!--
  }
  const head: number[] = []
  const tail: number[] = []
  let left = count
  while (left > 0) {
    let changed = true
    while (changed) {
      changed = false
      for (let node = 0; node < count; node++) {
        if (remaining[node] && outDegree[node] === 0) {
          tail.push(node)
          remove(node)
          left--
          changed = true
        }
      }
      for (let node = 0; node < count; node++) {
        if (remaining[node] && inDegree[node] === 0) {
          head.push(node)
          remove(node)
          left--
          changed = true
        }
      }
    }
    if (left === 0) break
    let best = -1
    let bestHub = false
    let bestDelta = -Infinity
    for (let node = 0; node < count; node++) {
      if (!remaining[node]) continue
      const hub = model.nodes[node]!.role === 'hub'
      const delta = outDegree[node]! - inDegree[node]!
      if (best < 0 || (hub && !bestHub) || (hub === bestHub && delta > bestDelta)) {
        best = node
        bestHub = hub
        bestDelta = delta
      }
    }
    head.push(best)
    remove(best)
    left--
  }
  const position = new Array<number>(count)
  ;[...head, ...tail.reverse()].forEach((node, index) => (position[node] = index))
  return model.edges.map(edge => position[edge.from]! > position[edge.to]!)
}
