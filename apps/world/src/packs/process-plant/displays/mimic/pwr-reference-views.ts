import type { ComposedMimicView, MimicSymbol } from './mimic-model.ts'

// Reviewed mimic drawings for the reference PWR model. Each view is a fixed
// drawing topology, parameterised by loop, in the orientation of the unit
// overview: loops left to right, steam above, feed below. Coordinates are
// design pixels on a 4 px grid in a 600 px wide box.

export type MimicStateSpec =
  | { readonly kind: 'pump'; readonly component: string }
  | { readonly kind: 'valve'; readonly component: string }
  | { readonly kind: 'level'; readonly path: string; readonly unit: string }
  | { readonly kind: 'none' }

export interface MimicNodeSpec {
  readonly id: string
  readonly componentId: string
  readonly symbol: MimicSymbol
  readonly label: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly orientation: 'horizontal' | 'vertical'
  readonly state: MimicStateSpec
  readonly values: ReadonlyArray<{ readonly path: string; readonly unit: string; readonly side: 'left' | 'right' }>
}

export interface MimicPipeSpec {
  readonly id: string
  readonly linkId: string
  readonly points: ReadonlyArray<readonly [number, number]>
}

export interface MimicViewSpec {
  readonly height: number
  readonly nodes: ReadonlyArray<MimicNodeSpec>
  readonly pipes: ReadonlyArray<MimicPipeSpec>
}

const grid = (value: number): number => Math.round(value / 4) * 4

/** Loop columns centred in the band right of the pumps, at most 128 px apart. */
const loopCenters = (count: number): ReadonlyArray<number> => {
  const left = 180
  const right = 556
  if (count === 1) return [grid((left + right) / 2)]
  const step = Math.min(128, (right - left) / (count - 1))
  const start = (left + right - step * (count - 1)) / 2
  return Array.from({ length: count }, (_, index) => grid(start + step * index))
}

const lower = (loop: string): string => loop.toLowerCase()

const VALVE = 16
const PUMP = 16

/**
 * Main and auxiliary feedwater to the steam generators of the chosen loops:
 * MFW pumps → feedwater header → FCV → SG, and AFW pumps → AFW header → AFW
 * valve → SG. Both feeds join at the SG feedwater inlet, so the SG feed flow
 * is their sum and each branch shows its own flow.
 */
