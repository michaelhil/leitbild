/** Finite energy accounting for a battery with an optional integrated charger.
 * MW·s is MJ. The charger serves the live load first; spare output charges
 * finite storage. Its conversion loss and storage charging loss are explicit.
 * This is a constant-voltage storage model, not battery electrochemistry. */
export const dcSupplyStep = (input: {
  readonly energyMj: number
  readonly capacityMj: number
  readonly batteryPowerMw: number
  readonly loadMw: number
  readonly chargerAvailableMw: number
  readonly chargerEfficiency: number
  readonly chargeEfficiency: number
  readonly dtSeconds: number
}) => {
  const { capacityMj, batteryPowerMw, loadMw, chargerAvailableMw, chargerEfficiency, chargeEfficiency, dtSeconds } = input
  const energy = Math.max(0, Math.min(capacityMj, input.energyMj))
  const chargerToLoad = Math.min(loadMw, chargerAvailableMw)
  const shortage = Math.max(0, loadMw - chargerToLoad)
  const dischargePowerMw = Math.min(shortage, batteryPowerMw, dtSeconds > 0 ? energy / dtSeconds : energy > 0 ? batteryPowerMw : 0)
  const spare = Math.max(0, chargerAvailableMw - chargerToLoad)
  const toStorage = Math.min(spare, dtSeconds > 0 ? (capacityMj - energy) / (dtSeconds * chargeEfficiency) : energy < capacityMj ? spare : 0)
  const chargePowerMw = toStorage * chargeEfficiency
  const chargerOutputMw = chargerToLoad + toStorage
  const chargerInputMw = chargerOutputMw / chargerEfficiency
  const conversionLossMw = chargerInputMw - chargerOutputMw + toStorage - chargePowerMw
  const nextEnergyMj = Math.max(0, Math.min(capacityMj, energy + (chargePowerMw - dischargePowerMw) * dtSeconds))
  return { energyMj: nextEnergyMj, dischargePowerMw, chargePowerMw, chargerInputMw, chargerOutputMw, conversionLossMw,
    unservedLoadMw: Math.max(0, shortage - dischargePowerMw),
    availablePowerMw: chargerAvailableMw + (nextEnergyMj > 0 ? batteryPowerMw : 0) }
}
