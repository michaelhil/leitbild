import { gridModelAdditions } from './model-additions.ts'

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
  }, ...gridModelAdditions.map(model => ({
    id: model.id, title: model.title, description: model.description,
    nominalFrequencyHz: 50,
    fidelity: { powerFlow: 'dc', voltage: 'approximate', frequency: 'aggregate-dynamic', recommendedMaximumBusCount: 1_000 } as const,
  }))],
  operatingPoints: [{
    id: norwayNormalOperatingPointRef,
    title: 'Normal winter weekday',
    description: 'Winter weekday demand, available generation, and initial storage charge.',
    compatibleModelRefs: [norwayGridModelRef, ...gridModelAdditions.map(model => model.id)],
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
    compatibleModelRefs: [norwayGridModelRef, ...gridModelAdditions.map(model => model.id)],
  }],
} as const
