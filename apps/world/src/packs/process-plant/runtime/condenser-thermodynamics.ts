import { clamp } from './component-helpers.ts'
import { heatMwFromWaterFlowAndDeltaT, latentHeatSteamMjPerKg, specificHeatWaterKjPerKgK } from './thermophysics.ts'

/** The simplified condenser relation, shared by runtime and operating-point sizing. */
export const condenserThermalBalance = (input: {
  steamFlow: number; steamTemperature: number; nominalSteamFlow: number;
  coolingWaterFlow: number; coolingWaterInletTemperature: number;
  coolingWaterDesignDeltaT: number; condensateApproach: number;
}) => {
  const { steamFlow, steamTemperature, nominalSteamFlow, coolingWaterFlow, coolingWaterInletTemperature, coolingWaterDesignDeltaT, condensateApproach } = input
  const coolingWaterHeatCapacity = heatMwFromWaterFlowAndDeltaT(coolingWaterFlow, coolingWaterDesignDeltaT)
  const load = clamp(steamFlow / nominalSteamFlow, 0, 1.5)
  const baseTemperature = coolingWaterInletTemperature + condensateApproach + load * 18 + clamp((steamTemperature - 120) / 80, 0, 1) * 8
  const requiredHeatRemoval = steamFlow * latentHeatSteamMjPerKg + heatMwFromWaterFlowAndDeltaT(steamFlow, Math.max(0, steamTemperature - baseTemperature))
  const condensingAvailability = requiredHeatRemoval > 0 ? clamp(coolingWaterHeatCapacity / requiredHeatRemoval, 0, 1) : 1
  const condensateProduction = steamFlow * condensingAvailability
  const targetCondensateTemperature = baseTemperature + (1 - condensingAvailability) * 45
  const heatRejected = condensateProduction * latentHeatSteamMjPerKg + heatMwFromWaterFlowAndDeltaT(condensateProduction, Math.max(0, steamTemperature - targetCondensateTemperature))
  const coolingWaterOutletTemperature = coolingWaterFlow > 0 ? coolingWaterInletTemperature + heatRejected * 1_000 / (coolingWaterFlow * specificHeatWaterKjPerKgK) : coolingWaterInletTemperature
  const targetBackPressure = 7_000 + load * 5_000
    + clamp((coolingWaterInletTemperature - 28) / 70, 0, 1) * 35_000
    + (1 - condensingAvailability) * 65_000
    + clamp((targetCondensateTemperature - (coolingWaterInletTemperature + condensateApproach)) / 30, 0, 1) * 2_000
  return { coolingWaterHeatCapacity, requiredHeatRemoval, condensingAvailability, condensateProduction, targetCondensateTemperature, heatRejected, coolingWaterOutletTemperature, targetBackPressure }
}
