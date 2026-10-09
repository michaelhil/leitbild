import type { ComposedMimicView, MimicSymbol } from './mimic-model.ts'

// Reviewed mimic drawings for the reference PWR model. Each view is a fixed
// drawing topology, parameterised by loop, in the orientation of the unit
// overview: loops left to right, steam above, feed below. Coordinates are
// design pixels on a 4 px grid in a 600 px wide box.

export type MimicStateSpec =
  | { readonly kind: 'pump'; readonly component: string }
  | { readonly kind: 'relief'; readonly flow: string; readonly command: string }
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
  readonly values: ReadonlyArray<{ readonly path: string; readonly unit: string; readonly side: 'left' | 'right'; readonly name?: string }>
  /** Signals whose alarm rules frame this symbol, when its component bundles several items (the PORV sits in the pressurizer). */
  readonly alarmPaths?: ReadonlyArray<string>
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

/**
 * The pressurizer and its relief path: the surge line from its hot leg, the
 * pressurizer, the PORV inline on the relief line, and the relief tank. The
 * model keeps the PORV inside the pressurizer, so its symbol is judged by the
 * relief flow. Loops do not apply.
 */
const pressurizerRelief = (): MimicViewSpec => {
  const pzr = { x: 236, y: 24, width: 40, height: 100 }
  const tank = { x: 420, y: 84, width: 96, height: 40 }
  const reliefY = 10
  const porvX = 348
  const surgeY = 144
  return {
    height: 156,
    nodes: [
      {
        id: 'pressurizer', componentId: 'pressurizer', symbol: 'pressurizer', label: 'PZR', ...pzr, orientation: 'vertical',
        state: { kind: 'level', path: 'pressurizer.levelPercent', unit: 'percent' },
        values: [{ path: 'pressurizer.pressureMPa', unit: 'MPa', side: 'left' }, { path: 'pressurizer.levelPercent', unit: 'percent', side: 'left' }],
        alarmPaths: ['pressurizer.pressureMPa', 'pressurizer.levelPercent'],
      },
      {
        id: 'porv', componentId: 'pressurizer', symbol: 'relief-valve', label: 'PORV', x: porvX - 10, y: reliefY - 10, width: 20, height: 20, orientation: 'horizontal',
        state: { kind: 'relief', flow: 'pressurizer.reliefFlowKgPerS', command: 'pressurizer.reliefValvePositionFraction' },
        values: [{ path: 'pressurizer.reliefFlowKgPerS', unit: 'kg/s', side: 'right' }],
        alarmPaths: ['pressurizer.reliefFlowKgPerS', 'pressurizer.reliefValvePositionFraction'],
      },
      {
        id: 'relief-tank', componentId: 'pressurizerReliefTank', symbol: 'tank', label: 'PRT', ...tank, orientation: 'horizontal',
        state: { kind: 'level', path: 'pressurizerReliefTank.levelPercent', unit: 'percent' },
        values: [{ path: 'pressurizerReliefTank.levelPercent', unit: 'percent', side: 'right' }],
      },
      { id: 'hot-leg', componentId: 'core', symbol: 'stub', label: 'Hot leg A', x: 40, y: surgeY - 6, width: 12, height: 12, orientation: 'horizontal', state: { kind: 'none' }, values: [], alarmPaths: [] },
    ],
    pipes: [
      { id: 'surge-line', linkId: 'pressurizer-surge-line', points: [[52, surgeY], [pzr.x + pzr.width / 2, surgeY], [pzr.x + pzr.width / 2, pzr.y + pzr.height]] },
      { id: 'relief-line', linkId: 'pressurizer-relief-to-tank', points: [[pzr.x + pzr.width / 2, pzr.y], [pzr.x + pzr.width / 2, reliefY], [tank.x + tank.width / 2, reliefY], [tank.x + tank.width / 2, tank.y]] },
    ],
  }
}

/**
 * The reactor coolant loops: the vessel with its hot and cold plena, and per
 * loop the hot leg up to the SG, the SG outlet down to the RCP and the RCP back
 * to the vessel. Loop flow with or without the pumps (natural circulation)
 * shows on every leg.
 */
