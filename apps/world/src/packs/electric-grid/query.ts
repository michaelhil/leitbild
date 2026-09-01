import { z } from 'zod'
import { nowIso } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import type { PackRuntimeOperationDescriptor } from '../../simulation/protocol.ts'
import { electricGridDefinitionCatalog } from './definition-refs.ts'
import { electricGridPackId } from './model.ts'
import { gridAssetSnapshots, type GridRuntimeInstance } from './runtime/instance.ts'

export const electricGridQueryKinds = [
  'electric-grid.catalog.list',
  'electric-grid.grid.summary',
  'electric-grid.assets.search',
  'electric-grid.asset.get',
  'electric-grid.power-flow.snapshot',
  'electric-grid.connection-points.list',
] as const

const gridPayloadSchema = z.object({ gridId: z.string().min(1) }).strict()
const searchPayloadSchema = z.object({
  gridId: z.string().min(1),
  text: z.string().max(200).default(''),
  kinds: z.array(z.enum(['bus', 'branch', 'generator', 'load', 'storage'])).max(5).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
const assetPayloadSchema = z.object({ gridId: z.string().min(1), assetId: z.string().min(1) }).strict()
const powerFlowPayloadSchema = z.object({
  gridId: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()

const query = (id: string, title: string, description: string, properties: Readonly<Record<string, unknown>>, required: ReadonlyArray<string> = []): PackRuntimeOperationDescriptor => ({
  id,
  type: 'query',
  title,
  description,
  inputSchema: { type: 'object', additionalProperties: false, properties, required },
})

const gridIdProperty = { gridId: { type: 'string', description: 'Grid Operational Object id.' } }

export const electricGridQueryOperations: ReadonlyArray<PackRuntimeOperationDescriptor> = [
  query('electric-grid.catalog.list', 'List Grid catalog', 'Lists running Grids and their selected Model, Operating Point, and Automation.', {}),
  query('electric-grid.grid.summary', 'Get Grid summary', 'Returns bounded operational and asset-count summaries for one Grid.', gridIdProperty, ['gridId']),
  query('electric-grid.assets.search', 'Search Grid Assets', 'Searches stable private Grid Assets by label, id, and type with pagination.', {
    ...gridIdProperty,
    text: { type: 'string' },
    kinds: { type: 'array', items: { enum: ['bus', 'branch', 'generator', 'load', 'storage'] }, maxItems: 5 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  }, ['gridId']),
  query('electric-grid.asset.get', 'Get Grid Asset', 'Returns definition, provenance, location, and current state for one stable Grid Asset.', { ...gridIdProperty, assetId: { type: 'string' } }, ['gridId', 'assetId']),
  query('electric-grid.power-flow.snapshot', 'Get power-flow snapshot', 'Returns a bounded page of current branch flow state.', {
    ...gridIdProperty,
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  }, ['gridId']),
  query('electric-grid.connection-points.list', 'List connection points', 'Lists typed electrical connection points exposed for future cross-Pack coupling.', gridIdProperty, ['gridId']),
]

const ok = (request: PackQueryRequest, result: unknown): PackQueryResponse => ({
  ok: true,
  packId: electricGridPackId,
  kind: request.kind,
  result,
  generatedAt: nowIso(),
})

const fail = (request: PackQueryRequest, reason: string): PackQueryResponse => ({
  ok: false,
  packId: electricGridPackId,
  kind: request.kind,
  reason,
  generatedAt: nowIso(),
})

const gridFor = (grids: ReadonlyMap<string, GridRuntimeInstance>, gridId: string): GridRuntimeInstance => {
  const grid = grids.get(gridId)
  if (!grid) throw new Error(`Grid not found: ${gridId}`)
  return grid
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
    model: { id: grid.definition.model.id, title: grid.definition.model.title, description: grid.definition.model.description, sourceIds: grid.definition.model.sourceIds },
    operatingPoint: { id: grid.definition.operatingPoint.id, title: grid.definition.operatingPoint.title },
    automation: { id: grid.definition.automation.id, title: grid.definition.automation.title },
    projection: grid.projection,
    assetCounts: counts,
    constrainedBranches,
    generators,
    affectedLoads,
  }
}

export const answerElectricGridQuery = (config: {
  readonly request: PackQueryRequest
  readonly grids: ReadonlyMap<string, GridRuntimeInstance>
}): PackQueryResponse => {
  if (!electricGridQueryKinds.includes(config.request.kind as typeof electricGridQueryKinds[number])) {
    return fail(config.request, `unsupported electric-grid query: ${config.request.kind}`)
  }
  try {
    if (config.request.kind === 'electric-grid.catalog.list') {
      return ok(config.request, {
        ...electricGridDefinitionCatalog,
        grids: [...config.grids.values()].map(grid => ({
          id: grid.definition.gridId,
          model: { id: grid.definition.model.id, title: grid.definition.model.title },
          operatingPoint: { id: grid.definition.operatingPoint.id, title: grid.definition.operatingPoint.title },
          automation: { id: grid.definition.automation.id, title: grid.definition.automation.title },
        })),
      })
    }
    if (config.request.kind === 'electric-grid.grid.summary') {
      const payload = gridPayloadSchema.parse(config.request.payload)
      return ok(config.request, summaryFor(gridFor(config.grids, payload.gridId)))
    }
    if (config.request.kind === 'electric-grid.assets.search') {
      const payload = searchPayloadSchema.parse(config.request.payload)
      const grid = gridFor(config.grids, payload.gridId)
      const needle = payload.text.trim().toLowerCase()
      const matched = gridAssetSnapshots(grid).filter(asset =>
        (payload.kinds === undefined || payload.kinds.includes(asset.kind))
        && (needle.length === 0 || asset.id.toLowerCase().includes(needle) || asset.label.toLowerCase().includes(needle)))
      const page = matched.slice(payload.offset, payload.offset + payload.limit)
      return ok(config.request, {
        gridId: payload.gridId,
        total: matched.length,
        offset: payload.offset,
        limit: payload.limit,
        assets: page.map(asset => ({ id: asset.id, label: asset.label, kind: asset.kind })),
      })
    }
    if (config.request.kind === 'electric-grid.asset.get') {
      const payload = assetPayloadSchema.parse(config.request.payload)
      const asset = gridAssetSnapshots(gridFor(config.grids, payload.gridId)).find(candidate => candidate.id === payload.assetId)
      if (!asset) return fail(config.request, `Grid Asset not found: ${payload.assetId}`)
      return ok(config.request, { gridId: payload.gridId, asset })
    }
    if (config.request.kind === 'electric-grid.power-flow.snapshot') {
      const payload = powerFlowPayloadSchema.parse(config.request.payload)
      const grid = gridFor(config.grids, payload.gridId)
      const branches = grid.definition.model.branches.map(definition => ({ definition, state: grid.branches.get(definition.id)! }))
      return ok(config.request, {
        gridId: payload.gridId,
        total: branches.length,
        offset: payload.offset,
        limit: payload.limit,
        branches: branches.slice(payload.offset, payload.offset + payload.limit),
      })
    }
    const payload = gridPayloadSchema.parse(config.request.payload)
    const grid = gridFor(config.grids, payload.gridId)
    return ok(config.request, { gridId: payload.gridId, connectionPoints: grid.definition.model.connectionPoints })
  } catch (error) {
    return fail(config.request, error instanceof Error ? error.message : String(error))
  }
}
