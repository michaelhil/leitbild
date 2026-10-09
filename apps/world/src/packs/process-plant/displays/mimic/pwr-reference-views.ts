import type { ComposedMimicView, MimicSymbol } from './mimic-model.ts'

// Reviewed mimic drawings for the reference PWR model. Each view is a fixed
// drawing topology, parameterised by loop, in the orientation of the unit
// overview: loops left to right, steam above, feed below. Coordinates are
// design pixels on a 2 px grid in a 600 px wide box. Text stays inside the
// box and inside its own loop column; with more than four loops the columns
// are too narrow for tags, which then live only in the symbols' titles.

export type MimicStateSpec =
  | { readonly kind: 'pump'; readonly component: string }
  | { readonly kind: 'relief'; readonly flow: string; readonly command: string }
  | { readonly kind: 'valve'; readonly component: string }
  | { readonly kind: 'level'; readonly path: string; readonly unit: string }
  /** A header is full while any of its branches carries flow. */
  | { readonly kind: 'header'; readonly links: ReadonlyArray<string> }
  | { readonly kind: 'none' }

export interface MimicValueSpec {
  readonly path: string
  readonly unit: string
  readonly side: 'left' | 'right'
  readonly name?: string
}

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
  readonly values: ReadonlyArray<MimicValueSpec>
  /** Signals whose alarm rules frame this symbol, when its component bundles several items (the PORV sits in the pressurizer). */
  readonly alarmPaths?: ReadonlyArray<string>
  /** I&C alarm and trip limits of this signal are marked on the symbol (level bands). */
  readonly limitsOf?: string
}

export interface MimicPipeSpec {
  readonly id: string
  readonly linkId: string
  readonly points: ReadonlyArray<readonly [number, number]>
  /** The model's flow on this link is not verified; it is drawn as unknown, never as flow. */
  readonly unverified?: boolean
}

export interface MimicViewSpec {
  readonly height: number
  readonly nodes: ReadonlyArray<MimicNodeSpec>
  readonly pipes: ReadonlyArray<MimicPipeSpec>
}

const grid = (value: number): number => Math.round(value / 2) * 2

/** Loop columns centred in a band, at most 128 px apart. */
const loopColumns = (count: number, left: number, right: number): { readonly centers: ReadonlyArray<number>; readonly step: number } => {
  if (count === 1) return { centers: [grid((left + right) / 2)], step: right - left }
  const step = Math.min(128, (right - left) / (count - 1))
  const start = (left + right - step * (count - 1)) / 2
  return { centers: Array.from({ length: count }, (_, index) => grid(start + step * index)), step }
}

const lower = (loop: string): string => loop.toLowerCase()

/** Pumps and valves are at least 20 px (HMI rubric). */
const SYMBOL = 20
const TAGGED_LOOPS = 4

/**
 * Main and auxiliary feedwater to the steam generators of the chosen loops:
 * MFW pumps → MFW header → FCV → SG, and AFW pumps → AFW header → AFW valve →
 * SG. Both feeds join at the SG feedwater inlet, so each branch shows its own
 * flow and, for one or two loops, the SG shows feed against steam flow.
 */
