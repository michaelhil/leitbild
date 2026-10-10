import type { ProcessPlantIcAnnunciatorSystem } from '../runtime/index.ts'

// The reference PWR's annunciator systems, declared once in the order its
// displays show them. Each alarm and trip names one by id.

export const referenceAnnunciatorSystems = [
  { id: 'reactorProtection', label: 'Reactor protection', shortLabel: 'RPS' },
  { id: 'reactorCoolantSystem', label: 'Reactor coolant system', shortLabel: 'RCS' },
  { id: 'steamGenerators', label: 'Steam generators', shortLabel: 'SG' },
  { id: 'safetyInjection', label: 'Safety injection', shortLabel: 'SI' },
  { id: 'containment', label: 'Containment', shortLabel: 'CTMT' },
  { id: 'electrical', label: 'Electrical', shortLabel: 'ELEC' },
  { id: 'feedwater', label: 'Feedwater', shortLabel: 'FW' },
  { id: 'balanceOfPlant', label: 'Balance of plant', shortLabel: 'BOP' },
  { id: 'mainSteam', label: 'Main steam', shortLabel: 'MS' },
] as const satisfies ReadonlyArray<ProcessPlantIcAnnunciatorSystem>

export type ReferenceAnnunciatorSystemId = (typeof referenceAnnunciatorSystems)[number]['id']
