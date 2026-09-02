import { z } from 'zod'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { commandResultSchema, objectIdSchema } from '../../core/model/index.ts'
import { definePackCommandCapability } from '../../simulation/capabilities.ts'

export const gridDispatchGeneratorCommandKind = 'world.electric-grid.dispatch-generator'
export const gridTripGeneratorCommandKind = 'world.electric-grid.trip-generator'
export const gridSetGeneratorAvailabilityCommandKind = 'world.electric-grid.set-generator-availability'
export const gridReturnGeneratorToServiceCommandKind = 'world.electric-grid.return-generator-to-service'
export const gridOpenBranchCommandKind = 'world.electric-grid.open-branch'
export const gridCloseBranchCommandKind = 'world.electric-grid.close-branch'
export const gridDerateBranchCommandKind = 'world.electric-grid.derate-branch'
export const gridClearDerateCommandKind = 'world.electric-grid.clear-derate'
export const gridShedLoadCommandKind = 'world.electric-grid.shed-load'
export const gridRestoreLoadCommandKind = 'world.electric-grid.restore-load'
export const gridSetEvChargingDemandCommandKind = 'world.electric-grid.set-ev-charging-demand'

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

const command = <Shape extends z.ZodRawShape>(
  id: string,
  title: string,
  description: string,
  payloadSchema: z.ZodObject<Shape>,
): SimulationCapability => {
  const input = payloadSchema.extend({ gridId: objectIdSchema })
  return definePackCommandCapability({
    id,
    title,
    description,
    input,
    output: commandResultSchema,
    idempotent: true,
    schedulable: true,
    buildCommand: raw => {
      const { gridId, ...payload } = input.parse(raw) as Record<string, unknown> & {
        readonly gridId: ReturnType<typeof objectIdSchema.parse>
      }
      return { targetObjectIds: [gridId], payload }
    },
  })
}

export const electricGridCommandCapabilities: ReadonlyArray<SimulationCapability> = [
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
