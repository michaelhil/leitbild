import { routeDistanceMeters, type GeoJsonPoint } from '../../../core/model/index.ts'
import { deliversByOrder, loadAfter } from './chain.ts'
import { motionOf, unitTypeOf, type EngineState, type UnitRecord } from './model.ts'
import { isDestroyed, isSite, linksToSite } from './rules.ts'
import { total, type Counts } from './values.ts'

/** Whether a site takes arrivals now: it receives load, is accepting, and is not destroyed. */
export const takesArrivals = (state: EngineState, site: UnitRecord): boolean =>
  isSite(state.catalog, site) && site.accepting === true && !isDestroyed(site)

/**
 * The sites a unit can deliver `load` to now: taking arrivals, public or
 * the unit's side's, and accepting every class of the load.
 */
export const acceptingSitesFor = (state: EngineState, unit: UnitRecord, load: Counts): UnitRecord[] => [...state.units.values()]
  .filter(site => takesArrivals(state, site) && linksToSite(state.catalog, unit, site)
    && Object.keys(load).every(classId => unitTypeOf(state.catalog, site).components.receiving!.accepts.includes(classId)))

/**
 * Where a carrier's `deliver: nearest-accepting` standing order takes load:
 * of `acceptingSitesFor`, the nearest from `from`, by straight-line distance
 * and then id. Undefined when no site accepts it.
 */
export const nearestAcceptingSite = (state: EngineState, unit: UnitRecord, from: GeoJsonPoint, load: Counts): UnitRecord | undefined => acceptingSitesFor(state, unit, load)
  .map(site => ({ site, distance: routeDistanceMeters(from, motionOf(state, site.id).point) }))
  .sort((a, b) => a.distance - b.distance || (a.site.id < b.site.id ? -1 : 1))[0]?.site

/**
 * The delivery a carrier's deliver standing order will make once its plan
 * is done, as the engine would resolve it now: the load it will hold then,
 * from the last task of its plan where it picks that load up (or from where
 * it stands, holding load with no plan), to the nearest accepting site. The
 * reflex resolves its delivery with the same function, from where the unit
 * stands then, so the prediction is what the engine does unless a site
 * opens or closes meanwhile. Undefined when the unit has no deliver order,
 * will hold no load, or no site accepts it (the reflex then raises its
 * failed alert).
 */
export const predictedDelivery = (state: EngineState, unitId: string): { readonly site: UnitRecord; readonly from: GeoJsonPoint } | undefined => {
  const unit = state.units.get(unitId)
  if (unit === undefined || isDestroyed(unit) || !deliversByOrder(state, unit)) return undefined
  const load = loadAfter(state, unit)
  if (total(load) === 0) return undefined
  const lastTask = [...unit.orders].reverse().find(step => 'taskId' in step.target)
  const task = lastTask !== undefined && 'taskId' in lastTask.target ? state.tasks.get(lastTask.target.taskId) : undefined
  const from = task?.point ?? motionOf(state, unit.id).point
  const site = nearestAcceptingSite(state, unit, from, load)
  return site === undefined ? undefined : { site, from }
}
