import type { OperationalObject } from '../../core/model/index.ts'
import { nowIso } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import { electricGridPackDataSchema, electricGridPackId, type ElectricGridPackData, type GridSystemData } from './model.ts'

export const electricGridQueryKinds = [
  'electric-grid.network.summary',
  'electric-grid.power-flow.snapshot',
  'electric-grid.frequency.snapshot',
  'electric-grid.voltage-health.snapshot',
  'electric-grid.consumer-supply.snapshot',
  'electric-grid.asset.search',
] as const

const gridObjects = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<{
  readonly object: OperationalObject
  readonly data: ElectricGridPackData
}> =>
  objects.flatMap(object => {
    const parsed = electricGridPackDataSchema.safeParse(object.packData)
    return parsed.success ? [{ object, data: parsed.data }] : []
  })

export const answerElectricGridQuery = (config: {
  readonly request: PackQueryRequest
  readonly objects: ReadonlyArray<OperationalObject>
}): PackQueryResponse => {
  const at = nowIso()
  const items = gridObjects(config.objects)
  const system: GridSystemData | undefined = items.flatMap(item => item.data.type === 'grid_system' ? [item.data] : [])[0]
  if (!electricGridQueryKinds.includes(config.request.kind as typeof electricGridQueryKinds[number])) {
    return { ok: false, packId: electricGridPackId, kind: config.request.kind, reason: `unsupported electric-grid query: ${config.request.kind}`, generatedAt: at }
  }
  if (config.request.kind === 'electric-grid.network.summary') {
    return {
      ok: true,
      packId: electricGridPackId,
      kind: config.request.kind,
      generatedAt: at,
      result: {
        system,
        assetCounts: Object.fromEntries(
          ['substation', 'branch', 'generator', 'load', 'ev_charging', 'storage', 'market_area']
            .map(kind => [kind, items.filter(item => item.data.assetKind === kind).length]),
        ),
      },
    }
  }
  if (config.request.kind === 'electric-grid.power-flow.snapshot') {
    return {
      ok: true,
      packId: electricGridPackId,
      kind: config.request.kind,
      generatedAt: at,
      result: {
        branches: items
          .filter(item => item.data.type === 'grid_branch')
          .map(item => ({ objectId: item.object.id, label: item.object.label, data: item.data })),
      },
    }
  }
  if (config.request.kind === 'electric-grid.frequency.snapshot') {
    return {
      ok: true,
      packId: electricGridPackId,
      kind: config.request.kind,
      generatedAt: at,
      result: {
        frequencyHz: system?.frequencyHz ?? null,
        nominalFrequencyHz: system?.nominalFrequencyHz ?? 50,
        activeIslandCount: system?.activeIslandCount ?? 0,
        reserveMarginMw: system?.reserveMarginMw ?? null,
      },
    }
  }
  if (config.request.kind === 'electric-grid.voltage-health.snapshot') {
    return {
      ok: true,
      packId: electricGridPackId,
      kind: config.request.kind,
      generatedAt: at,
      result: {
        lowestVoltagePu: system?.lowestVoltagePu ?? null,
        substations: items
          .filter(item => item.data.type === 'grid_substation')
          .map(item => ({ objectId: item.object.id, label: item.object.label, data: item.data })),
      },
    }
  }
  if (config.request.kind === 'electric-grid.consumer-supply.snapshot') {
    return {
      ok: true,
      packId: electricGridPackId,
      kind: config.request.kind,
      generatedAt: at,
      result: {
        totalLoadMw: system?.totalLoadMw ?? 0,
        servedLoadMw: system?.servedLoadMw ?? 0,
        unservedLoadMw: system?.unservedLoadMw ?? 0,
        loads: items
          .filter(item => item.data.type === 'grid_load')
          .map(item => ({ objectId: item.object.id, label: item.object.label, data: item.data })),
      },
    }
  }
  const needle = typeof config.request.payload === 'object' && config.request.payload !== null && 'text' in config.request.payload
    ? String((config.request.payload as { readonly text?: unknown }).text ?? '').toLowerCase()
    : ''
  return {
    ok: true,
    packId: electricGridPackId,
    kind: config.request.kind,
    generatedAt: at,
    result: {
      assets: items
        .filter(item => needle.length === 0 || item.object.label.toLowerCase().includes(needle))
        .map(item => ({ objectId: item.object.id, label: item.object.label, assetKind: item.data.assetKind })),
    },
  }
}
