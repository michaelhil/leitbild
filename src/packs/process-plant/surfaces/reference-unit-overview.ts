import { processSurfaceDefinitionSchema } from './model.ts'

const loopLetters = ['A', 'B', 'C', 'D'] as const
type LoopLetter = typeof loopLetters[number]

const lowerLoop = (loop: LoopLetter): Lowercase<LoopLetter> => loop.toLowerCase() as Lowercase<LoopLetter>

const rcpXFor = (sgX: number): number => sgX - 6

const sgWidget = (loop: LoopLetter, x: number, rank: number) => {
  const lower = lowerLoop(loop)
  return {
    id: `sg-${lower}`,
    type: 'heatExchanger',
    label: `SG ${loop}`,
    region: 'heat-transfer',
    source: { componentIds: [`sg${loop}`] },
    role: 'steam-generator',
    rank,
    geometry: { x, y: 232, width: 208, height: 364 },
    binds: {
      level: { label: 'Level', path: `sg${loop}.levelPercent`, digits: 0, display: 'percent' },
      pressure: { label: 'P', path: `sg${loop}.pressureMPa`, digits: 2 },
      steam: { label: 'Steam', path: `sg-${lower}-steam-to-msiv-${lower}.flowKgPerS`, digits: 0 },
      feedwater: { label: 'FW', path: `feedwater-control-valve-${lower}-to-sg-${lower}.flowKgPerS`, digits: 0 },
      heat: { label: 'Heat', path: `sg${loop}.heatTransferMw`, digits: 0 },
      tubeCoverage: { label: 'Tube cov', path: `sg${loop}.tubeCoverageFraction`, digits: 2, display: 'percent' },
      radiation: { label: 'Rad', path: `sg${loop}.secondaryRadiationMSvPerH`, digits: 2 },
    },
    ports: {
      primaryIn: { x: 0, y: 104 },
      primaryOut: { x: 0, y: 264 },
      steamOut: { x: 113, y: 0 },
      feedwaterIn: { x: 113, y: 364 },
    },
    style: { tone: 'secondary' },
  } as const
}

const rcpWidget = (loop: LoopLetter, x: number, rank: number) => {
  const lower = lowerLoop(loop)
  return {
    id: `rcp-${lower}`,
    type: 'pump',
    label: `RCP ${loop}`,
    region: 'primary',
    source: { componentIds: [`rcp${loop}`] },
    role: 'reactor-coolant-pump',
    rank,
    geometry: { x, y: 606, width: 96, height: 96 },
    binds: {
      running: { label: 'Run', path: `rcp${loop}.running` },
      speed: { label: 'Speed', path: `rcp${loop}.speedFraction`, digits: 2, display: 'percent' },
      flow: { label: 'Loop flow', path: `rcp${loop}.loopFlowKgPerS`, digits: 0 },
    },
    ports: { inlet: { x: 48, y: 0 }, outlet: { x: 48, y: 96 } },
  } as const
}

const primaryLoopPaths = (loop: LoopLetter, sgX: number) => {
  const lower = lowerLoop(loop)
  const pumpCenterX = rcpXFor(sgX) + 48
  const hotLegY = 366 + loopIndex(loop) * 42
  const coldLegY = 364 + loopIndex(loop) * 42
  const sgPrimaryInY = 336
  const sgPrimaryOutY = 496
  const coldLegBranchY = sgPrimaryOutY + 70
  const pumpReturnY = 726
  const hotRiserX = 430
  const returnHeaderX = 142
  return [
    {
      id: `primary-hot-leg-${lower}`,
      label: `Loop ${loop} hot leg`,
      source: { connectionId: `rcs-hot-leg-${lower}` },
      from: `reactor-vessel.hotLeg${loop}`,
      to: `sg-${lower}.primaryIn`,
      waypoints: [
        { x: hotRiserX, y: hotLegY },
        { x: hotRiserX, y: sgPrimaryInY },
      ],
      binds: { flow: { label: 'Hot-leg flow', path: `rcs-hot-leg-${lower}.flowKgPerS`, digits: 0 } },
      style: { service: 'primary' },
    },
    {
      id: `primary-cold-leg-${lower}`,
      label: `Loop ${loop} cold leg`,
      source: { connectionId: `rcs-cold-leg-${lower}` },
      from: `sg-${lower}.primaryOut`,
      to: `rcp-${lower}.inlet`,
      waypoints: [
        { x: sgX, y: coldLegBranchY },
        { x: pumpCenterX, y: coldLegBranchY },
      ],
      binds: { flow: { label: 'Cold-leg flow', path: `rcs-cold-leg-${lower}.flowKgPerS`, digits: 0 } },
      style: { service: 'primary' },
    },
    {
      id: `rcp-${lower}-to-core`,
      label: `Loop ${loop} pump discharge`,
      source: { connectionId: `rcp-${lower}-to-core` },
      from: `rcp-${lower}.outlet`,
      to: `reactor-vessel.coldLeg${loop}`,
      waypoints: [
        { x: pumpCenterX, y: pumpReturnY },
        { x: returnHeaderX, y: pumpReturnY },
        { x: returnHeaderX, y: coldLegY },
      ],
      binds: { flow: { label: 'Pump flow', path: `rcp${loop}.loopFlowKgPerS`, digits: 0 } },
      style: { service: 'primary' },
    },
  ] as const
}

