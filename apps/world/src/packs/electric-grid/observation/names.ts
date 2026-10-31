// Readable names for the Grid's unnamed substations (plan v5 W9.1; UX T6, T10, F29). The model calls an
// OpenStreetMap substation without a name "Unnamed substation way/114318078", and that token reaches every label
// built on it: its buses, the branches and plants named after it, the loads served at it. Displays, observable labels
// and alert messages name it instead by where it is, from the nearest named substation: "Substation 5.4 km NE of
// Tofte", or "Substation at Smestad" within a kilometre of it. Read from the model's own names and places; nothing is
// stored, and a model without a named substation keeps its tokens.
import type { GridBusDefinition } from '../grid-model.ts'

const UNNAMED = /Unnamed substation ((?:way|relation|node)\/\d+)/g
/** A bus label's voltage ("420 kV", "300/132 kV") and a station's kind of station, which a place name leaves out. */
const VOLTAGE = /\s+\d+(?:[.,]\d+)?(?:\/\d+(?:[.,]\d+)?)*\s*kV$/i
const STATION_WORDS = /\s+(?:trafostasjon|tranformatorstasjon|transformatorstasjon|koblingsstasjon|koblingspunkt|kraftstasjon|kraftverk|omformerstasjon)$/i
const BEARINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** A named substation's place: its label without its voltage and its kind of station. */
export const placeOf = (label: string): string => label.replace(VOLTAGE, '').replace(STATION_WORDS, '')

/** Kilometres and the eight-point bearing from `from` to `to` ([longitude, latitude]), on a local flat projection. */
export const offset = (from: readonly [number, number], to: readonly [number, number]): { readonly km: number; readonly bearing: (typeof BEARINGS)[number] } => {
  const east = (to[0] - from[0]) * 111.32 * Math.cos(((from[1] + to[1]) / 2) * Math.PI / 180)
  const north = (to[1] - from[1]) * 110.57
  const degrees = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360
  return { km: Math.hypot(east, north), bearing: BEARINGS[Math.round(degrees / 45) % 8]! }
}

/** Where an unnamed substation at `at` is, from the nearest of the named ones. */
export const whereFrom = (at: readonly [number, number], named: ReadonlyArray<Pick<GridBusDefinition, 'label' | 'location'>>): string => {
  const nearest = named.map(bus => ({ bus, ...offset(bus.location, at) })).sort((left, right) => left.km - right.km)[0]!
  const place = placeOf(nearest.bus.label)
  return nearest.km < 1 ? `Substation at ${place}` : `Substation ${nearest.km < 10 ? nearest.km.toFixed(1) : Math.round(nearest.km)} km ${nearest.bearing} of ${place}`
}

/** The model's labels with every unnamed substation named by where it is (see above). */
export const readableLabels = (buses: ReadonlyArray<Pick<GridBusDefinition, 'label' | 'kind' | 'location'>>): ((label: string) => string) => {
  const named = buses.filter(bus => bus.kind === 'substation' && !bus.label.includes('Unnamed substation '))
  if (named.length === 0) return label => label
  const where = new Map<string, string>()
  for (const bus of buses) for (const [, token] of bus.label.matchAll(UNNAMED)) if (!where.has(token!)) where.set(token!, whereFrom(bus.location, named))
  return label => label.replace(UNNAMED, (unnamed, token: string) => {
    const name = where.get(token)
    if (name === undefined) throw new Error(`"${unnamed}" names no substation of the Grid's model`)
    return name
  })
}
