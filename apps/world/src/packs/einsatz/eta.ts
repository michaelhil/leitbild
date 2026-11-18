import { routeDistanceMeters, type GeoJsonPoint } from '../../core/model/index.ts'
import type { RouteTableResult, RoutingAdapter } from '../../routing/protocol.ts'
import type { Eta } from './recommendation-schema.ts'
import type { UnitType } from './config-schema.ts'
import { motionOf, unitTypeOf, type EngineState, type UnitRecord } from './engine/model.ts'
import { noRoadNear, roadSnapLimitM, speedFactor } from './engine/movement.ts'
import { isMoving } from './engine/rules.ts'
import { refusal } from './refusal.ts'

/** The routing operation ETAs use: travel times from many units to one point in one request. */
export type TablePort = Pick<RoutingAdapter, 'table'>

/**
 * Turnout still ahead of a unit sent now, as a send would apply it: what is
 * left of a turnout under way, a full turnout for a unit standing still, and
 * none for a unit already moving.
 */
const turnoutSeconds = (state: EngineState, unit: UnitRecord, mobilizeS: number): number => {
  if (unit.phase === 'mobilizing') return Math.max(0, ((unit.phaseDueMs ?? state.timeMs) - state.timeMs) / 1_000)
  return isMoving(unit) ? 0 : mobilizeS
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * A unit's pace now, as the engine moves it: the slowest of its route
 * impacts, such as road weather (`speedFactor`); 0 while they stop it.
 */
const paceOf = (state: EngineState, unit: UnitRecord): number => speedFactor(motionOf(state, unit.id).impacts)
/** The ETA of a unit its route impacts stop: unavailable, with the straight distance. */
export const stoppedEta = (unit: UnitRecord, from: GeoJsonPoint, to: GeoJsonPoint): Eta =>
  ({ kind: 'unavailable', reason: refusal('routing_unavailable', `${unit.label} is stopped`), straightDistanceM: routeDistanceMeters(from, to) })

type TableAnswer = { readonly ok: true; readonly table: RouteTableResult } | { readonly ok: false; readonly reason: string }

/** The router's table from these sources to these destinations, or why there is none. A failing router is answered, never thrown. */
const tableOf = async (routing: TablePort, sources: ReadonlyArray<GeoJsonPoint>, destinations: ReadonlyArray<GeoJsonPoint>): Promise<TableAnswer> => {
  let table: RouteTableResult
  try {
    table = await routing.table({ sources, destinations })
  } catch (error) {
    return { ok: false, reason: refusal('routing_unavailable', `ETA unavailable: ${message(error)}`) }
  }
  const answered = [table.durationsSeconds, table.distancesM].every(rows => rows.length === sources.length && rows.every(row => row.length === destinations.length))
    && table.sourceSnapsM.length === sources.length && table.destinationSnapsM.length === destinations.length
  if (!answered) return { ok: false, reason: refusal('routing_unavailable', `ETA unavailable: the router answered another table than ${sources.length} by ${destinations.length} points`) }
  return { ok: true, table }
}

/** How one unit travels a trip: from where, at which pace, after which turnout. */
interface Trip {
  readonly unit: UnitRecord
  readonly mobility: NonNullable<UnitType['components']['mobility']>
  readonly from: GeoJsonPoint
  readonly to: GeoJsonPoint
  readonly turnoutS: number
}

/**
 * A trip's ETA where no router is asked: unavailable while the unit's route
 * impacts stop it, a straight line at its own speed and pace for a direct
 * unit; undefined for a road unit, which the router times.
 */
const unroutedEta = (state: EngineState, trip: Trip): Eta | undefined => {
  const pace = paceOf(state, trip.unit)
  if (pace === 0) return stoppedEta(trip.unit, trip.from, trip.to)
  if (trip.mobility.mode !== 'direct') return undefined
  const distanceM = routeDistanceMeters(trip.from, trip.to)
  return { kind: 'straight-line', seconds: trip.turnoutS + distanceM / (trip.mobility.speedMps * pace), distanceM }
}

/**
 * A road trip's ETA from its cell of the router's table, refused for the
 * same reasons an order would be: the router fails (`routing_unavailable`),
 * finds no route, or either end lies more than 1 km from a road
 * (`no_road_near_point`). Travel time is divided by the unit's speed factor
 * and pace. There is never a straight-line substitute for a road.
 */
const roadEta = (state: EngineState, trip: Trip, answer: TableAnswer, source: number, destination: number): Eta => {
  const unavailable = (reason: string): Eta => ({ kind: 'unavailable', reason, straightDistanceM: routeDistanceMeters(trip.from, trip.to) })
  if (!answer.ok) return unavailable(answer.reason)
  const { table } = answer
  if (table.sourceSnapsM[source]! > roadSnapLimitM) return unavailable(noRoadNear(trip.unit.label))
  if (table.destinationSnapsM[destination]! > roadSnapLimitM) return unavailable(noRoadNear())
  const durationS = table.durationsSeconds[source]![destination]!
  const distanceM = table.distancesM[source]![destination]!
  if (durationS === null || distanceM === null) return unavailable(refusal('routing_unavailable', 'ETA unavailable: no route'))
  if (trip.mobility.mode !== 'road') throw new Error(`${trip.unit.id} does not travel by road`)
  return { kind: table.basis, seconds: trip.turnoutS + durationS / (trip.mobility.speedFactor * paceOf(state, trip.unit)), distanceM }
}

const mobilityOf = (state: EngineState, unit: UnitRecord): Trip['mobility'] => {
  const mobility = unitTypeOf(state.catalog, unit).components.mobility
  if (mobility === undefined) throw new Error(`${unit.id} cannot move, so it has no ETA`)
  return mobility
}

/**
 * ETAs of units to a point, turnout included, at each unit's pace now
 * (`paceOf`), as the engine would move it: a direct unit in a straight line,
 * road units in one router table, labelled `routed`, or `straight-line` when
 * the Run routes in straight lines (`roadEta`).
 */
export const etasTo = async (state: EngineState, units: ReadonlyArray<UnitRecord>, to: GeoJsonPoint, routing: TablePort): Promise<ReadonlyMap<string, Eta>> => {
  const etas = new Map<string, Eta>()
  const road: Trip[] = []
  for (const unit of units) {
    const mobility = mobilityOf(state, unit)
    const trip: Trip = { unit, mobility, from: motionOf(state, unit.id).point, to, turnoutS: turnoutSeconds(state, unit, mobility.mobilizeS) }
    const eta = unroutedEta(state, trip)
    if (eta === undefined) road.push(trip)
    else etas.set(unit.id, eta)
  }
  if (road.length === 0) return etas
  const answer = await tableOf(routing, road.map(trip => trip.from), [to])
  road.forEach((trip, index) => etas.set(trip.unit.id, roadEta(state, trip, answer, index, 0)))
  return etas
}

/** Seconds to compare ETAs by; a missing ETA sorts last. */
export const etaSeconds = (eta: Eta): number => eta.kind === 'unavailable' ? Number.POSITIVE_INFINITY : eta.seconds

/**
 * ETAs of one unit from `from` to many points, each with the turnout it
 * would spend first: as `etasTo` times them, in one router table for a road
 * unit.
 */
export const etasFrom = async (state: EngineState, unit: UnitRecord, from: GeoJsonPoint, destinations: ReadonlyArray<{ readonly point: GeoJsonPoint; readonly turnoutS: number }>, routing: TablePort): Promise<ReadonlyArray<Eta>> => {
  const mobility = mobilityOf(state, unit)
  const trips = destinations.map((entry): Trip => ({ unit, mobility, from, to: entry.point, turnoutS: entry.turnoutS }))
  const unrouted = trips.map(trip => unroutedEta(state, trip))
  if (trips.length === 0 || unrouted.every(eta => eta !== undefined)) return unrouted as ReadonlyArray<Eta>
  const answer = await tableOf(routing, [from], trips.map(trip => trip.to))
  return trips.map((trip, index) => roadEta(state, trip, answer, 0, index))
}

/** The turnout a unit would spend before leaving for a target now: as `etasTo` counts it, and only for a task, as an order applies it. */
export const turnoutFor = (state: EngineState, unit: UnitRecord, toTask: boolean): number => {
  const mobility = unitTypeOf(state.catalog, unit).components.mobility
  if (mobility === undefined || !toTask) return 0
  return turnoutSeconds(state, unit, mobility.mobilizeS)
}
