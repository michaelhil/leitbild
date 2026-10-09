// Channel routing between layers. Each step of a chain that changes its cross
// position runs along one track of the channel it passes; edges of one net
// share a track (a tee). A vertical-constraint graph orders the tracks: a run
// rising from inside another net's span must sit above it, or it crosses it.
// A constraint cycle is broken where it must be, and costs one crossing.
// Tracks are then packed left-edge style. A channel without any crossing may
// use half-grid track pitch.
import type { DiagramProfile } from './diagram.ts'
import type { Layering } from './layering.ts'
import type { Model } from './model.ts'
import type { Structure } from './structure.ts'

export type PinSide = 'low' | 'high' | 'side'

export interface Jog {
  readonly chain: number
  readonly step: number
  readonly channel: number
  readonly net: number
  readonly pins: readonly [{ readonly c: number; readonly side: PinSide }, { readonly c: number; readonly side: PinSide }]
}

export interface ChannelPlan {
  /** Per chain and step, the jog it makes, or null when it runs straight across its channel. */
  readonly jog: ReadonlyArray<ReadonlyArray<Jog | null>>
  /** Per chain and step, the channel it passes. */
  readonly channelOf: ReadonlyArray<ReadonlyArray<number>>
  /** Per jog key `${channel}:${net}`, its track (0 = most upstream). */
  readonly track: ReadonlyMap<string, number>
  /** Per channel: track count and pitch. */
  readonly tracks: ReadonlyArray<number>
  readonly pitch: ReadonlyArray<number>
  /**
   * Per channel: no crossing lies in it, so its tracks may sit half a grid
   * apart and half a grid from the symbol faces: no crossing gap needs room
   * beside a bend there.
   */
  readonly fine: ReadonlyArray<boolean>
}

export const trackKey = (channel: number, net: number): string => `${channel}:${net}`

export const planChannels = (input: {
  readonly model: Model
  readonly profile: DiagramProfile
  readonly layering: Layering
  readonly structure: Structure
  readonly pin: ReadonlyArray<ReadonlyArray<number>>
}): ChannelPlan => {
  const { model, profile, layering, structure, pin } = input
  const items = layering.items
  const isHub = (item: number): boolean => items[item]!.node !== null && model.nodes[items[item]!.node!]!.role === 'hub'
  const channelCount = layering.layerCount + 1
  const jogs: Jog[][] = Array.from({ length: channelCount }, () => [])
  const passes: number[][] = Array.from({ length: channelCount }, () => [])
  const jog: Array<Array<Jog | null>> = []
  const channelOf: number[][] = []
  layering.chains.forEach((chain, index) => {
    const row: Array<Jog | null> = []
    const channels: number[] = []
    chain.steps.forEach((step, k) => {
      const p = chain.items[k]!
      const q = chain.items[k + 1]!
      const layer = items[p]!.layer
      const channel = step === 'next' ? layer + 1 : step === 'turnAbove' ? layer + 1 : layer
      const sideOf = (item: number, own: PinSide): PinSide => (isHub(item) ? 'side' : own)
      const a = { c: pin[index]![k]!, side: sideOf(p, step === 'turnBelow' ? 'high' : 'low') }
      const b = { c: pin[index]![k + 1]!, side: sideOf(q, step === 'turnAbove' ? 'low' : 'high') }
      channels.push(channel)
      if (step === 'next' && a.side !== 'side' && b.side !== 'side' && a.c === b.c) {
        passes[channel]!.push(a.c)
        row.push(null)
        return
      }
      const entry: Jog = { chain: index, step: k, channel, net: structure.net[chain.edge]!, pins: [a, b] }
      jogs[channel]!.push(entry)
      row.push(entry)
    })
    jog.push(row)
    channelOf.push(channels)
  })

  const track = new Map<string, number>()
  const tracks: number[] = []
  const pitch: number[] = []
  const fine: boolean[] = []
  const halfAllowed = profile.grid / 2 >= profile.pipe.outline + 4 && profile.grid / 2 >= profile.pipe.cornerRadius
  jogs.forEach((list, channel) => {
    const nets = [...new Set(list.map(entry => entry.net))].sort((a, b) => a - b)
    const pinsOf = new Map(nets.map(net => [net, list.filter(entry => entry.net === net).flatMap(entry => entry.pins)]))
    const spanOf = new Map(nets.map(net => {
      const cs = pinsOf.get(net)!.map(p => p.c)
      return [net, [Math.min(...cs), Math.max(...cs)] as const]
    }))
    const inside = (c: number, net: number): boolean => c >= spanOf.get(net)![0] && c <= spanOf.get(net)![1]
    // Constraint "x above y": a riser of x rising from inside y's span, or
    // one of y's coming up from below inside x's. Where both nets have a pin
    // at the same position the constraint is hard: broken, the two risers
    // would run along each other instead of crossing.
    const constraints = new Map<string, { above: number; below: number; hard: boolean }>()
    const require = (above: number, below: number, hard: boolean): void => {
      const key = `${above}>${below}`
      const known = constraints.get(key)
      constraints.set(key, { above, below, hard: hard || (known?.hard ?? false) })
    }
    for (const x of nets) {
      for (const y of nets) {
        if (x === y) continue
        for (const p of pinsOf.get(x)!) {
          if (!inside(p.c, y) || p.side === 'side') continue
          const hard = pinsOf.get(y)!.some(q => q.c === p.c)
          if (p.side === 'high') require(x, y, hard)
          else require(y, x, hard)
        }
      }
    }
    // Hard constraints first; any constraint that would close a cycle is
    // dropped, and costs a crossing.
    const below = new Map(nets.map(net => [net, new Set<number>()]))
    const reaches = (from: number, to: number): boolean => {
      const seen = new Set<number>([from])
      const stack = [from]
      while (stack.length > 0) {
        const at = stack.pop()!
        if (at === to) return true
        for (const next of below.get(at)!) if (!seen.has(next)) { seen.add(next); stack.push(next) }
      }
      return false
    }
    let crossings = 0
    const ordered = [...constraints.values()].sort((a, b) => (Number(b.hard) - Number(a.hard)) || (a.above - b.above) || (a.below - b.below))
    for (const constraint of ordered) {
      if (reaches(constraint.below, constraint.above)) crossings++
      else below.get(constraint.above)!.add(constraint.below)
    }
    // Left-edge packing: lowest track above everything that must run under.
    const occupied: Array<Array<readonly [number, number]>> = []
    const remaining = new Set(nets)
    while (remaining.size > 0) {
      const ready = [...remaining].filter(net => [...below.get(net)!].every(other => !remaining.has(other)))
      const net = ready.sort((a, b) => (spanOf.get(a)![0] - spanOf.get(b)![0]) || (a - b))[0]!
      remaining.delete(net)
      const [low, high] = spanOf.get(net)!
      let at = Math.max(-1, ...[...below.get(net)!].map(other => track.get(trackKey(channel, other))!)) + 1
      while (occupied[at]?.some(([a, b]) => a < high + profile.grid && low < b + profile.grid)) at++
      ;(occupied[at] ??= []).push([low, high])
      track.set(trackKey(channel, net), at)
    }
    tracks.push(occupied.length)
    const passing = passes[channel]!.some(c => nets.some(net => c > spanOf.get(net)![0] && c < spanOf.get(net)![1]))
    const crossingFree = halfAllowed && crossings === 0 && !passing
    fine.push(crossingFree)
    pitch.push(crossingFree ? profile.grid / 2 : profile.grid)
  })
  return { jog, channelOf, track, tracks, pitch, fine }
}
