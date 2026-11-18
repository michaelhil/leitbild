import type { GenerateInput } from './api.ts'
import { planOptions, type DatedRow, type OptionView, type PlanModel } from './model.ts'

export const maintenanceDefinitionId = 'nuclear-maintenance-planning'
export const maintenancePlantId = 'plant:maintenance'
export const extraMaintenanceCrew = 'extra-maintenance-crew'

/** Explicit navigation authored for this demonstration; Planning fact locators remain opaque. */
export const maintenanceEquipmentElement = (key: string): string | null => ({
  SWA: 'serviceWaterPumpA', CCWA: 'componentCoolingWaterPumpA', CCWHXA: 'componentCoolingHeatExchangerA',
} as Readonly<Record<string, string>>)[key] ?? null

export const maintenanceVariants: GenerateInput = {
  seconds: 5,
  variants: [
    { label: 'One crew', methods: [], buy: [] },
    { label: 'Extra crew', methods: [], buy: [extraMaintenanceCrew] },
  ],
}

/** Existing demonstrations retain their actual labels; contractor work windows name the intervention. */
export const maintenanceVariantsFor = (model: PlanModel): GenerateInput => {
  const existing = planOptions(model)
  const contractor = model.inputs.purchases.find(purchase => purchase.key === extraMaintenanceCrew)?.label.toLowerCase().includes('contractor') ?? false
  return { seconds: 5, variants: [
    { label: existing.find(option => !option.variant.purchases.includes(extraMaintenanceCrew))?.label ?? (contractor ? 'Existing crews' : 'One crew'), methods: [], buy: [] },
    { label: existing.find(option => option.variant.purchases.includes(extraMaintenanceCrew))?.label ?? (contractor ? 'With HX contractor' : 'Extra crew'), methods: [], buy: [extraMaintenanceCrew] },
  ] }
}

export const maintenanceFinish = (rows: readonly DatedRow[]): number | null =>
  rows.length === 0 ? null : Math.max(...rows.map(row => Date.parse(row.finish)))

export const maintenanceCost = (model: PlanModel, option: OptionView): number | null => {
  if (option.status.word !== 'validated feasible') return null
  const index = model.inputs.goals.findIndex(goal => goal.metric === 'extra-cost')
  return option.status.goals.find(goal => goal.goal === index)?.value ?? null
}

export const maintenanceQuestion = (model: PlanModel, question: string): string => [
  question,
  `I am asking about the focused plan ${model.title}, revision ${model.revision}, in the nuclear maintenance demonstration. Use the plan's work date and ${model.inputs.settings.timeZone} time zone for a time without a date. Check the available crew choices and show the checked schedules against my requested deadline, with a brief recommendation and the reason.`,
].join('\n\n')

export const maintenancePrompt = (model: PlanModel, selected: OptionView): string => [
  'Help me understand the engineering calculation beside this maintenance schedule.',
  `The focused plan is ${model.title}, revision ${model.revision}. I am viewing its option ${selected.label} (${selected.key}). Read its summary through Planning's published operation for context. Focus the answer on the heat-transport calculation.`,
  'From the focused nuclear-maintenance-planning World run, use world.engineering.inputs.capture with profile plant-maintenance and subjectId plant:maintenance. Bind the retained componentCoolingWaterPumpB.flowKgPerS observation, including its units, quality and simulation time.',
  'Use engineering_run to calculate heat transported in MW from that pump mass flow multiplied by an assumed water heat capacity of 4.18 kJ/(kg K) and an assumed temperature rise of 10 K, divided by 1000. Use named bindings called pumpFlow, heatCapacity and temperatureRise, with only pumpFlow taken from the retained World capture.',
  'Return a flat output object with heatTransportMw. Show the equation, calculated value and the retained engineering result view so I can inspect the inputs and change the two assumptions. Inspect the execution outcome before reporting success. Keep your explanation brief.',
  'The maintenance schedule is a forecast. Use the captured pre-maintenance simulated pump flow, taken while both pumps are running. The temperature rise is an assumption. This estimate does not assess heat-exchanger duty, cooling adequacy or permission to perform maintenance.',
].join('\n\n')
