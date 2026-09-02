import { z } from 'zod'
import type { ComponentInstanceSpec, PlantGraphSpec } from '../graph/index.ts'
import { reactorInitialThermalState } from '../reactor-initial-conditions.ts'
import { condenserThermalBalance } from '../runtime/condenser-thermodynamics.ts'
import { latentHeatSteamMjPerKg, saturationTemperatureCFromPressureMPa, specificHeatWaterKjPerKgK } from '../runtime/thermophysics.ts'

/** Fixed total Plant rating, divided over the selected loops. These are model
 * sizing equations, evaluated once before compilation, never output corrections. */
export const pwrFullPowerParameters = (graph: PlantGraphSpec, authored: Readonly<Record<string, unknown>>): Record<string, Record<string, unknown>> => {
  const overrides = Object.fromEntries(Object.entries(authored).map(([id, value]) => [id, z.record(z.string(), z.unknown()).parse(value)]))
  const result: Record<string, Record<string, unknown>> = { ...overrides }
  const effective = (component: ComponentInstanceSpec) => ({ ...component.parameters as Record<string, unknown>, ...result[component.id] })
  const set = (component: ComponentInstanceSpec, values: Record<string, unknown>) => { result[component.id] = { ...values, ...overrides[component.id] } }
  const core = graph.components.find(component => component.kind === 'reactorCore')
  const turbine = graph.components.find(component => component.kind === 'turbineLoadSink')
  const condenser = graph.components.find(component => component.kind === 'condenserSink')
  const generators = graph.components.filter(component => component.kind === 'steamGenerator')
  if (!core || !turbine || !condenser || generators.length < 1) throw new Error('PWR operating point requires core, steam generators, turbine and condenser')
  set(core, { initialPowerFraction: 1 })
  const coreParameters = effective(core)
  const thermal = reactorInitialThermalState(coreParameters)
  const thermalMw = Number(coreParameters.ratedPowerMw) * Number(coreParameters.initialPowerFraction) * (1 + Number(coreParameters.decayHeatFractionAtPower ?? 0.06))
  const primaryFlow = Number(coreParameters.nominalPrimaryFlowKgPerS)
  const steamFlow = thermalMw / latentHeatSteamMjPerKg
  set(core, { ...result[core.id], referenceCoolantOutletTemperatureC: thermal.outlet, referenceFuelTemperatureC: thermal.average })
  for (const generator of generators) {
    const p = effective(generator)
    const secondary = saturationTemperatureCFromPressureMPa(Number(p.nominalPressureMPa))
    const recirculation = Math.max(0.8, Math.min(1.35, 0.65 + Number(p.recirculationRatio ?? 4) * 0.09))
    // The lumped tube equation limits primary heat by flow * cp * (hot - tube).
    // At design balance the tube is the cold-end datum, not the hot/secondary mean.
    const tube = thermal.inlet
    if (thermal.inlet <= secondary || thermal.outlet <= tube) throw new Error('PWR full-power operating point has no positive primary/secondary temperature approach')
    set(generator, {
      initialSteamFlowFraction: 1, nominalSteamFlowKgPerS: steamFlow / generators.length,
      heatTransferCoefficientMwPerK: thermalMw / generators.length / (recirculation * (tube - secondary)),
      initialPrimaryInletTemperatureC: thermal.outlet, initialPrimaryOutletTemperatureC: thermal.inlet,
      initialSecondaryTemperatureC: secondary, tubeMetalInitialTemperatureC: tube,
    })
  }
  const c = effective(condenser)
  const t = effective(turbine)
  const exhaustTemperature = Number(t.exhaustTemperatureAtFullLoadC ?? 145)
  const baseline = {
    steamFlow, steamTemperature: exhaustTemperature, nominalSteamFlow: steamFlow,
    coolingWaterInletTemperature: Number(c.coolingWaterTemperatureC),
    coolingWaterDesignDeltaT: Number(c.coolingWaterDesignDeltaTK), condensateApproach: Number(c.condensateApproachTemperatureK),
  }
  const heat = condenserThermalBalance({ ...baseline, coolingWaterFlow: Number(c.nominalCoolingWaterFlowKgPerS) }).requiredHeatRemoval
  const coolingWaterFlow = heat * 1_000 / (specificHeatWaterKjPerKgK * baseline.coolingWaterDesignDeltaT)
  const balancedCondenser = condenserThermalBalance({ ...baseline, coolingWaterFlow })
  set(condenser, { nominalSteamFlowKgPerS: steamFlow, maxCondensateOutletFlowKgPerS: steamFlow, nominalCoolingWaterFlowKgPerS: coolingWaterFlow,
    initialSteamFlowFraction: 1, initialSteamTemperatureC: exhaustTemperature })
  set(turbine, { initialLoadFraction: 1, nominalSteamFlowKgPerS: steamFlow, nominalSteamPressureMPa: Number(effective(generators[0]!).nominalPressureMPa), nominalBackPressurePa: balancedCondenser.targetBackPressure })
  const pumpsFor = (service: string) => graph.components.filter(component => component.kind === 'centrifugalPump' && graph.connections.some(link => String(link.from).startsWith(`${component.id}.`) && link.service === service))
  for (const [service, flow] of [['primaryCoolant', primaryFlow], ['feedwater', steamFlow], ['condensate', steamFlow], ['coolingWater', coolingWaterFlow]] as const) {
    const pumps = pumpsFor(service)
    if (pumps.length === 0) throw new Error(`PWR operating point has no ${service} pump`)
    for (const pump of pumps) {
      const p = effective(pump)
      const loopId = p.primaryLoopId
      const loopResistance = service === 'primaryCoolant' ? graph.connections.filter(link => link.service === 'primaryCoolant' && link.metadata?.loopId === loopId).reduce((sum, link) => sum + Number(link.physical?.nominalResistance ?? 0), 0) / 0.5 : 0
      const resistanceFactor = 1 + loopResistance + Number(p.loopResistanceCoefficient ?? 0)
      set(pump, { nominalFlowKgPerS: flow / pumps.length * Math.sqrt(resistanceFactor) })
    }
  }
  for (const component of graph.components) {
    if (component.kind === 'reactorVessel') set(component, { referencePrimaryCoolantTemperatureC: (thermal.inlet + thermal.outlet) / 2 })
    if (component.kind === 'processTank' && graph.connections.some(link => String(link.from).startsWith(`${component.id}.`) && link.service === 'feedwater')) set(component, { makeupFlowKgPerS: 0, maxOutletFlowKgPerS: steamFlow })
    if (component.kind === 'processTank' && graph.connections.some(link => String(link.from).startsWith(`${component.id}.`) && link.service === 'coolingWater')) set(component, { makeupFlowKgPerS: coolingWaterFlow, maxOutletFlowKgPerS: coolingWaterFlow })
    if (component.kind === 'processValve' && graph.connections.some(link => String(link.from).startsWith(`${component.id}.`) && link.service === 'feedwater')) {
      const p = effective(component)
      const controller = z.record(z.string(), z.unknown()).parse(p.controller)
      set(component, { initialPositionFraction: 1, controller: { ...controller, biasPositionFraction: 1 } })
    }
  }
  return result
}
