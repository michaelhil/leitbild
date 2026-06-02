import type { VariablePath } from './graph/index.ts'

export interface ProcessPlantDemoTransientCommand {
  readonly path: VariablePath
  readonly value: number | boolean
}

export interface ProcessPlantDemoTransientField {
  readonly id: string
  readonly label: string
  readonly unit: string
  readonly defaultValue: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly digits: number
}

export interface ProcessPlantDemoTransient {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly fields: ReadonlyArray<ProcessPlantDemoTransientField>
  readonly commands: (values: Readonly<Record<string, number>>) => ReadonlyArray<ProcessPlantDemoTransientCommand>
}

const path = (value: string): VariablePath => value as VariablePath

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const fieldValue = (
  fields: ReadonlyArray<ProcessPlantDemoTransientField>,
  values: Readonly<Record<string, number>>,
  id: string,
): number => {
  const field = fields.find(candidate => candidate.id === id)
  if (!field) throw new Error(`unknown process plant demo transient field: ${id}`)
  const value = values[id]
  return clamp(typeof value === 'number' && Number.isFinite(value) ? value : field.defaultValue, field.min, field.max)
}

const percentToFraction = (value: number): number => value / 100

const sgTubeLeakFields = [{
  id: 'leakPercent',
  label: 'Leak',
  unit: '%',
  defaultValue: 1.2,
  min: 0.1,
  max: 4,
  step: 0.1,
  digits: 1,
}] as const

const reliefFields = [{
  id: 'positionPercent',
  label: 'Open',
  unit: '%',
  defaultValue: 35,
  min: 5,
  max: 100,
  step: 5,
  digits: 0,
}] as const

const feedwaterRunbackFields = [{
  id: 'positionPercent',
  label: 'Valve',
  unit: '%',
  defaultValue: 5,
  min: 0,
  max: 40,
  step: 5,
  digits: 0,
}] as const

export const processPlantDemoTransients: ReadonlyArray<ProcessPlantDemoTransient> = [
  {
    id: 'sg-a-tube-leak',
    label: 'SG A tube leak',
    description: 'Introduce a primary-to-secondary leak in SG A; radiation, tube-leak, pressure, and level indicators respond.',
    fields: sgTubeLeakFields,
    commands: values => [{
      path: path('sgA.tubeLeakFraction'),
      value: percentToFraction(fieldValue(sgTubeLeakFields, values, 'leakPercent')),
    }],
  },
  {
    id: 'trip-all-rcps',
    label: 'Trip all RCPs',
    description: 'Trip the four reactor coolant pumps; loop flow and pump status respond through the primary system.',
    fields: [],
    commands: () => ['A', 'B', 'C', 'D'].map(loop => ({
      path: path(`rcp${loop}.running`),
      value: false,
    })),
  },
  {
    id: 'loss-main-feedwater',
    label: 'Loss of main feedwater',
    description: 'Trip both main feedwater pumps; feedwater flow and SG levels respond as the runtime evolves.',
    fields: [],
    commands: () => [
      { path: path('mainFeedwaterPumpA.running'), value: false },
      { path: path('mainFeedwaterPumpB.running'), value: false },
    ],
  },
  {
    id: 'sg-b-feedwater-runback',
    label: 'SG B feedwater runback',
    description: 'Drive the SG B feedwater control valve low; useful for showing level imbalance across the SG group.',
    fields: feedwaterRunbackFields,
    commands: values => [{
      path: path('feedwaterControlValveB.positionFraction'),
      value: percentToFraction(fieldValue(feedwaterRunbackFields, values, 'positionPercent')),
    }],
  },
  {
    id: 'pressurizer-relief-open',
    label: 'PZR relief stuck open',
    description: 'Open the pressurizer relief path; pressure, relief flow, and primary inventory respond.',
    fields: reliefFields,
    commands: values => [{
      path: path('pressurizer.reliefValvePositionFraction'),
      value: percentToFraction(fieldValue(reliefFields, values, 'positionPercent')),
    }],
  },
  {
    id: 'turbine-trip',
    label: 'Turbine trip',
    description: 'Close the turbine stop valve and reject load; electrical output and main steam flow collapse.',
    fields: [],
    commands: () => [
      { path: path('turbineStopValve.positionFraction'), value: 0 },
      { path: path('turbine.loadFraction'), value: 0 },
    ],
  },
  {
    id: 'loss-offsite-power',
    label: 'Loss of offsite power',
    description: 'Open offsite breakers and mark the grid unavailable; safety buses and EDG start logic respond.',
    fields: [],
    commands: () => [
      { path: path('offsiteGrid.available'), value: false },
      { path: path('offsiteBreakerA.closed'), value: false },
      { path: path('offsiteBreakerB.closed'), value: false },
    ],
  },
] as const

export const defaultProcessPlantDemoTransientInputs = (
  transient: ProcessPlantDemoTransient,
): Readonly<Record<string, number>> =>
  Object.fromEntries(transient.fields.map(field => [field.id, field.defaultValue]))

export const processPlantDemoTransientCommands = (
  transient: ProcessPlantDemoTransient,
  values: Readonly<Record<string, number>>,
): ReadonlyArray<ProcessPlantDemoTransientCommand> => transient.commands(values)
