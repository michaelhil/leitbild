/** Nominal level is indicated level, including the steady boiling swell.
 * Share this relation between initialization and the inventory pressure datum. */
export const steamGeneratorOperatingLevel = (parameters: Readonly<Record<string, unknown>>) => {
  const recirculation = Math.max(1, Math.min(1.35, 1 + (Number(parameters.recirculationRatio ?? 1) - 1) * 0.06))
  const voidFraction = Math.min(0.45, Number(parameters.voidFractionAtNominalBoiling ?? 0.16) * recirculation * Number(parameters.initialSteamFlowFraction ?? 0))
  const swell = Math.min(35, voidFraction * Number(parameters.swellLevelGainPercent ?? 26))
  const collapsed = Number(parameters.nominalLevelPercent) * 100 - swell
  if (collapsed <= 0) throw new Error('Nominal steam-generator indicated level must exceed boiling swell')
  return { voidFraction, swell, collapsed }
}