const rcsLoops = (loops: ReadonlyArray<string>): MimicViewSpec => {
  const centers = loopCenters(loops.length)
  const lastCenter = centers.at(-1)!
  const vessel = { x: 24, y: 20, width: 64, height: 172 }
  const sgTop = 20
  const sgHeight = 60
  const rcpY = 124
  const hotPlenum = 156
  const coldPlenum = 180
  const nodes: MimicNodeSpec[] = [
    {
      id: 'reactor', componentId: 'core', symbol: 'reactor', label: 'RV', ...vessel, orientation: 'vertical', state: { kind: 'none' },
      values: [
        { path: 'core.coolantOutletTemperatureC', unit: 'degC', side: 'right', name: 'CET' },
        { path: 'vessel.subcoolingMarginC', unit: 'degC', side: 'right', name: 'SM' },
      ],
      alarmPaths: ['core.coolantOutletTemperatureC', 'vessel.subcoolingMarginC', 'core.totalThermalPowerMw'],
    },
    { id: 'hot-plenum', componentId: 'core', symbol: 'header', label: 'hot legs', x: vessel.x + vessel.width, y: hotPlenum - 2, width: lastCenter - 10 - (vessel.x + vessel.width), height: 4, orientation: 'horizontal', state: { kind: 'none' }, values: [], alarmPaths: [] },
    { id: 'cold-plenum', componentId: 'core', symbol: 'header', label: 'cold legs', x: vessel.x + vessel.width, y: coldPlenum - 2, width: lastCenter + 10 - (vessel.x + vessel.width), height: 4, orientation: 'horizontal', state: { kind: 'none' }, values: [], alarmPaths: [] },
  ]
  const pipes: MimicPipeSpec[] = []
  loops.forEach((loop, index) => {
    const cx = centers[index]!
    const l = lower(loop)
    nodes.push(
      {
        id: `sg-${l}`, componentId: `sg${loop}`, symbol: 'steam-generator', label: `SG ${loop}`, x: cx - 18, y: sgTop, width: 36, height: sgHeight, orientation: 'vertical',
        state: { kind: 'level', path: `sg${loop}.levelPercent`, unit: 'percent' },
        values: [{ path: `sg${loop}.levelPercent`, unit: 'percent', side: 'right' }],
      },
      {
        id: `rcp-${l}`, componentId: `rcp${loop}`, symbol: 'pump', label: `RCP ${loop}`, x: cx + 10 - PUMP / 2, y: rcpY - PUMP / 2, width: PUMP, height: PUMP, orientation: 'vertical',
        state: { kind: 'pump', component: `rcp${loop}` },
        values: [{ path: `rcp${loop}.loopFlowKgPerS`, unit: 'kg/s', side: 'right' }],
      },
    )
    pipes.push(
      { id: `hot-leg-${l}`, linkId: `rcs-hot-leg-${l}`, points: [[cx - 10, hotPlenum], [cx - 10, sgTop + sgHeight]] },
      { id: `cold-leg-${l}`, linkId: `rcs-cold-leg-${l}`, points: [[cx + 10, sgTop + sgHeight], [cx + 10, rcpY - PUMP / 2]] },
      { id: `rcp-${l}-to-vessel`, linkId: `rcp-${l}-to-core`, points: [[cx + 10, rcpY + PUMP / 2], [cx + 10, coldPlenum]] },
    )
  })
  return { height: 200, nodes, pipes }
}

export const pwrReferenceMimicViews: Readonly<Record<ComposedMimicView, (loops: ReadonlyArray<string>) => MimicViewSpec>> = {
  'feed-to-sg': feedToSg,
  'pressurizer-relief': pressurizerRelief,
  'rcs-loops': rcsLoops,
}

/** Views drawn per loop; the others ignore loops. */
export const loopedMimicViews: ReadonlySet<ComposedMimicView> = new Set(['feed-to-sg', 'rcs-loops'])