const feedToSg = (loops: ReadonlyArray<string>): MimicViewSpec => {
  const centers = loopCenters(loops.length)
  const lastCenter = centers.at(-1)!
  const sgTop = 20
  const sgHeight = 60
  const tee = 92
  const valveY = 112
  const fwHeader = 144
  const afwHeader = 168
  const afwPumpY = 196
  const nodes: MimicNodeSpec[] = []
  const pipes: MimicPipeSpec[] = []

  loops.forEach((loop, index) => {
    const cx = centers[index]!
    const l = lower(loop)
    const fcvX = cx - 24
    const afwX = cx + 24
    // Position tags fit beside the valves only while loops are at least 120 px apart.
    const tagged = centers.length <= 4
    nodes.push({
      id: `sg-${l}`, componentId: `sg${loop}`, symbol: 'steam-generator', label: `SG ${loop}`,
      x: cx - 18, y: sgTop, width: 36, height: sgHeight, orientation: 'vertical',
      state: { kind: 'level', path: `sg${loop}.levelPercent`, unit: 'percent' },
      values: [{ path: `sg${loop}.levelPercent`, unit: 'percent', side: 'right' }],
    })
    nodes.push({
      id: `fcv-${l}`, componentId: `feedwaterControlValve${loop}`, symbol: 'valve', label: `FCV ${loop}`,
      x: fcvX - VALVE / 2, y: valveY - VALVE / 2, width: VALVE, height: VALVE, orientation: 'vertical',
      state: { kind: 'valve', component: `feedwaterControlValve${loop}` },
      values: tagged ? [{ path: `feedwaterControlValve${loop}.effectivePositionFraction`, unit: 'fraction', side: 'left' }] : [],
    })
    nodes.push({
      id: `afw-valve-${l}`, componentId: `auxFeedwaterValve${loop}`, symbol: 'valve', label: `AFW ${loop}`,
      x: afwX - VALVE / 2, y: valveY - VALVE / 2, width: VALVE, height: VALVE, orientation: 'vertical',
      state: { kind: 'valve', component: `auxFeedwaterValve${loop}` },
      values: tagged ? [{ path: `auxFeedwaterValve${loop}.effectivePositionFraction`, unit: 'fraction', side: 'right' }] : [],
    })
    pipes.push(
      { id: `steam-${l}`, linkId: `sg-${l}-steam-to-msiv-${l}`, points: [[cx, sgTop], [cx, 4]] },
      { id: `fcv-${l}-to-sg`, linkId: `feedwater-control-valve-${l}-to-sg-${l}`, points: [[fcvX, valveY - VALVE / 2], [fcvX, tee], [cx, tee], [cx, sgTop + sgHeight]] },
      { id: `afw-valve-${l}-to-sg`, linkId: `aux-feedwater-valve-${l}-to-sg-${l}`, points: [[afwX, valveY - VALVE / 2], [afwX, tee], [cx, tee]] },
      { id: `fw-header-to-fcv-${l}`, linkId: `feedwater-header-to-control-valve-${l}`, points: [[fcvX, fwHeader], [fcvX, valveY + VALVE / 2]] },
      { id: `afw-header-to-valve-${l}`, linkId: `aux-feedwater-header-to-valve-${l}`, points: [[afwX, afwHeader], [afwX, valveY + VALVE / 2]] },
    )
  })

  // Headers are drawn as bars; their flows show on the branches.
  nodes.push(
    { id: 'fw-header', componentId: 'feedwaterHeader', symbol: 'header', label: 'MFW', x: 92, y: fwHeader - 2, width: lastCenter - 24 - 92, height: 4, orientation: 'horizontal', state: { kind: 'none' }, values: [] },
    { id: 'afw-header', componentId: 'auxFeedwaterHeader', symbol: 'header', label: 'AFW', x: 24, y: afwHeader - 2, width: lastCenter + 24 - 24, height: 4, orientation: 'horizontal', state: { kind: 'none' }, values: [] },
  )

  const mfwPumps = [
    { id: 'mfw-pump-a', componentId: 'mainFeedwaterPumpA', label: 'MFW A', y: 120, linkId: 'main-feedwater-pump-a-to-header' },
    { id: 'mfw-pump-b', componentId: 'mainFeedwaterPumpB', label: 'MFW B', y: 152, linkId: 'main-feedwater-pump-b-to-header' },
  ]
  for (const pump of mfwPumps) {
    nodes.push({
      id: pump.id, componentId: pump.componentId, symbol: 'pump', label: pump.label,
      x: 60 - PUMP / 2, y: pump.y - PUMP / 2, width: PUMP, height: PUMP, orientation: 'horizontal',
      state: { kind: 'pump', component: pump.componentId }, values: [],
    })
    pipes.push({ id: `${pump.id}-to-header`, linkId: pump.linkId, points: [[60 + PUMP / 2, pump.y], [80, pump.y], [80, fwHeader], [92, fwHeader]] })
  }

  const afwPumps = [
    { id: 'afw-pump-motor-a', componentId: 'auxFeedwaterPumpMotor', label: 'MD A', x: 40, linkId: 'motor-afw-pump-to-header' },
    { id: 'afw-pump-motor-b', componentId: 'auxFeedwaterPumpMotorB', label: 'MD B', x: 84, linkId: 'motor-afw-pump-b-to-header' },
    { id: 'afw-pump-turbine', componentId: 'auxFeedwaterPumpTurbine', label: 'TD', x: 128, linkId: 'turbine-afw-pump-to-header' },
  ]
  for (const pump of afwPumps) {
    nodes.push({
      id: pump.id, componentId: pump.componentId, symbol: 'pump', label: pump.label,
      x: pump.x - PUMP / 2, y: afwPumpY - PUMP / 2, width: PUMP, height: PUMP, orientation: 'vertical',
      state: { kind: 'pump', component: pump.componentId }, values: [],
    })
    pipes.push({ id: `${pump.id}-to-header`, linkId: pump.linkId, points: [[pump.x, afwPumpY - PUMP / 2], [pump.x, afwHeader]] })
  }

  return { height: 216, nodes, pipes }
}

export const pwrReferenceMimicViews: Readonly<Record<ComposedMimicView, (loops: ReadonlyArray<string>) => MimicViewSpec>> = {
  'feed-to-sg': feedToSg,
}
