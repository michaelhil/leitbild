import { z } from 'zod'
import type { PackRuntimeOperationDescriptor } from '../../simulation/protocol.ts'

export const gridDispatchGeneratorCommandKind = 'electric-grid.dispatch-generator'
export const gridTripGeneratorCommandKind = 'electric-grid.trip-generator'
export const gridSetGeneratorAvailabilityCommandKind = 'electric-grid.set-generator-availability'
export const gridReturnGeneratorToServiceCommandKind = 'electric-grid.return-generator-to-service'
export const gridOpenBranchCommandKind = 'electric-grid.open-branch'
export const gridCloseBranchCommandKind = 'electric-grid.close-branch'
export const gridDerateBranchCommandKind = 'electric-grid.derate-branch'
export const gridClearDerateCommandKind = 'electric-grid.clear-derate'
export const gridShedLoadCommandKind = 'electric-grid.shed-load'
export const gridRestoreLoadCommandKind = 'electric-grid.restore-load'
export const gridSetEvChargingDemandCommandKind = 'electric-grid.set-ev-charging-demand'

export const electricGridCommandKinds = [
  gridDispatchGeneratorCommandKind,
  gridTripGeneratorCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridReturnGeneratorToServiceCommandKind,
  gridOpenBranchCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridClearDerateCommandKind,
  gridShedLoadCommandKind,
  gridRestoreLoadCommandKind,
  gridSetEvChargingDemandCommandKind,
] as const

const assetPayload = z.object({ assetId: z.string().min(1) }).strict()
const acceptedCommandResultSchema = z.object({
  ok: z.literal(true),
  commandId: z.string().min(1),
  acceptedAt: z.iso.datetime(),
}).strict()
export const gridDispatchGeneratorPayloadSchema = assetPayload.extend({ targetMw: z.number().finite().nonnegative() }).strict()
export const gridTripGeneratorPayloadSchema = assetPayload
export const gridSetGeneratorAvailabilityPayloadSchema = assetPayload.extend({ availableMw: z.number().finite().nonnegative() }).strict()
export const gridReturnGeneratorToServicePayloadSchema = assetPayload
export const gridOpenBranchPayloadSchema = assetPayload
export const gridCloseBranchPayloadSchema = assetPayload
export const gridDerateBranchPayloadSchema = assetPayload.extend({ availability: z.number().finite().min(0.05).max(1) }).strict()
export const gridClearDeratePayloadSchema = assetPayload
export const gridShedLoadPayloadSchema = assetPayload.extend({ amountMw: z.number().finite().positive() }).strict()
export const gridRestoreLoadPayloadSchema = assetPayload
export const gridSetEvChargingDemandPayloadSchema = assetPayload.extend({ demandMw: z.number().finite().nonnegative() }).strict()

const command = (id: string, title: string, description: string, input: z.ZodType): PackRuntimeOperationDescriptor => ({
  id,
  type: 'command',
  title,
  description,
  inputSchema: z.toJSONSchema(input),
  outputSchema: z.toJSONSchema(acceptedCommandResultSchema),
})

export const electricGridCommandOperations: ReadonlyArray<PackRuntimeOperationDescriptor> = [
  command(gridDispatchGeneratorCommandKind, 'Dispatch generator', 'Sets the dispatch target of an online generator in MW.', gridDispatchGeneratorPayloadSchema),
  command(gridTripGeneratorCommandKind, 'Trip generator', 'Trips a generator and removes its output and reserve.', gridTripGeneratorPayloadSchema),
  command(gridSetGeneratorAvailabilityCommandKind, 'Set generator availability', 'Sets available generator capacity without changing a tripped or offline lifecycle state.', gridSetGeneratorAvailabilityPayloadSchema),
  command(gridReturnGeneratorToServiceCommandKind, 'Return generator to service', 'Returns a generator with positive availability to online service at zero dispatch.', gridReturnGeneratorToServicePayloadSchema),
  command(gridOpenBranchCommandKind, 'Open branch', 'Opens a line, cable, transformer, HVDC link, or switch without changing its availability.', gridOpenBranchPayloadSchema),
  command(gridCloseBranchCommandKind, 'Close branch', 'Closes an available Grid branch while retaining its current derate.', gridCloseBranchPayloadSchema),
  command(gridDerateBranchCommandKind, 'Derate branch', 'Applies an available-capacity fraction to a Grid branch.', gridDerateBranchPayloadSchema),
  command(gridClearDerateCommandKind, 'Clear branch derate', 'Restores full branch availability without changing open/closed state.', gridClearDeratePayloadSchema),
  command(gridShedLoadCommandKind, 'Shed load', 'Reduces a controllable load by an explicit MW amount without shedding critical demand.', gridShedLoadPayloadSchema),
  command(gridRestoreLoadCommandKind, 'Restore load', 'Restores a controllable load to its Model and Operating Point demand.', gridRestoreLoadPayloadSchema),
  command(gridSetEvChargingDemandCommandKind, 'Set EV charging demand', 'Sets scheduled demand for a controllable EV charging Grid Asset.', gridSetEvChargingDemandPayloadSchema),
]
