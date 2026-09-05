import { z } from 'zod'
import type { PackRuntimeQuery, SimulationCapability } from '../../simulation/protocol.ts'
import { defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import {
  gridClearDerateCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridDispatchGeneratorCommandKind,
  gridOpenBranchCommandKind,
  gridRestoreLoadCommandKind,
  gridReturnGeneratorToServiceCommandKind,
  gridSetEvChargingDemandCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridShedLoadCommandKind,
  gridTripGeneratorCommandKind,
} from './commands.ts'
import { gridOperatingPointOverridesSchema } from './config.ts'
import { electricGridDefinitionCatalog } from './definition-refs.ts'
import type { GridAssetDefinition } from './grid-model.ts'
import { electricGridPackId, gridProjectionSchema } from './model.ts'
import { objectIdSchema } from '../../core/model/index.ts'
import { gridAssetSnapshotFor, type GridAssetSnapshot, type GridRuntimeInstance } from './runtime/instance.ts'
import { rejectCapabilityTarget } from '../../simulation/capability-rejection.ts'

export const electricGridQueryKinds = [
  'world.electric-grid.catalog.list',
  'world.electric-grid.grid.summary',
  'world.electric-grid.assets.search',
  'world.electric-grid.asset.get',
  'world.electric-grid.power-flow.snapshot',
  'world.electric-grid.connection-points.list',
] as const

const assetKindSchema = z.enum(['bus', 'branch', 'generator', 'load', 'storage'])
const emptyPayloadSchema = z.object({}).strict()
const gridPayloadSchema = z.object({ gridId: z.string().min(1) }).strict()
const searchPayloadSchema = z.object({
  gridId: z.string().min(1),
  text: z.string().max(200).default(''),
  kinds: z.array(assetKindSchema).max(5).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
const assetPayloadSchema = z.object({ gridId: z.string().min(1), assetId: z.string().min(1) }).strict()
const powerFlowPayloadSchema = z.object({
  gridId: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()

const mapTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), center: z.tuple([z.number(), z.number()]) }).strict(),
  z.object({ kind: z.literal('bounds'), bounds: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]) }).strict(),
])
const assetStatusSchema = z.object({ tone: z.enum(['ready', 'working', 'error', 'idle']), label: z.string() }).strict()
const assetListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: assetKindSchema,
  subkind: z.string(),
  status: assetStatusSchema,
  summary: z.string(),
  applicableOperationIds: z.array(z.string()),
  mapTarget: mapTargetSchema.optional(),
}).strict()
const assetSearchResultSchema = z.object({
  gridId: z.string(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  assets: z.array(assetListItemSchema),
}).strict()
const assetDetailResultSchema = z.object({
  gridId: z.string(),
  asset: assetListItemSchema.extend({
    definition: z.record(z.string(), z.unknown()),
    state: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict()
const genericObjectSchema = z.record(z.string(), z.unknown())
const catalogResultSchema = z.object({
  models: z.array(genericObjectSchema),
  operatingPoints: z.array(genericObjectSchema),
  automations: z.array(genericObjectSchema),
  operatingPointOverridesSchema: genericObjectSchema,
  grids: z.array(genericObjectSchema),
}).strict()
const summaryResultSchema = z.object({
  gridId: z.string(),
  model: genericObjectSchema,
  operatingPoint: genericObjectSchema,
  automation: genericObjectSchema,
  projection: gridProjectionSchema,
  assetCounts: z.record(z.string(), z.number().int().nonnegative()),
  diagnostics: genericObjectSchema,
  constrainedBranches: z.array(genericObjectSchema),
  generators: z.array(genericObjectSchema),
  affectedLoads: z.array(genericObjectSchema),
}).strict()
const powerFlowResultSchema = z.object({
  gridId: z.string(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  branches: z.array(genericObjectSchema),
}).strict()
const connectionPointResultSchema = z.object({ gridId: z.string(), connectionPoints: z.array(genericObjectSchema) }).strict()

const query = (config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: z.ZodType
  readonly output: z.ZodType
}): SimulationCapability => defineSimulationQueryCapability({
  id: config.id,
  title: config.title,
  description: config.description,
  input: config.input,
  output: config.output,
  inspectObjectIds: rawInput => {
    const gridId = (rawInput as { gridId?: unknown }).gridId
    return typeof gridId === 'string' ? [objectIdSchema.parse(gridId)] : []
  },
})

export const electricGridQueryCapabilities: ReadonlyArray<SimulationCapability> = [
  query({ id: electricGridQueryKinds[0], title: 'List Grid catalog', description: 'Lists compatible Grid definitions, accepted overrides, and running Grids.', input: emptyPayloadSchema, output: catalogResultSchema }),
  query({ id: electricGridQueryKinds[1], title: 'Get Grid summary', description: 'Returns bounded operational, asset-count, fidelity, and model diagnostics for one Grid.', input: gridPayloadSchema, output: summaryResultSchema }),
  query({ id: electricGridQueryKinds[2], title: 'Search Grid Assets', description: 'Searches stable private Grid Assets with bounded pagination, live status, map targets, and applicable operations.', input: searchPayloadSchema, output: assetSearchResultSchema }),
  query({ id: electricGridQueryKinds[3], title: 'Get Grid Asset', description: 'Returns configuration, provenance, current state, map target, and applicable operations for one Grid Asset.', input: assetPayloadSchema, output: assetDetailResultSchema }),
  query({ id: electricGridQueryKinds[4], title: 'Get power-flow snapshot', description: 'Returns a bounded page of current branch flow state.', input: powerFlowPayloadSchema, output: powerFlowResultSchema }),
  query({ id: electricGridQueryKinds[5], title: 'List connection points', description: 'Lists typed electrical connection points and their current exchange state.', input: gridPayloadSchema, output: connectionPointResultSchema }),
]

const fail = (reason: string): never => { throw new Error(reason) }

const gridFor = (grids: ReadonlyMap<string, GridRuntimeInstance>, gridId: string): GridRuntimeInstance => {
  const grid = grids.get(gridId)
  if (!grid) return rejectCapabilityTarget(
    `Electric Grid not found: ${gridId}. Discover exact running Grid ids with world.electric-grid.catalog.list.`,
  )
  return grid
}

const mapTargetFor = (grid: GridRuntimeInstance, definition: GridAssetDefinition): z.infer<typeof mapTargetSchema> | undefined => {
  if ('location' in definition) return { kind: 'point', center: [definition.location[0], definition.location[1]] }
  if ('fromBusId' in definition) {
    const from = grid.definition.index.busById.get(definition.fromBusId)?.location
    const to = grid.definition.index.busById.get(definition.toBusId)?.location
    if (!from || !to) return undefined
    return {
      kind: 'bounds',
      bounds: [
        [Math.min(from[0], to[0]), Math.min(from[1], to[1])],
        [Math.max(from[0], to[0]), Math.max(from[1], to[1])],
      ],
    }
  }
  return undefined
}

const applicableOperationIdsFor = (asset: GridAssetSnapshot): ReadonlyArray<string> => {
  if (asset.kind === 'generator') {
    const state = asset.state as GridRuntimeInstance['generators'] extends Map<string, infer T> ? T : never
    return state.state === 'online'
      ? [gridDispatchGeneratorCommandKind, gridTripGeneratorCommandKind, gridSetGeneratorAvailabilityCommandKind]
      : [gridSetGeneratorAvailabilityCommandKind, ...(state.availableMw > 0 ? [gridReturnGeneratorToServiceCommandKind] : [])]
  }
  if (asset.kind === 'branch') {
    const state = asset.state as GridRuntimeInstance['branches'] extends Map<string, infer T> ? T : never
    return [
      state.state === 'closed' ? gridOpenBranchCommandKind : gridCloseBranchCommandKind,
      ...(state.availability < 1 ? [gridClearDerateCommandKind] : [gridDerateBranchCommandKind]),
    ]
  }
  if (asset.kind === 'load') {
    const definition = asset.definition as typeof asset.definition & { readonly controllable?: boolean; readonly kind?: string }
    if (definition.controllable !== true) return []
    return [gridShedLoadCommandKind, gridRestoreLoadCommandKind, ...(definition.kind === 'ev_charging' ? [gridSetEvChargingDemandCommandKind] : [])]
  }
  return []
}

const assetPresentationFor = (grid: GridRuntimeInstance, asset: GridAssetSnapshot): z.infer<typeof assetListItemSchema> => {
  let subkind = asset.kind === 'bus' ? 'substation-bus' : asset.kind
  let tone: 'ready' | 'working' | 'error' | 'idle' = 'ready'
  let statusLabel = 'Normal'
  let summary: string = asset.kind
  if (asset.kind === 'bus') {
    const state = grid.busStates.get(asset.id)
    const definition = asset.definition as typeof grid.definition.model.buses[number]
    const voltage = state?.voltagePu ?? 1
    const frequency = state?.frequencyHz ?? grid.definition.model.nominalFrequencyHz
    const frequencyDeviation = Math.abs(frequency - grid.definition.model.nominalFrequencyHz)
    const connections = [...grid.externalConnections.values()].filter(connection => connection.busId === asset.id)
    const connectedCount = connections.filter(connection => connection.connected).length
    const externalSupplyMw = connections.reduce((total, connection) =>
      total + (connection.connected ? connection.systemActivePowerMw : 0), 0)
    tone = voltage < 0.95 || frequencyDeviation >= 0.5
      ? 'error'
      : voltage < 0.98 || frequencyDeviation >= 0.1 || (connections.length > 0 && connectedCount < connections.length)
        ? 'working'
        : 'ready'
    const externalPowerLabel = externalSupplyMw >= 0
      ? `${Math.round(externalSupplyMw).toLocaleString()} MW supplied`
      : `${Math.round(Math.abs(externalSupplyMw)).toLocaleString()} MW drawn`
    statusLabel = connections.length === 0
      ? state ? `${state.voltagePu.toFixed(3)} pu` : 'Initializing'
      : `${connectedCount}/${connections.length} connected`
    summary = connections.length === 0
      ? `${definition.nominalKv} kV · ${frequency.toFixed(2)} Hz`
      : `${externalPowerLabel} · ${connectedCount}/${connections.length} connected · ${frequency.toFixed(2)} Hz`
  } else if (asset.kind === 'branch') {
    const state = grid.branches.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.branches[number]
    subkind = definition.kind
    tone = state.state === 'open' ? 'idle' : state.loadingPercent >= 100 ? 'error' : state.loadingPercent >= 85 || state.availability < 1 ? 'working' : 'ready'
    statusLabel = state.state === 'open' ? 'Open' : state.availability < 1 ? `Derated ${Math.round(state.availability * 100)}%` : 'Closed'
    summary = `${Math.round(state.flowMw).toLocaleString()} MW · ${Math.round(state.loadingPercent)}% loaded`
  } else if (asset.kind === 'generator') {
    const state = grid.generators.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.generators[number]
    subkind = definition.kind
    tone = state.state === 'online' ? (state.availableMw < definition.capacityMw ? 'working' : 'ready') : state.state === 'tripped' ? 'error' : 'idle'
    statusLabel = state.state
    summary = `${Math.round(state.dispatchMw).toLocaleString()} / ${Math.round(state.availableMw).toLocaleString()} MW`
  } else if (asset.kind === 'load') {
    const state = grid.loads.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.loads[number]
    subkind = definition.kind
    tone = state.serviceState === 'outage' || state.serviceState === 'shed' ? 'error' : state.serviceState === 'constrained' ? 'working' : 'ready'
    statusLabel = state.serviceState
    summary = `${Math.round(state.servedMw).toLocaleString()} / ${Math.round(state.demandMw).toLocaleString()} MW served`
  } else {
    const state = grid.storage.get(asset.id)!
    tone = state.state === 'unavailable' ? 'error' : state.state === 'idle' ? 'idle' : 'working'
    statusLabel = state.state
    summary = `${Math.round(state.stateOfChargeFraction * 100)}% charged · ${Math.round(state.dispatchMw).toLocaleString()} MW`
  }
  const mapTarget = mapTargetFor(grid, asset.definition)
  return {
    id: asset.id,
    label: asset.label,
    kind: asset.kind,
    subkind,
    status: { tone, label: statusLabel },
    summary,
    applicableOperationIds: [...applicableOperationIdsFor(asset)],
    ...(mapTarget === undefined ? {} : { mapTarget }),
  }
}

const summaryFor = (grid: GridRuntimeInstance) => {
  const counts = {
    bus: grid.definition.model.buses.length,
    branch: grid.definition.model.branches.length,
    generator: grid.definition.model.generators.length,
    load: grid.definition.model.loads.length,
    storage: grid.definition.model.storage.length,
  }
  const constrainedBranches = grid.definition.model.branches
    .map(definition => ({ id: definition.id, label: definition.label, kind: definition.kind, state: grid.branches.get(definition.id)! }))
    .sort((left, right) => right.state.loadingPercent - left.state.loadingPercent)
    .slice(0, 8)
  const generators = grid.definition.model.generators
    .map(definition => ({ id: definition.id, label: definition.label, kind: definition.kind, state: grid.generators.get(definition.id)! }))
    .sort((left, right) => right.state.dispatchMw - left.state.dispatchMw)
    .slice(0, 12)
  const affectedLoads = grid.definition.model.loads
    .map(definition => ({ id: definition.id, label: definition.label, kind: definition.kind, state: grid.loads.get(definition.id)! }))
    .sort((left, right) => right.state.shedMw - left.state.shedMw)
    .slice(0, 8)
  return {
    gridId: grid.definition.gridId,
    model: {
      id: grid.definition.model.id,
      title: grid.definition.model.title,
      description: grid.definition.model.description,
      sourceIds: grid.definition.model.sourceIds,
      sourceBuild: grid.definition.model.sourceBuild,
      fidelity: grid.definition.model.fidelity,
    },
    operatingPoint: { ...grid.definition.operatingPoint },
    automation: { ...grid.definition.automation },
    projection: grid.projection,
    assetCounts: counts,
    diagnostics: {
      model: grid.definition.index.diagnostics,
      runtime: { ...grid.diagnostics },
    },
    constrainedBranches,
    generators,
    affectedLoads,
  }
}

export const answerElectricGridQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly grids: ReadonlyMap<string, GridRuntimeInstance>
}): unknown => {
  if (!electricGridQueryKinds.includes(config.request.capabilityId as typeof electricGridQueryKinds[number])) {
    return fail(`unsupported Electric Grid query Capability: ${config.request.capabilityId}`)
  }
  if (config.request.capabilityId === electricGridQueryKinds[0]) {
      emptyPayloadSchema.parse(config.request.input)
      return {
        ...electricGridDefinitionCatalog,
        operatingPointOverridesSchema: z.toJSONSchema(gridOperatingPointOverridesSchema),
        grids: [...config.grids.values()].map(grid => ({
          id: grid.definition.gridId,
          model: { id: grid.definition.model.id, title: grid.definition.model.title },
          operatingPoint: { id: grid.definition.operatingPoint.id, title: grid.definition.operatingPoint.title },
          automation: { id: grid.definition.automation.id, title: grid.definition.automation.title },
          diagnostics: {
            model: grid.definition.index.diagnostics,
            runtime: { ...grid.diagnostics },
          },
        })),
      }
  }
  if (config.request.capabilityId === electricGridQueryKinds[1]) {
      const payload = gridPayloadSchema.parse(config.request.input)
      return summaryFor(gridFor(config.grids, payload.gridId))
  }
  if (config.request.capabilityId === electricGridQueryKinds[2]) {
      const payload = searchPayloadSchema.parse(config.request.input)
      const grid = gridFor(config.grids, payload.gridId)
      const needle = payload.text.trim().toLowerCase()
      const matched = grid.definition.index.assets.filter(asset =>
        (payload.kinds === undefined || payload.kinds.includes(asset.kind))
        && (needle.length === 0 || asset.id.toLowerCase().includes(needle) || asset.label.toLowerCase().includes(needle)))
      const page = matched.slice(payload.offset, payload.offset + payload.limit)
      return {
        gridId: payload.gridId,
        total: matched.length,
        offset: payload.offset,
        limit: payload.limit,
        assets: page.map(entry => assetPresentationFor(grid, gridAssetSnapshotFor(grid, entry.id)!)),
      }
  }
  if (config.request.capabilityId === electricGridQueryKinds[3]) {
      const payload = assetPayloadSchema.parse(config.request.input)
      const grid = gridFor(config.grids, payload.gridId)
      const asset = gridAssetSnapshotFor(grid, payload.assetId)
      if (!asset) return rejectCapabilityTarget(
        `Grid Asset not found: ${payload.assetId}. Discover exact asset ids with world.electric-grid.assets.search.`,
      )
      return {
        gridId: payload.gridId,
        asset: { ...assetPresentationFor(grid, asset), definition: asset.definition, ...(asset.state === undefined ? {} : { state: asset.state }) },
      }
  }
  if (config.request.capabilityId === electricGridQueryKinds[4]) {
      const payload = powerFlowPayloadSchema.parse(config.request.input)
      const grid = gridFor(config.grids, payload.gridId)
      const branches = grid.definition.model.branches.map(definition => ({ definition, state: grid.branches.get(definition.id)! }))
      return {
        gridId: payload.gridId,
        total: branches.length,
        offset: payload.offset,
        limit: payload.limit,
        branches: branches.slice(payload.offset, payload.offset + payload.limit),
      }
  }
  const payload = gridPayloadSchema.parse(config.request.input)
  const grid = gridFor(config.grids, payload.gridId)
  return {
      gridId: payload.gridId,
      connectionPoints: grid.definition.model.connectionPoints.map(point => {
        const busState = grid.busStates.get(point.busId)
        const connection = grid.externalConnections.get(point.id)
        return {
          ...point,
          system: connection === undefined ? null : {
            objectId: connection.definition.system.objectId,
            portId: connection.definition.system.portId,
          },
          systemActivePowerMw: connection?.systemActivePowerMw ?? 0,
          connected: connection?.connected ?? false,
          energized: (busState?.voltagePu ?? 0) >= 0.8,
          voltagePu: busState?.voltagePu ?? 0,
          frequencyHz: busState?.frequencyHz ?? grid.definition.model.nominalFrequencyHz,
        }
      }),
  }
}
