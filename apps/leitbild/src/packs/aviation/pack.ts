import type { OperationalObject } from '../../core/model/index.ts'
import type {
  LeitbildPack,
  PackCommandRequest,
  PackCreationGeometry,
  PackObjectField,
  PackObjectPresentation,
  PackMapLayerGroup,
  PackRuntime,
} from '../../core/packs/protocol.ts'
import { createLeitbildPackDescriptor } from '../../core/packs/protocol.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import { asDatasetId } from '../../reference-data/types.ts'
import { aviationNoopRuntime, aviationNoopRuntimeId } from './sim/noop-adapter.ts'
import { aviationOpenSkyRuntimeId, aviationVatsimRuntimeId } from './sim/constants.ts'
import { aviationMultiRuntimeId } from './sim/multi/constants.ts'
import {
  aircraftPackDataSchema,
  altitudeToFlightLevel,
  isAircraftKind,
  velocityMpsToKnots,
  type AircraftPackData,
} from './model.ts'

// The dataset id is declared inline (not imported from datasets/aero-norway.ts)
// so the UI bundle does not pull in build-time-only modules (node:fs/promises,
// readFile, etc.). The actual build runs only at CLI time via dynamic import.
const aeroNorwayDatasetIdValue = asDatasetId('aero-norway')

// The aviation pack owns:
//   - Norwegian airspace polygons + Avinor airport points (the aero-norway
//     reference dataset). Pack-contributed via referenceDatasetBuilders.
//   - Live aircraft: OpenSky / VATSIM pack runtimes and the
//     aviation.set_source command.
//   - Rail-side layer-group toggles for reference airspace / airports.
//
// See ADR 0022 for the architecture and the wiki page packs/aviation.md.

const layerGroups: ReadonlyArray<PackMapLayerGroup> = [
  {
    id: 'aviation:airspace',
    label: 'Airspace',
    defaultVisible: true,
    // All aero-norway layers except airport-specific ones; the controller
    // matches `*` against single segments, so this catches fill/line for every
    // airspace category but not the airport circle/label layers.
    layerIdPattern: 'reference:aero-norway:*:*',
  },
  {
    id: 'aviation:airports',
    label: 'Airports',
    defaultVisible: true,
    layerIdPattern: 'reference:aero-norway:airport:*',
  },
]

// Pack-level runtime catalogue. Adapter registration (the actual factory
// invocation, with env-derived credentials) happens in `src/index.ts`. The
// scenario opts a Simulation Run into a non-default runtime via
// runtimeOverrides — see norway-airspace.scenario.json.
const aviationOpenSkyRuntime: PackRuntime = {
  id: aviationOpenSkyRuntimeId,
  version: '1.0.0',
  label: 'OpenSky Network (live ADS-B)',
  kind: 'remote',
}

const aviationVatsimRuntime: PackRuntime = {
  id: aviationVatsimRuntimeId,
  version: '1.0.0',
  label: 'VATSIM (live flight-sim network)',
  kind: 'remote',
}

// The multi runtime exposes a single id that owns runtime source-swap. Scenarios
// that want operator-toggleable sources reference it; scenarios that pin a
// specific source can still reference aviation.opensky or aviation.vatsim
// directly.
const aviationMultiRuntime: PackRuntime = {
  id: aviationMultiRuntimeId,
  version: '1.0.0',
  label: 'Aviation (multi-source: OpenSky / VATSIM)',
  kind: 'remote',
}

