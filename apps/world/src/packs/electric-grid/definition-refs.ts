export const norwayGridModelRef = 'electric-grid.norway.transmission'
export const haldenFourUnitGridModelRef = 'electric-grid.halden.four-unit'
export const norwayNormalOperatingPointRef = 'electric-grid.norway.normal'
export const haldenFourUnitOperatingPointRef = 'electric-grid.halden.four-unit.normal'
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
  }, {
    id: haldenFourUnitGridModelRef,
    title: 'Halden four-unit transmission connection',
    description: 'Norway transmission topology with a dedicated 420 kV Halden switchyard and four independently connectable unit bays.',
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
  }, {
    id: haldenFourUnitOperatingPointRef,
    title: 'Halden four-unit normal operation',
    description: 'Balanced Norwegian demand and conventional dispatch before the four connected units enter the runtime exchange.',
    compatibleModelRefs: [haldenFourUnitGridModelRef],
  }],
  automations: [{
    id: norwayStandardAutomationRef,
    title: 'Standard grid controls',
    description: 'Daily load profiles, actual generator primary response, storage response, and under-frequency load shedding.',
    compatibleModelRefs: [norwayGridModelRef, haldenFourUnitGridModelRef],
  }],
} as const
