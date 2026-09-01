import { z } from 'zod'
import { idSchema, objectIdSchema, type ObjectId } from './ids.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export interface ElectricalPortState {
  /** Positive values leave the owning Operational Object. */
  readonly activePowerMw: number
  readonly voltagePu: number
  readonly frequencyHz: number
  readonly energized: boolean
  readonly connected: boolean
  readonly observedAt: IsoTimestamp
}

export interface ElectricalPortDefinition {
  readonly id: string
  readonly label: string
  readonly nominalKv: number
  readonly maximumExportMw: number
  readonly maximumImportMw: number
  readonly inertiaSeconds?: number | undefined
  readonly state?: ElectricalPortState | undefined
}

export interface ElectricalConnectionEndpoint {
  readonly objectId: ObjectId
  readonly portId: string
}

export interface ElectricalConnectionDefinition {
  readonly id: string
  readonly type: 'electrical'
  readonly system: ElectricalConnectionEndpoint
  readonly network: ElectricalConnectionEndpoint
  readonly nominalKv: number
  readonly maximumSystemExportMw: number
  readonly maximumSystemImportMw: number
  readonly systemInertiaSeconds?: number | undefined
}

export const electricalPortStateSchema = z.object({
  activePowerMw: z.number().finite(),
  voltagePu: z.number().finite().nonnegative(),
  frequencyHz: z.number().finite().nonnegative(),
  energized: z.boolean(),
  connected: z.boolean(),
  observedAt: isoTimestampSchema,
}).strict()

export const electricalPortDefinitionSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  nominalKv: z.number().finite().positive(),
  maximumExportMw: z.number().finite().nonnegative(),
  maximumImportMw: z.number().finite().nonnegative(),
  inertiaSeconds: z.number().finite().nonnegative().optional(),
  state: electricalPortStateSchema.optional(),
}).strict()

export const electricalConnectionEndpointSchema = z.object({
  objectId: objectIdSchema,
  portId: idSchema,
}).strict()

export const electricalConnectionSpecSchema = z.object({
  id: idSchema,
  type: z.literal('electrical'),
  system: electricalConnectionEndpointSchema,
  network: electricalConnectionEndpointSchema,
}).strict()

export const electricalConnectionDefinitionSchema = electricalConnectionSpecSchema.extend({
  nominalKv: z.number().finite().positive(),
  maximumSystemExportMw: z.number().finite().nonnegative(),
  maximumSystemImportMw: z.number().finite().nonnegative(),
  systemInertiaSeconds: z.number().finite().nonnegative().optional(),
}).strict()

const electricalPortCarrierSchema = z.object({
  electricalPorts: z.array(electricalPortDefinitionSchema),
}).passthrough()

export const electricalPortsFromObject = (
  object: { readonly packData?: unknown },
): ReadonlyArray<ElectricalPortDefinition> => {
  const parsed = electricalPortCarrierSchema.safeParse(object.packData)
  return parsed.success ? parsed.data.electricalPorts : []
}

export const electricalPortFromObject = (
  object: { readonly packData?: unknown },
  portId: string,
): ElectricalPortDefinition | undefined =>
  electricalPortsFromObject(object).find(port => port.id === portId)