const loopIndex = (loop: LoopLetter): number => loopLetters.indexOf(loop)

const secondaryPaths = (loop: LoopLetter, sgX: number) => {
  const lower = lowerLoop(loop)
  const laneCenter = sgX + 113
  const steamHeaderY = 212
  const feedwaterHeaderY = 738
  const feedwaterBranchY = 700
  return [
    {
      id: `steam-${lower}-to-header`,
      label: `SG ${loop} steam`,
      source: { connectionId: `sg-${lower}-steam-to-msiv-${lower}` },
      from: `sg-${lower}.steamOut`,
      to: `main-steam-header.in${loop}`,
      waypoints: [
        { x: laneCenter, y: steamHeaderY },
      ],
      binds: { flow: { label: 'Steam flow', path: `sg-${lower}-steam-to-msiv-${lower}.flowKgPerS`, digits: 0 } },
      style: { service: 'steam' },
    },
    {
      id: `feedwater-to-sg-${lower}`,
      label: `SG ${loop} feedwater`,
      source: { connectionId: `feedwater-control-valve-${lower}-to-sg-${lower}` },
      from: `feedwater-header.out${loop}`,
      to: `sg-${lower}.feedwaterIn`,
      waypoints: [
        { x: laneCenter, y: feedwaterHeaderY },
        { x: laneCenter, y: feedwaterBranchY },
      ],
      binds: { flow: { label: 'Feedwater flow', path: `feedwater-control-valve-${lower}-to-sg-${lower}.flowKgPerS`, digits: 0 } },
      style: { service: 'feedwater' },
    },
  ] as const
}

const sgXs: Record<LoopLetter, number> = { A: 464, B: 688, C: 912, D: 1136 }

