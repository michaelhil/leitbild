import { component, connect, plantGraph } from '../graph/index.ts'

export const pwrLitePlantSpec = plantGraph({
  id: 'pwr.westinghouse-lite.v1',
  title: 'Westinghouse-style PWR Lite',
  fixedStepMs: 100,
  components: [
    component('core', 'reactorCoreLite', 'Reactor Core', {
      ratedPowerMw: 3400,
      initialPowerFraction: 0.85,
    }),
    component('sgA', 'steamGeneratorLite', 'Steam Generator A', {
      nominalPressureMPa: 6.9,
      nominalLevelPercent: 0.55,
      heatTransferCoefficientMwPerK: 12,
    }),
    component('rcpA', 'centrifugalPump', 'Reactor Coolant Pump A', {
      nominalFlowKgPerS: 4700,
      nominalHeadPa: 650_000,
    }),
    component('feedwaterA', 'feedwaterSourceLite', 'Feedwater Train A', {
      nominalFlowKgPerS: 760,
      temperatureC: 220,
    }),
    component('turbine', 'turbineLoadSinkLite', 'Turbine Generator', {
      nominalElectricMw: 1100,
      initialLoadFraction: 0.85,
    }),
  ],
  connections: [
    connect('rcs-hot-leg-a', 'core.hotLegA', 'sgA.primaryInlet', { medium: 'primary-water' }),
    connect('rcs-cold-leg-a', 'sgA.primaryOutlet', 'rcpA.inlet', { medium: 'primary-water' }),
    connect('rcp-a-to-core', 'rcpA.outlet', 'core.coldLegA', { medium: 'primary-water' }),
    connect('fw-a-to-sg-a', 'feedwaterA.outlet', 'sgA.feedwaterInlet', { medium: 'feedwater' }),
    connect('sg-a-steam-to-turbine', 'sgA.steamOutlet', 'turbine.steamInlet', { edgeKind: 'steamFlow', medium: 'steam' }),
  ],
  publishedVariables: [
    'core.powerMw',
    'sgA.levelPercent',
    'sgA.pressureMPa',
    'rcpA.running',
    'feedwaterA.flowKgPerS',
    'turbine.electricMw',
  ],
})