const feedToSg = (loops: ReadonlyArray<string>): MimicViewSpec => {
  const { centers, step } = loopColumns(loops.length, 200, 520)
  const lastCenter = centers.at(-1)!
  const tagged = loops.length <= TAGGED_LOOPS
  const focused = loops.length <= 2
  // FCV left and AFW valve right of each SG, kept clear of the next loop's pair.
  const offset = Math.min(24, grid(step / 2 - SYMBOL / 2 - 2))
  const sgTop = 12
  const sgHeight = 60
  const tee = 82
  const valveY = 102
  const fwHeader = 130
  const afwHeader = 152
  const afwPumpY = 176
  const nodes: MimicNodeSpec[] = []
  const pipes: MimicPipeSpec[] = []

  loops.forEach((loop, index) => {
    const cx = centers[index]!
    const l = lower(loop)
    const fcvX = cx - offset
    const afwX = cx + offset
    nodes.push({
      id: `sg-${l}`, componentId: `sg${loop}`, symbol: 'steam-generator', label: `SG ${loop}`,
      x: cx - 18, y: sgTop, width: 36, height: sgHeight, orientation: 'vertical',
      state: { kind: 'level', path: `sg${loop}.levelPercent`, unit: 'percent' },
      values: tagged ? [
        { path: `sg${loop}.levelPercent`, unit: 'percent', side: 'right' },
        ...(focused ? [
          { path: `sg${loop}.feedwaterFlowKgPerS`, unit: 'kg/s', side: 'right' as const, name: 'feed' },
          { path: `sg${loop}.steamFlowKgPerS`, unit: 'kg/s', side: 'right' as const, name: 'steam' },
        ] : []),
      ] : [],
      limitsOf: `sg${loop}.levelPercent`,
    })
    // Only the row's ends have room for the FCV and AFW names; between loops the
    // connections to the MFW and AFW headers tell the two valves apart.
    const first = index === 0
    const last = index === loops.length - 1
    nodes.push({
      id: `fcv-${l}`, componentId: `feedwaterControlValve${loop}`, symbol: 'valve', label: first ? 'FCV' : '',
      x: fcvX - SYMBOL / 2, y: valveY - SYMBOL / 2, width: SYMBOL, height: SYMBOL, orientation: 'vertical',
      state: { kind: 'valve', component: `feedwaterControlValve${loop}` },
      values: tagged ? [{ path: `feedwaterControlValve${loop}.effectivePositionFraction`, unit: 'fraction', side: 'left' }] : [],
    })
    nodes.push({
      id: `afw-valve-${l}`, componentId: `auxFeedwaterValve${loop}`, symbol: 'valve', label: last ? 'AFW' : '',
      x: afwX - SYMBOL / 2, y: valveY - SYMBOL / 2, width: SYMBOL, height: SYMBOL, orientation: 'vertical',
      state: { kind: 'valve', component: `auxFeedwaterValve${loop}` },
      values: tagged ? [{ path: `auxFeedwaterValve${loop}.effectivePositionFraction`, unit: 'fraction', side: 'right' }] : [],
    })
    pipes.push(
      { id: `steam-${l}`, linkId: `sg-${l}-steam-to-msiv-${l}`, points: [[cx, sgTop], [cx, 0]] },
      { id: `fcv-${l}-to-sg`, linkId: `feedwater-control-valve-${l}-to-sg-${l}`, points: [[fcvX, valveY - SYMBOL / 2], [fcvX, tee], [cx, tee], [cx, sgTop + sgHeight]] },
      { id: `afw-valve-${l}-to-sg`, linkId: `aux-feedwater-valve-${l}-to-sg-${l}`, points: [[afwX, valveY - SYMBOL / 2], [afwX, tee], [cx, tee]] },
      { id: `fw-header-to-fcv-${l}`, linkId: `feedwater-header-to-control-valve-${l}`, points: [[fcvX, fwHeader], [fcvX, valveY + SYMBOL / 2]] },
      { id: `afw-header-to-valve-${l}`, linkId: `aux-feedwater-header-to-valve-${l}`, points: [[afwX, afwHeader], [afwX, valveY + SYMBOL / 2]] },
    )
  })

  nodes.push(
    {
      id: 'fw-header', componentId: 'feedwaterHeader', symbol: 'header', label: 'MFW header', x: 72, y: fwHeader - 2, width: lastCenter - offset - 72, height: 4, orientation: 'horizontal',
      state: { kind: 'header', links: loops.map(loop => `feedwater-header-to-control-valve-${lower(loop)}`) }, values: [],
    },
    {
      id: 'afw-header', componentId: 'auxFeedwaterHeader', symbol: 'header', label: 'AFW header', x: 72, y: afwHeader - 2, width: lastCenter + offset - 72, height: 4, orientation: 'horizontal',
      state: { kind: 'header', links: loops.map(loop => `aux-feedwater-header-to-valve-${lower(loop)}`) }, values: [],
    },
  )

  // MFW pumps feed the header from the left, 36 px apart so their alarm flaps never stack.
  const mfwPumps = [
    { id: 'mfw-pump-a', componentId: 'mainFeedwaterPumpA', label: 'MFW A', y: 98, linkId: 'main-feedwater-pump-a-to-header' },
    { id: 'mfw-pump-b', componentId: 'mainFeedwaterPumpB', label: 'MFW B', y: 134, linkId: 'main-feedwater-pump-b-to-header' },
  ]
  for (const pump of mfwPumps) {
    nodes.push({
      id: pump.id, componentId: pump.componentId, symbol: 'pump', label: pump.label,
      x: 50 - SYMBOL / 2, y: pump.y - SYMBOL / 2, width: SYMBOL, height: SYMBOL, orientation: 'horizontal',
      state: { kind: 'pump', component: pump.componentId }, values: [],
    })
    pipes.push({ id: `${pump.id}-to-header`, linkId: pump.linkId, points: [[50 + SYMBOL / 2, pump.y], [64, pump.y], [64, fwHeader], [72, fwHeader]] })
  }

  const afwPumps = [
    { id: 'afw-pump-motor-a', componentId: 'auxFeedwaterPumpMotor', label: 'MD A', x: 90, linkId: 'motor-afw-pump-to-header' },
    { id: 'afw-pump-motor-b', componentId: 'auxFeedwaterPumpMotorB', label: 'MD B', x: 126, linkId: 'motor-afw-pump-b-to-header' },
    { id: 'afw-pump-turbine', componentId: 'auxFeedwaterPumpTurbine', label: 'TD', x: 162, linkId: 'turbine-afw-pump-to-header' },
  ]
  for (const pump of afwPumps) {
    nodes.push({
      id: pump.id, componentId: pump.componentId, symbol: 'pump', label: pump.label,
      x: pump.x - SYMBOL / 2, y: afwPumpY - SYMBOL / 2, width: SYMBOL, height: SYMBOL, orientation: 'vertical',
      state: { kind: 'pump', component: pump.componentId }, values: [],
    })
    pipes.push({ id: `${pump.id}-to-header`, linkId: pump.linkId, points: [[pump.x, afwPumpY - SYMBOL / 2], [pump.x, afwHeader]] })
  }

  return { height: 202, nodes, pipes }
}