export const processPlantUnitOverviewSurface = processSurfaceDefinitionSchema.parse({
  schemaVersion: 1,
  id: 'unit-overview',
  title: 'PWR Unit Overview',
  description: 'Information-rich overview display for one pressurized-water-reactor unit.',
  designSize: { width: 1600, height: 900 },
  lenses: [
    { id: 'all', label: 'Full overview', description: 'Show the authored overview surface.' },
    {
      id: 'primary',
      label: 'Primary coolant',
      description: 'Project primary coolant components and paths.',
      lens: { mode: 'service-layer', service: 'primaryCoolant' },
    },
    {
      id: 'steam',
      label: 'Steam path',
      description: 'Project main steam and exhaust paths.',
      lens: { mode: 'service-layer', service: 'mainSteam' },
    },
    {
      id: 'feedwater',
      label: 'Feedwater',
      description: 'Project feedwater components and paths.',
      lens: { mode: 'service-layer', service: 'feedwater' },
    },
  ],
  regions: [
    { id: 'unit-status', label: 'Unit status', role: 'unit-status', order: 0 },
    { id: 'primary', label: 'Primary system', role: 'primary-system', order: 1 },
    { id: 'heat-transfer', label: 'Steam generators', role: 'heat-transfer', order: 2 },
    { id: 'secondary', label: 'Secondary system', role: 'secondary-system', order: 3 },
    { id: 'support', label: 'Support systems', role: 'support-system', order: 4 },
    { id: 'alarms', label: 'Alarms', role: 'alarms', order: 5 },
  ],
  widgets: [
    {
      id: 'unit-status-banner',
      type: 'statusBanner',
      label: 'Unit Status',
      region: 'unit-status',
      rank: 0,
      geometry: { x: 42, y: 32, width: 1516, height: 72 },
      binds: {
        thermalPower: { label: 'Thermal power', path: 'core.totalThermalPowerMw', digits: 0 },
        electricOutput: { label: 'Electric output', path: 'turbine.electricMw', digits: 0 },
        reactivity: { label: 'Effective reactivity', path: 'core.effectiveReactivityPcm', digits: 0 },
        pzrPressure: { label: 'RCS pressure', path: 'pressurizer.pressureMPa', digits: 2 },
        cooling: { label: 'Core cooling', path: 'core.coreCoolingAvailabilityFraction', digits: 2, display: 'percent' },
        heatDeficit: { label: 'Heat deficit', path: 'core.coreHeatRemovalDeficitMw', digits: 0 },
      },
      style: { tone: 'primary' },
    },
    {
      id: 'reactor-vessel',
      type: 'vessel',
      label: 'Reactor Vessel',
      region: 'primary',
      source: { componentIds: ['core', 'vessel'] },
      role: 'reactor-vessel',
      rank: 0,
      geometry: { x: 176, y: 292, width: 196, height: 272 },
      binds: {
        power: { label: 'Core power', path: 'core.totalThermalPowerMw', digits: 0 },
        coolant: { label: 'Coolant temp', path: 'vessel.meanPrimaryCoolantTemperatureC', digits: 0 },
        inventory: { label: 'Inventory', path: 'vessel.primaryCoolantInventoryKg', digits: 0 },
        cooling: { label: 'Cooling', path: 'core.coreCoolingAvailabilityFraction', digits: 2, display: 'percent' },
      },
      ports: {
        hotLegA: { x: 196, y: 74 },
        hotLegB: { x: 196, y: 116 },
        hotLegC: { x: 196, y: 158 },
        hotLegD: { x: 196, y: 200 },
        coldLegA: { x: 0, y: 72 },
        coldLegB: { x: 0, y: 114 },
        coldLegC: { x: 0, y: 156 },
        coldLegD: { x: 0, y: 198 },
      },
      style: { tone: 'primary' },
    },
    {
      id: 'reactor-protection',
      type: 'numericReadout',
      label: 'Reactor Protection',
      region: 'primary',
      source: { componentIds: ['core', 'reactorTripBreakerA', 'reactorTripBreakerB'] },
      role: 'reactor-protection',
      rank: 0,
      geometry: { x: 176, y: 574, width: 196, height: 64 },
      binds: {
        rods: { label: 'Rods', path: 'core.rodInsertionFraction', digits: 0, display: 'percent' },
        tripBreakerA: { label: 'Trip breaker A', path: 'reactorTripBreakerA.closed', display: 'state' },
        tripBreakerB: { label: 'Trip breaker B', path: 'reactorTripBreakerB.closed', display: 'state' },
      },
      style: { tone: 'primary' },
    },
    {
      id: 'pressurizer',
      type: 'vessel',
      label: 'Pressurizer',
      region: 'primary',
      source: { componentIds: ['pressurizer'] },
      role: 'pressurizer',
      rank: 1,
      geometry: { x: 196, y: 138, width: 152, height: 126 },
      binds: {
        level: { label: 'Level', path: 'pressurizer.levelPercent', digits: 0, display: 'percent' },
        pressure: { label: 'Pressure', path: 'pressurizer.pressureMPa', digits: 2 },
        relief: { label: 'Relief', path: 'pressurizer.reliefFlowKgPerS', digits: 1 },
      },
      ports: { surgeLine: { x: 76, y: 126 } },
      style: { tone: 'primary' },
    },
    ...loopLetters.map((loop, index) => sgWidget(loop, sgXs[loop], index)),
    ...loopLetters.map((loop, index) => rcpWidget(loop, rcpXFor(sgXs[loop]), index + 10)),
    {
      id: 'main-steam-header',
      type: 'numericReadout',
      label: 'Main Steam Header',
      region: 'secondary',
      source: { componentIds: ['mainSteamHeader'] },
      role: 'main-steam-header',
      rank: 0,
      geometry: { x: 544, y: 154, width: 760, height: 58 },
      binds: {
        flow: { label: 'Header flow', path: 'main-steam-header-to-turbine-stop-valve.flowKgPerS', digits: 0 },
      },
      ports: {
        inA: { x: 98, y: 58 },
        inB: { x: 286, y: 58 },
        inC: { x: 474, y: 58 },
        inD: { x: 662, y: 58 },
        outlet: { x: 760, y: 29 },
      },
      style: { tone: 'secondary' },
    },
    {
      id: 'turbine',
      type: 'pump',
      label: 'Turbine Generator',
      region: 'secondary',
      source: { componentIds: ['turbine'] },
      role: 'turbine-generator',
      rank: 1,
      geometry: { x: 1372, y: 298, width: 118, height: 118 },
      binds: {
        output: { label: 'Output', path: 'turbine.electricMw', digits: 0 },
        steam: { label: 'Steam use', path: 'turbine.steamFlowKgPerS', digits: 0 },
        availability: { label: 'Steam avail', path: 'turbine.steamAvailabilityFraction', digits: 2, display: 'percent' },
      },
      ports: { steamIn: { x: 0, y: 60 }, exhaust: { x: 59, y: 118 } },
      style: { tone: 'secondary' },
    },
    {
      id: 'condenser',
      type: 'vessel',
      label: 'Condenser',
      region: 'secondary',
      source: { componentIds: ['condenser'] },
      role: 'condenser',
      rank: 2,
      geometry: { x: 1324, y: 566, width: 214, height: 132 },
      binds: {
        level: { label: 'Hotwell', path: 'condenser.condensateLevelPercent', digits: 0, display: 'percent' },
        backPressure: { label: 'Backpressure', path: 'condenser.backPressurePa', digits: 0 },
        heatRejected: { label: 'Heat rejected', path: 'condenser.heatRejectedMw', digits: 0 },
        cooling: { label: 'CW avail', path: 'condenser.coolingWaterAvailabilityFraction', digits: 2, display: 'percent' },
      },
      ports: { steamIn: { x: 107, y: 0 }, condensateOut: { x: 28, y: 132 } },
      style: { tone: 'secondary' },
    },
    {
      id: 'feedwater-header',
      type: 'numericReadout',
      label: 'Feedwater Header',
      region: 'support',
      source: { componentIds: ['feedwaterTank', 'feedwaterHeader'] },
      role: 'feedwater-header',
      rank: 0,
      geometry: { x: 544, y: 738, width: 760, height: 58 },
      binds: {
        tankLevel: { label: 'Tank', path: 'feedwaterTank.levelPercent', digits: 0, display: 'percent' },
        availableFlow: { label: 'Available', path: 'feedwaterTank.availableOutletFlowKgPerS', digits: 0 },
        auxTank: { label: 'AFW tank', path: 'auxFeedwaterTank.levelPercent', digits: 0, display: 'percent' },
        auxAvailable: { label: 'AFW avail', path: 'auxFeedwaterTank.availableOutletFlowKgPerS', digits: 0 },
      },
      ports: {
        outA: { x: 98, y: 0 },
        outB: { x: 286, y: 0 },
        outC: { x: 474, y: 0 },
        outD: { x: 662, y: 0 },
      },
      style: { tone: 'support' },
    },
    {
      id: 'electrical',
      type: 'numericReadout',
      label: 'Safety Buses',
      region: 'support',
      source: { componentIds: ['safetyBusA', 'safetyBusB'] },
      role: 'electrical',
      rank: 1,
      geometry: { x: 1324, y: 730, width: 214, height: 66 },
      binds: {
        busA: { label: 'Bus A', path: 'safetyBusA.voltageFraction', digits: 2, display: 'percent' },
        busB: { label: 'Bus B', path: 'safetyBusB.voltageFraction', digits: 2, display: 'percent' },
        loadA: { label: 'Load A', path: 'safetyBusA.servedLoadMw', digits: 1 },
        loadB: { label: 'Load B', path: 'safetyBusB.servedLoadMw', digits: 1 },
      },
      style: { tone: 'support' },
    },
    {
      id: 'alarm-panel',
      type: 'alarmPanel',
      label: 'Alarm Panel',
      region: 'alarms',
      rank: 0,
      geometry: { x: 42, y: 800, width: 1516, height: 86 },
      binds: {},
      style: { tone: 'warning' },
    },
  ],
  paths: [
    ...loopLetters.flatMap(loop => primaryLoopPaths(loop, sgXs[loop])),
    ...loopLetters.flatMap(loop => secondaryPaths(loop, sgXs[loop])),
    {
      id: 'main-steam-to-turbine',
      label: 'Main steam to turbine',
      source: { connectionId: 'main-steam-header-to-turbine-stop-valve' },
      from: 'main-steam-header.outlet',
      to: 'turbine.steamIn',
      waypoints: [
        { x: 1350, y: 183 },
        { x: 1350, y: 358 },
      ],
      binds: { flow: { label: 'Header flow', path: 'main-steam-header-to-turbine-stop-valve.flowKgPerS', digits: 0 } },
      style: { service: 'steam' },
    },
    {
      id: 'turbine-exhaust-to-condenser',
      label: 'Turbine exhaust',
      source: { connectionId: 'turbine-exhaust-to-condenser' },
      from: 'turbine.exhaust',
      to: 'condenser.steamIn',
      waypoints: [
        { x: 1431, y: 486 },
        { x: 1431, y: 520 },
      ],
      binds: { flow: { label: 'Exhaust flow', path: 'turbine-exhaust-to-condenser.flowKgPerS', digits: 0 } },
      style: { service: 'steam' },
    },
  ],
})

export const processPlantReferenceSurfaces = [processPlantUnitOverviewSurface] as const
