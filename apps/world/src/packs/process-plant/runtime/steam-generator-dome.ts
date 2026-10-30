import { steamGeneratorOperatingLevel } from '../steam-generator-operating-level.ts'
import type { CompiledComponent } from '../graph/index.ts'
import { optionalParameterNumber, parameterNumber } from './component-helpers.ts'
import { compressedWaterState, criticalPressureMPa, minimumTabulatedSaturationPressureMPa, saturatedWaterSteam, saturationPressureMPaFromVapourDensity } from './water-properties.ts'

type Dome = { readonly totalVolumeM3: number }
const domes = new WeakMap<CompiledComponent, Dome>()
const domeFor = (component: CompiledComponent): Dome => {
  const existing = domes.get(component)
  if (existing !== undefined) return existing
  const nominalPressure = parameterNumber(component, 'nominalPressureMPa'), saturation = saturatedWaterSteam(nominalPressure)
  const liquid = optionalParameterNumber(component, 'nominalSecondaryInventoryKg', 56_000)
    * steamGeneratorOperatingLevel(component.parameters as Record<string, unknown>).collapsed / 100
  const steam = optionalParameterNumber(component, 'nominalSteamMassKg', 12_000)
  const liquidDensity = compressedWaterState(optionalParameterNumber(component, 'initialSecondaryTemperatureC', saturation.temperatureC), nominalPressure).densityKgPerM3
  const dome = { totalVolumeM3: liquid / liquidDensity + steam / saturation.vapourDensityKgPerM3 }
  domes.set(component, dome)
  return dome
}

/** Reduced saturated-dome pressure closure: one fixed volume inferred from
 * the authored nominal liquid/steam inventories, then current actual steam
 * mass divided by the space the current liquid leaves. Steam outflow already
 * changes mass; a second nominal demand-pressure bias would count it twice.
 * Liquid sensible energy, nonequilibrium phase transport and water-solid
 * overfill are not established by this pressure closure. */
export const steamGeneratorDomeState = (component: CompiledComponent, input: {
  readonly liquidInventoryKg: number
  readonly liquidTemperatureC: number
  readonly steamMassKg: number
  readonly pressureMPa: number
}) => {
  const liquidDensity = compressedWaterState(input.liquidTemperatureC, input.pressureMPa).densityKgPerM3
  const steamSpaceVolumeM3 = domeFor(component).totalVolumeM3 - input.liquidInventoryKg / liquidDensity
  if (!(steamSpaceVolumeM3 > 0)) throw Error(`steam generator ${component.id} has no steam space; water-solid pressure is outside its represented dome model`)
  const steamDensityKgPerM3 = Math.max(0, input.steamMassKg) / steamSpaceVolumeM3
  const pressureMPa = Math.max(minimumTabulatedSaturationPressureMPa, Math.min(criticalPressureMPa, saturationPressureMPaFromVapourDensity(steamDensityKgPerM3)))
  return { steamSpaceVolumeM3, steamDensityKgPerM3, pressureMPa }
}
