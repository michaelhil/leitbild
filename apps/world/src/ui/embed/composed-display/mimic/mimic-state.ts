// Pure state of mimic symbols from the latest sample. World decides which
// variable means what; these functions only read the sample, and never
// substitute a value that is missing: an unknown state draws as unknown.
import type { MimicNode, MimicPipe } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
import type { ComposedDisplayAlarm, ComposedDisplaySample } from '../composed-display-client.ts'
import type { OpenBridgeIcon } from './openbridge-icons.ts'

export type SampleIndex = ReadonlyMap<string, { readonly value: unknown; readonly quality: string }>

export const indexSample = (sample: ComposedDisplaySample | undefined): SampleIndex =>
  new Map((sample?.values ?? []).map(entry => [entry.path, { value: entry.value, quality: entry.quality }]))

const numberAt = (index: SampleIndex, path: string): number | null => {
  const entry = index.get(path)
  return entry !== undefined && typeof entry.value === 'number' && entry.quality !== 'outside-hard-range' ? entry.value : null
}

const booleanAt = (index: SampleIndex, path: string): boolean | null => {
  const value = index.get(path)?.value
  return typeof value === 'boolean' ? value : null
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)} %`

export interface PumpLook {
  readonly look: 'on' | 'off' | 'unknown'
  /** The run command disagrees with the pump: "CMD RUN · STOPPED". */
  readonly mismatch: string | null
}

export const pumpLook = (node: MimicNode, index: SampleIndex): PumpLook => {
  if (node.state.kind !== 'pump') return { look: 'unknown', mismatch: null }
  const speed = numberAt(index, node.state.speedPath)
  const command = booleanAt(index, node.state.commandPath)
  if (speed === null) return { look: 'unknown', mismatch: null }
  const running = speed > 0
  const mismatch = command === null || command === running ? null : command ? 'CMD RUN · STOPPED' : 'CMD STOP · RUNNING'
  return { look: running ? 'on' : 'off', mismatch }
}

export interface ValveLook {
  readonly icon: OpenBridgeIcon
  readonly position: number | null
  /**
   * Whether the number adds to the icon: a partial opening, a demand that
   * disagrees, or an unknown position. A full open or closed valve reads from
   * its symbol alone, which keeps a four-loop row legible.
   */
  readonly tagged: boolean
  /** The command disagrees with the actual position: "CMD 100 % · POS 35 %". */
  readonly mismatch: string | null
}

// The OpenBridge analog valve shows its opening in steps; the value tag gives the number.
const valveIcon = (position: number): OpenBridgeIcon =>
  position < 0.05 ? 'twoway-analog-closed'
    : position < 0.175 ? 'twoway-analog-10'
      : position < 0.375 ? 'twoway-analog-25'
        : position < 0.625 ? 'twoway-analog-50'
          : position < 0.875 ? 'twoway-analog-75'
            : 'twoway-analog-open'

const MISMATCH_FRACTION = 0.1

export const valveLook = (node: MimicNode, index: SampleIndex): ValveLook => {
  if (node.state.kind !== 'valve') return { icon: 'twoway-digital-static', position: null, mismatch: null, tagged: true }
  const position = numberAt(index, node.state.positionPath)
  const command = numberAt(index, node.state.commandPath)
  if (position === null) return { icon: 'twoway-digital-static', position: null, mismatch: null, tagged: true }
  const mismatch = command !== null && Math.abs(command - position) > MISMATCH_FRACTION ? `CMD ${percent(command)} · POS ${percent(position)}` : null
  return { icon: valveIcon(position), position, mismatch, tagged: mismatch !== null || (position > 0.05 && position < 0.95) }
}

export interface ReliefLook {
  /** The model gives no position, so the symbol is always the unknown-position valve. */
  readonly icon: OpenBridgeIcon
  readonly passing: boolean | null
  /** The command disagrees with the flow: "CMD SHUT · PASSING" (stuck open) or "CMD OPEN · NO FLOW". */
  readonly mismatch: string | null
}

export const reliefLook = (node: MimicNode, index: SampleIndex): ReliefLook => {
  if (node.state.kind !== 'relief') return { icon: 'twoway-digital-static', passing: null, mismatch: null }
  const flow = numberAt(index, node.state.flowPath)
  if (flow === null) return { icon: 'twoway-digital-static', passing: null, mismatch: null }
  const passing = Math.abs(flow) >= node.state.noFlowBelow
  const command = numberAt(index, node.state.commandPath)
  const mismatch = command === null ? null
    : passing && command < 0.05 ? 'CMD SHUT · PASSING'
      : !passing && command > 0.5 ? 'CMD OPEN · NO FLOW'
        : null
  return { icon: 'twoway-digital-static', passing, mismatch }
}

export interface FlowLook {
  readonly look: 'forward' | 'reverse' | 'none' | 'unknown'
  readonly value: number | null
}

export const flowLook = (pipe: MimicPipe, index: SampleIndex): FlowLook => {
  if (pipe.unverified) return { look: 'unknown', value: null }
  const value = numberAt(index, pipe.flowPath)
  if (value === null) return { look: 'unknown', value: null }
  if (Math.abs(value) < pipe.noFlowBelow) return { look: 'none', value }
  return { look: value > 0 ? 'forward' : 'reverse', value }
}

/** A header is full while any branch carries flow, empty when none does, unknown otherwise. */
export const headerLook = (node: MimicNode, index: SampleIndex): 'full' | 'empty' | 'unknown' => {
  if (node.state.kind !== 'header') return 'unknown'
  const flows = node.state.flowPaths.map(path => numberAt(index, path))
  const noFlowBelow = node.state.noFlowBelow
  if (flows.some(flow => flow !== null && Math.abs(flow) >= noFlowBelow)) return 'full'
  return flows.every(flow => flow !== null) ? 'empty' : 'unknown'
}

/** Fill fraction of a level symbol, clamped to its frame with an explicit off-scale flag. */
export const levelLook = (node: MimicNode, index: SampleIndex): { readonly fraction: number | null; readonly offScale: 'high' | 'low' | null } => {
  if (node.state.kind !== 'level') return { fraction: null, offScale: null }
  const level = numberAt(index, node.state.levelPath)
  if (level === null) return { fraction: null, offScale: null }
  const fraction = level / 100
  return { fraction: Math.min(1, Math.max(0, fraction)), offScale: fraction > 1 ? 'high' : fraction < 0 ? 'low' : null }
}

const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const

/** The most severe active alarm on the symbol's equipment, which frames it. */
export const nodeAlarm = (node: MimicNode, alarms: ReadonlyArray<ComposedDisplayAlarm>): ComposedDisplayAlarm | null => {
  const related = new Set(node.ruleIds)
  return alarms
    .filter(alarm => related.has(alarm.ruleId))
    .sort((left, right) => Number(right.kind === 'trip') - Number(left.kind === 'trip') || severityRank[left.severity] - severityRank[right.severity])[0] ?? null
}

/**
 * One chevron per pipe, a third of the way along its longest segment: clear of
 * the junction it ends in and of the header it leaves.
 */
export const chevrons = (points: ReadonlyArray<readonly [number, number]>): ReadonlyArray<{ readonly x: number; readonly y: number; readonly angle: number }> => {
  const segments = points.slice(1).map((point, index) => ({ from: points[index]!, to: point }))
  const length = (segment: { readonly from: readonly [number, number]; readonly to: readonly [number, number] }): number =>
    Math.abs(segment.to[0] - segment.from[0]) + Math.abs(segment.to[1] - segment.from[1])
  const longest = segments.reduce<(typeof segments)[number] | undefined>((best, segment) => best === undefined || length(segment) > length(best) ? segment : best, undefined)
  if (longest === undefined || length(longest) < 12) return []
  const [x0, y0] = longest.from
  const [x1, y1] = longest.to
  return [{ x: x0 + (x1 - x0) / 3, y: y0 + (y1 - y0) / 3, angle: Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI }]
}

/**
 * Where a vertical pipe crosses another pipe's or a header's horizontal run:
 * the horizontal one bridges it, so crossing lines never read as a junction.
 */
export const crossings = (
  pipes: ReadonlyArray<MimicPipe>,
  bars: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number; readonly width: number }> = [],
): ReadonlyArray<{ readonly x: number; readonly y: number; readonly over: string }> => {
  const segments = pipes.flatMap(pipe => pipe.points.slice(1).map((point, index) => ({ pipe: pipe.id, from: pipe.points[index]!, to: point })))
  const horizontal = [
    ...segments.filter(segment => segment.from[1] === segment.to[1]),
    ...bars.map(bar => ({ pipe: bar.id, from: [bar.x, bar.y] as const, to: [bar.x + bar.width, bar.y] as const })),
  ]
  const vertical = segments.filter(segment => segment.from[0] === segment.to[0])
  const between = (value: number, a: number, b: number): boolean => value > Math.min(a, b) && value < Math.max(a, b)
  return vertical.flatMap(v => horizontal
    .filter(h => h.pipe !== v.pipe && between(v.from[0], h.from[0], h.to[0]) && between(h.from[1], v.from[1], v.to[1]))
    .map(h => ({ x: v.from[0], y: h.from[1], over: h.pipe })))
}