const parseAircraft = (object: OperationalObject): AircraftPackData | null => {
  if (!isAircraftKind(object.kind)) return null
  const parsed = aircraftPackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

const formatCallsign = (data: AircraftPackData): string =>
  data.callsign ?? data.icao24 ?? 'unknown'

const formatFlightLevel = (data: AircraftPackData): string => {
  const fl = altitudeToFlightLevel(data.altBaroM ?? data.altGeoM)
  if (fl === null) return data.onGround ? 'GND' : '—'
  return `FL${String(fl).padStart(3, '0')}`
}

const formatKnots = (data: AircraftPackData): string => {
  const kt = velocityMpsToKnots(data.velocityMps)
  return kt === null ? '—' : `${kt} kt`
}

const formatHeading = (data: AircraftPackData): string =>
  data.headingDeg === null ? '—' : `${Math.round(data.headingDeg)}°`

const formatVertRate = (data: AircraftPackData): string => {
  if (data.vertRateMps === null) return '—'
  const fpm = Math.round(data.vertRateMps * 196.85) // m/s → ft/min
  if (fpm === 0) return 'level'
  return `${fpm > 0 ? '+' : ''}${fpm} ft/min`
}

const aircraftFields = (data: AircraftPackData): ReadonlyArray<PackObjectField> => [
  packField('callsign', 'Callsign', formatCallsign(data)),
  packField('source', 'Source', data.source),
  packField('flightLevel', 'Altitude', formatFlightLevel(data)),
  packField('speed', 'Speed', formatKnots(data)),
  packField('heading', 'Heading', formatHeading(data)),
  packField('vertRate', 'Vertical rate', formatVertRate(data)),
  packField('squawk', 'Squawk', data.squawk ?? '—'),
  packField('origin', 'Origin country', data.originCountry ?? '—'),
  packField('icao24', 'ICAO24', data.icao24 ?? '—'),
]

const aircraftColor = (data: AircraftPackData): string => {
  if (data.onGround) return '#6b7280' // slate-500
  // Squawk emergency codes (7500 hijack, 7600 radio failure, 7700 emergency).
  if (data.squawk === '7500' || data.squawk === '7600' || data.squawk === '7700') return '#dc2626'
  return '#1d4ed8' // blue-700
}

export const aviationPack: LeitbildPack = {
  descriptor: createLeitbildPackDescriptor({
    id: 'aviation', version: '1.0.0', name: 'Aviation',
    contributions: ['runtime', 'knowledge', 'reference-data', 'presentation', 'commands'],
  }),
  runtime: {
    runtimes: [aviationNoopRuntime, aviationOpenSkyRuntime, aviationVatsimRuntime, aviationMultiRuntime],
    defaultRuntimeId: aviationNoopRuntimeId,
  },
  knowledge: { wikiRefs: [{ name: 'Leitbild aviation pack wiki', url: 'https://samsinn-wikis.github.io/leitbild/packs/aviation/' }] },
  referenceData: { builders: [], datasetIds: [aeroNorwayDatasetIdValue] },
  presentation: {
    mapLayerGroups: layerGroups,
    categories: [
    {
      id: 'aircraft',
      label: 'Aircraft',
      emptyLabel: 'No aircraft in view',
      matches: (object: OperationalObject): boolean => parseAircraft(object) !== null,
    },
    ],
    presentObject: (object: OperationalObject): PackObjectPresentation => {
    const data = parseAircraft(object)
    if (!data) {
      // Defensive: an unknown aviation OperationalObject — fall back to the
      // shape `presentObject` callers expect rather than throwing.
      return {
        categoryId: 'aircraft',
        icon: 'aircraft',
        color: '#6b7280',
        summary: object.operational.status,
        fields: [packField('error', 'Error', 'Invalid aircraft pack data')],
      }
    }
    const summary = `${formatCallsign(data)} · ${formatFlightLevel(data)} · ${formatKnots(data)}`
    const isEmergency = data.squawk === '7500' || data.squawk === '7600' || data.squawk === '7700'
    return {
      categoryId: 'aircraft',
      icon: 'aircraft',
      color: aircraftColor(data),
      summary,
      status: packStatus(
        isEmergency ? 'error' : data.onGround ? 'idle' : 'working',
        isEmergency ? `Emergency squawk ${data.squawk}` : data.onGround ? 'On ground' : 'Airborne',
      ),
      fields: aircraftFields(data),
      muted: data.onGround,
    }
    },
  },
  commands: {
    createObjectTypes: [],
    defaultObjectLabel: (typeId: string): string => typeId,
    buildCreateObjectCommand: (typeId: string, _label: string, _geometry: PackCreationGeometry): PackCommandRequest => {
      throw new Error(`aviation pack cannot create object of type ${typeId} — aircraft are observed, not created`)
    },
    isController: (_object: OperationalObject): boolean => false,
    isTarget: (_controller: OperationalObject, _candidate: OperationalObject): boolean => false,
    buildSetTargetCommand: (_controller: OperationalObject, _target: OperationalObject): PackCommandRequest => {
      throw new Error('aviation pack does not support targeting in this phase')
    },
    buildCancelTargetCommand: (_controller: OperationalObject): PackCommandRequest => {
      throw new Error('aviation pack does not support targeting in this phase')
    },
  },
}
