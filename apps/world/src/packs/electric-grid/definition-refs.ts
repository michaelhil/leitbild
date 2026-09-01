export const norwayGridModelRef = 'electric-grid.norway.transmission'
export const norwayNormalOperatingPointRef = 'electric-grid.norway.normal'
export const norwayStandardAutomationRef = 'electric-grid.norway.standard'

export const electricGridDefinitionCatalog = {
  models: [{
    id: norwayGridModelRef,
    title: 'Norway transmission grid',
    description: 'Source-derived Norwegian transmission topology with major generation and aggregate demand zones.',
    nominalFrequencyHz: 50,
  }],
  operatingPoints: [{ id: norwayNormalOperatingPointRef, title: 'Normal winter weekday' }],
  automations: [{ id: norwayStandardAutomationRef, title: 'Standard grid controls' }],
} as const
