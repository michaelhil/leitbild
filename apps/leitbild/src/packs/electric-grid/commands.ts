export const gridDispatchGeneratorCommandKind = 'electric-grid.dispatch-generator'
export const gridTripGeneratorCommandKind = 'electric-grid.trip-generator'
export const gridSetGeneratorAvailabilityCommandKind = 'electric-grid.set-generator-availability'
export const gridOpenBranchCommandKind = 'electric-grid.open-branch'
export const gridCloseBranchCommandKind = 'electric-grid.close-branch'
export const gridDerateBranchCommandKind = 'electric-grid.derate-branch'
export const gridClearDerateCommandKind = 'electric-grid.clear-derate'
export const gridShedLoadCommandKind = 'electric-grid.shed-load'
export const gridRestoreLoadCommandKind = 'electric-grid.restore-load'
export const gridSetEvChargingPolicyCommandKind = 'electric-grid.set-ev-charging-policy'

export const electricGridCommandKinds = [
  gridDispatchGeneratorCommandKind,
  gridTripGeneratorCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridOpenBranchCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridClearDerateCommandKind,
  gridShedLoadCommandKind,
  gridRestoreLoadCommandKind,
  gridSetEvChargingPolicyCommandKind,
] as const
