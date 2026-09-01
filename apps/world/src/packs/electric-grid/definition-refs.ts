export const norwayGridModelRef = 'electric-grid.norway.transmission'
export const norwayNormalOperatingPointRef = 'electric-grid.norway.normal'
export const norwayStandardAutomationRef = 'electric-grid.norway.standard'

export const electricGridDefinitionCatalog = {
  models: [{
    id: norwayGridModelRef,
    title: 'Norway transmission grid',
    description: 'Source-derived Norwegian transmission topology with major generation and aggregate demand zones.',
    nominalFrequencyHz: 50,
    fidelity: {
      powerFlow: 'dc',
      voltage: 'approximate',
      frequency: 'aggregate-dynamic',
      recommendedMaximumBusCount: 1_000,
    },
  }],
  operatingPoints: [{
    id: norwayNormalOperatingPointRef,
    title: 'Normal winter weekday',
    description: 'Winter weekday demand, available generation, and initial storage charge.',
    compatibleModelRefs: [norwayGridModelRef],
  }],
  automations: [{
    id: norwayStandardAutomationRef,
    title: 'Standard grid controls',
    description: 'Daily load profiles, storage frequency response, and under-frequency load shedding.',
    compatibleModelRefs: [norwayGridModelRef],
  }],
} as const
