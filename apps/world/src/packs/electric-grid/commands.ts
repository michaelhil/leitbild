import { z } from 'zod'
import type { PackRuntimeOperationDescriptor } from '../../simulation/protocol.ts'

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

const assetPayload = z.object({ assetId: z.string().min(1) }).strict()
export const gridDispatchGeneratorPayloadSchema = assetPayload.extend({ targetMw: z.number().finite().nonnegative() }).strict()
export const gridTripGeneratorPayloadSchema = assetPayload
export const gridSetGeneratorAvailabilityPayloadSchema = assetPayload.extend({ availableMw: z.number().finite().nonnegative() }).strict()
export const gridOpenBranchPayloadSchema = assetPayload
export const gridCloseBranchPayloadSchema = assetPayload
export const gridDerateBranchPayloadSchema = assetPayload.extend({ availability: z.number().finite().min(0.05).max(1) }).strict()
export const gridClearDeratePayloadSchema = assetPayload
export const gridShedLoadPayloadSchema = assetPayload.extend({ amountMw: z.number().finite().positive() }).strict()
export const gridRestoreLoadPayloadSchema = assetPayload
export const gridSetEvChargingPolicyPayloadSchema = assetPayload.extend({ demandMw: z.number().finite().nonnegative() }).strict()

const assetSchema = (properties: Readonly<Record<string, unknown>> = {}, required: ReadonlyArray<string> = []): Readonly<Record<string, unknown>> => ({
  type: 'object',
  additionalProperties: false,
  properties: { assetId: { type: 'string', description: 'Stable Grid Asset id.' }, ...properties },
  required: ['assetId', ...required],
})

const command = (id: string, title: string, description: string, inputSchema: Readonly<Record<string, unknown>>): PackRuntimeOperationDescriptor => ({
  id,
  type: 'command',
  title,
  description,
  inputSchema,
})

export const electricGridCommandOperations: ReadonlyArray<PackRuntimeOperationDescriptor> = [
  command(gridDispatchGeneratorCommandKind, 'Dispatch generator', 'Sets a generator dispatch target in MW.', assetSchema({ targetMw: { type: 'number', minimum: 0 } }, ['targetMw'])),
  command(gridTripGeneratorCommandKind, 'Trip generator', 'Trips a generator and removes its output and reserve.', assetSchema()),
  command(gridSetGeneratorAvailabilityCommandKind, 'Set generator availability', 'Sets available generator capacity in MW and returns positive-capacity units to service.', assetSchema({ availableMw: { type: 'number', minimum: 0 } }, ['availableMw'])),
  command(gridOpenBranchCommandKind, 'Open branch', 'Opens a line, cable, transformer, HVDC link, or switch.', assetSchema()),
  command(gridCloseBranchCommandKind, 'Close branch', 'Closes an available Grid branch.', assetSchema()),
  command(gridDerateBranchCommandKind, 'Derate branch', 'Applies an available-capacity fraction to a Grid branch.', assetSchema({ availability: { type: 'number', minimum: 0.05, maximum: 1 } }, ['availability'])),
  command(gridClearDerateCommandKind, 'Clear branch derate', 'Restores full branch availability.', assetSchema()),
  command(gridShedLoadCommandKind, 'Shed load', 'Reduces scheduled demand by an explicit MW amount without shedding critical demand.', assetSchema({ amountMw: { type: 'number', exclusiveMinimum: 0 } }, ['amountMw'])),
  command(gridRestoreLoadCommandKind, 'Restore load', 'Restores a load to its Model and Operating Point demand.', assetSchema()),
  command(gridSetEvChargingPolicyCommandKind, 'Set EV charging demand', 'Sets scheduled demand for an EV charging Grid Asset.', assetSchema({ demandMw: { type: 'number', minimum: 0 } }, ['demandMw'])),
]