/**
 * The pressurizer and its relief path: the surge line from its hot leg, the
 * pressurizer, the PORV inline on the relief line, and the relief tank. The
 * model keeps the PORV inside the pressurizer and does not write its
 * position, so the symbol is judged by the relief flow and says "POS ?". The
 * surge-line flow is not verified (it read 3,400 kg/s at a steady level), so
 * it is drawn as unknown. Loops do not apply.
 */
const pressurizerRelief = (): MimicViewSpec => {
  const pzr = { x: 236, y: 44, width: 40, height: 96 }
  const tank = { x: 420, y: 98, width: 96, height: 40 }
  const reliefY = 26
  const porvX = 348
  const surgeY = 158
  return {
    height: 172,
    nodes: [
      {
        id: 'pressurizer', componentId: 'pressurizer', symbol: 'pressurizer', label: 'PZR', ...pzr, orientation: 'vertical',
        state: { kind: 'level', path: 'pressurizer.levelPercent', unit: 'percent' },
        values: [{ path: 'pressurizer.pressureMPa', unit: 'MPa', side: 'left' }, { path: 'pressurizer.levelPercent', unit: 'percent', side: 'left' }],
        alarmPaths: ['pressurizer.pressureMPa', 'pressurizer.levelPercent'],
        limitsOf: 'pressurizer.levelPercent',
      },
      {
        id: 'porv', componentId: 'pressurizer', symbol: 'relief-valve', label: 'PORV', x: porvX - SYMBOL / 2, y: reliefY - SYMBOL / 2, width: SYMBOL, height: SYMBOL, orientation: 'horizontal',
        state: { kind: 'relief', flow: 'pressurizer.reliefFlowKgPerS', command: 'pressurizer.reliefValvePositionFraction' },
        values: [{ path: 'pressurizer.reliefFlowKgPerS', unit: 'kg/s', side: 'right' }],
        alarmPaths: ['pressurizer.reliefFlowKgPerS'],
      },
      {
        id: 'relief-tank', componentId: 'pressurizerReliefTank', symbol: 'tank', label: 'PRT', ...tank, orientation: 'horizontal',
        state: { kind: 'level', path: 'pressurizerReliefTank.levelPercent', unit: 'percent' },
        values: [{ path: 'pressurizerReliefTank.levelPercent', unit: 'percent', side: 'right' }],
      },
      { id: 'hot-leg', componentId: 'core', symbol: 'stub', label: 'Hot leg A', x: 40, y: surgeY - 6, width: 12, height: 12, orientation: 'horizontal', state: { kind: 'none' }, values: [], alarmPaths: [] },
    ],
    pipes: [
      { id: 'surge-line', linkId: 'pressurizer-surge-line', points: [[52, surgeY], [pzr.x + pzr.width / 2, surgeY], [pzr.x + pzr.width / 2, pzr.y + pzr.height]], unverified: true },
      { id: 'relief-line', linkId: 'pressurizer-relief-to-tank', points: [[pzr.x + pzr.width / 2, pzr.y], [pzr.x + pzr.width / 2, reliefY], [tank.x + tank.width / 2, reliefY], [tank.x + tank.width / 2, tank.y]] },
    ],
  }
}

