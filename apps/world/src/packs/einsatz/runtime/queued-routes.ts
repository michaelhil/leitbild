import type { GeoJsonPoint, OperationalObject } from '../../../core/model/index.ts'
import type { PackMapFeature } from '../../../core/packs/protocol.ts'
import { plannedPaths, queuedRouteFeature } from '../chain-path.ts'
import { changedPlan } from '../engine/chain.ts'
import { unitTypeOf, type EngineState } from '../engine/model.ts'
import { legEnd, prepareLeg, type LegResult, type RoutePort } from '../engine/movement.ts'
import type { Mobility } from '../config-schema.ts'
import type { PlanExpectation } from '../order-schema.ts'
import { stepTargetId } from '../steps.ts'
import { inPicture, type EinsatzViewer } from '../viewer.ts'

// The map refreshes every few seconds. Reuse geometry from the same endpoints
// within a Run, and leave time for the map's 1.5 s query deadline.
const maximumEntries = 128
const readBudgetMs = 1_000
const failureRetryMs = 3_000

export const createQueuedRouteReader = (routing: RoutePort) => {
  const cache = new Map<string, { readonly result: Promise<LegResult>; expiresAt: number }>()

  const route = async (mobility: Mobility, from: GeoJsonPoint, to: GeoJsonPoint, label: string, deadline: number): Promise<LegResult> => {
    const key = JSON.stringify([mobility, from.coordinates, to.coordinates])
    const existing = cache.get(key)
    const now = performance.now()
    if (existing !== undefined && existing.expiresAt > now) return await existing.result
    cache.delete(key)
    if (cache.size >= maximumEntries) cache.delete(cache.keys().next().value!)
    const port: RoutePort = {
      id: routing.id,
      route: request => routing.route({ ...request, signal: AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now()))) }),
    }
    const entry = { result: prepareLeg(port, mobility, from, to, label), expiresAt: now + failureRetryMs }
    cache.set(key, entry)
    const result = await entry.result
    if (result.ok) entry.expiresAt = Number.POSITIVE_INFINITY
    return result
  }

  return async (
    state: EngineState,
    objects: ReadonlyMap<string, OperationalObject>,
    viewer: EinsatzViewer,
    input: { readonly unitId: string; readonly expectedPlan: PlanExpectation },
  ): Promise<{ readonly features: ReadonlyArray<PackMapFeature> }> => {
    const unit = state.units.get(input.unitId)
    if (unit === undefined || !inPicture(state.catalog, viewer, unit) || changedPlan(unit, input.expectedPlan)) return { features: [] }
    const root = objects.get(unit.id)
    const mobility = unitTypeOf(state.catalog, unit).components.mobility
    if (root === undefined || mobility === undefined) return { features: [] }
    const visible = [root]
    for (const step of unit.orders) {
      const id = stepTargetId(step.target)
      if (id === undefined) continue
      const target = state.units.get(id) ?? state.tasks.get(id)
      const object = objects.get(id)
      if (target !== undefined && object !== undefined && inPicture(state.catalog, viewer, target)) visible.push(object)
    }
    const path = plannedPaths(visible)[0]
    if (path === undefined || path.segments.length === 0) return { features: [] }

    const deadline = performance.now() + readBudgetMs
    const features: PackMapFeature[] = []
    let from = path.segments[0]!.from
    for (const segment of path.segments) {
      if (performance.now() >= deadline) break
      const next = await route(mobility, from, segment.to, path.label, deadline)
      if (!next.ok) break
      features.push(queuedRouteFeature(path, segment, next.leg.geometry))
      from = legEnd(next.leg)
    }
    return { features }
  }
}