/**
 * The reactor coolant loops: the vessel, and per loop its own hot leg up to
 * the SG, the SG outlet down to the RCP, and the RCP's own cold leg back to the
 * vessel. Legs are separate pipes, never a shared manifold. Loop flow with or
 * without the pumps (natural circulation) shows on every leg and is labelled
 * as loop flow beside the pump.
 */
const rcsLoops = (loops: ReadonlyArray<string>): MimicViewSpec => {
  const { centers } = loopColumns(loops.length, 236, 520)
  const tagged = loops.length <= TAGGED_LOOPS
  const legGap = 6
  const sgTop = 12
  const sgHeight = 60
  const rcpY = 102
  const hotBase = 128
  const coldBase = 166
  const coldLast = coldBase + legGap * (loops.length - 1)
  const vessel = { x: 96, y: 66, width: 56, height: coldLast + 10 - 66 }
  const nodes: MimicNodeSpec[] = [
    {
      id: 'reactor', componentId: 'core', symbol: 'reactor', label: 'RV', ...vessel, orientation: 'vertical', state: { kind: 'none' },
      values: [
        { path: 'core.coolantOutletTemperatureC', unit: 'degC', side: 'left', name: 'CET' },
        { path: 'vessel.subcoolingMarginC', unit: 'degC', side: 'left', name: 'subcooling' },
      ],
      alarmPaths: ['core.coolantOutletTemperatureC', 'vessel.subcoolingMarginC'],
    },
  ]
  const pipes: MimicPipeSpec[] = []
  loops.forEach((loop, index) => {
    const cx = centers[index]!
    const l = lower(loop)
    const hotY = hotBase + index * legGap
    const coldY = coldBase + index * legGap
    nodes.push(
      {
        id: `sg-${l}`, componentId: `sg${loop}`, symbol: 'steam-generator', label: `SG ${loop}`, x: cx - 18, y: sgTop, width: 36, height: sgHeight, orientation: 'vertical',
        state: { kind: 'level', path: `sg${loop}.levelPercent`, unit: 'percent' },
        values: tagged ? [{ path: `sg${loop}.levelPercent`, unit: 'percent', side: 'right' }] : [],
        limitsOf: `sg${loop}.levelPercent`,
      },
      {
        id: `rcp-${l}`, componentId: `rcp${loop}`, symbol: 'pump', label: `RCP ${loop} loop`, x: cx + 10 - SYMBOL / 2, y: rcpY - SYMBOL / 2, width: SYMBOL, height: SYMBOL, orientation: 'vertical',
        state: { kind: 'pump', component: `rcp${loop}` },
        values: tagged ? [{ path: `rcp${loop}.loopFlowKgPerS`, unit: 'kg/s', side: 'right' }] : [],
      },
    )
    pipes.push(
      { id: `hot-leg-${l}`, linkId: `rcs-hot-leg-${l}`, points: [[vessel.x + vessel.width, hotY], [cx - 10, hotY], [cx - 10, sgTop + sgHeight]] },
      { id: `cold-leg-${l}`, linkId: `rcs-cold-leg-${l}`, points: [[cx + 10, sgTop + sgHeight], [cx + 10, rcpY - SYMBOL / 2]] },
      { id: `rcp-${l}-to-vessel`, linkId: `rcp-${l}-to-core`, points: [[cx + 10, rcpY + SYMBOL / 2], [cx + 10, coldY], [vessel.x + vessel.width, coldY]] },
    )
  })
  return { height: vessel.y + vessel.height + 6, nodes, pipes }
}

export const pwrReferenceMimicViews: Readonly<Record<ComposedMimicView, (loops: ReadonlyArray<string>) => MimicViewSpec>> = {
  'feed-to-sg': feedToSg,
  'pressurizer-relief': pressurizerRelief,
  'rcs-loops': rcsLoops,
}

/** Views drawn per loop; the others ignore loops. */
export const loopedMimicViews: ReadonlySet<ComposedMimicView> = new Set(['feed-to-sg', 'rcs-loops'])
