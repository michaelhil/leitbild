import type { OperationalObject } from '../../core/model/index.ts'
import type {
  LeitbildPack,
  PackCommandRequest,
  PackCreationGeometry,
  PackObjectField,
  PackObjectPresentation,
  PackMapLayerGroup,
  PackReferenceDatasetBuilder,
  PackSimulationProvider,
} from '../../core/packs/protocol.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import { asDatasetId } from '../../reference-data/types.ts'
import { aviationNoopProvider, aviationNoopProviderId } from './sim/noop-adapter.ts'
import { aviationOpenSkyProviderId, aviationVatsimProviderId } from './sim/constants.ts'
import { aviationMultiProviderId } from './sim/multi/constants.ts'
import {
  aircraftDomainDataSchema,
  altitudeToFlightLevel,
  isAircraftKind,
  velocityMpsToKnots,
  type AircraftDomainData,
} from './model.ts'

// The dataset id is declared inline (not imported from datasets/aero-norway.ts)
// so the UI bundle does not pull in build-time-only modules (node:fs/promises,
// readFile, etc.). The actual build runs only at CLI time via dynamic import.
const aeroNorwayDatasetIdValue = asDatasetId('aero-norway')

// The aviation pack owns:
//   - Norwegian airspace polygons + Avinor airport points (the aero-norway
//     reference dataset). Pack-contributed via referenceDatasetBuilders.
//   - Live aircraft (Phase B.2+): OpenSky / VATSIM simulation providers and
//     the aviation.set_source command. Not declared in this phase.
//   - Rail-side layer-group toggles for airspace / airports / aircraft.
//
// See ADR 0022 for the architecture and the wiki page domains/aviation.md.

// The build callback intentionally uses `require`/dynamic import so the UI
// bundle does not pull in node:fs/promises and other build-time modules.
// Bun supports synchronous `require` for ESM modules at runtime; the CLI
// import path is the only place this runs.
const aeroNorwayBuilder: PackReferenceDatasetBuilder = {
  id: aeroNorwayDatasetIdValue,
  build: (env) => {
    const apiKey = env.OPENAIP_API_KEY
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('aviation pack: OPENAIP_API_KEY is required to build the aero-norway dataset. Generate one at https://accounts.openaip.net.')
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createAeroNorwayDataset } = require('./datasets/aero-norway.ts') as typeof import('./datasets/aero-norway.ts')
    return createAeroNorwayDataset({ openaipApiKey: apiKey })
  },
}

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
  {
    id: 'aviation:aircraft',
    label: 'Aircraft',
    defaultVisible: true,
    // Live aircraft layers are emitted by the operational-object renderer
    // (kind='aircraft'); the controller matches them via the per-object layer
    // ids that share the 'aircraft:' prefix.
    layerIdPattern: 'aircraft:*',
  },
]

// Pack-level provider catalogue. Adapter registration (the actual factory
// invocation, with env-derived credentials) happens in `src/index.ts`. The
// scenario opts a Control Instance into a non-default provider via
// providerOverrides — see norway-airspace.scenario.json.
const aviationOpenSkyProvider: PackSimulationProvider = {
  id: aviationOpenSkyProviderId,
  label: 'OpenSky Network (live ADS-B)',
  kind: 'remote',
}

const aviationVatsimProvider: PackSimulationProvider = {
  id: aviationVatsimProviderId,
  label: 'VATSIM (live flight-sim network)',
  kind: 'remote',
}

// The multi provider exposes a single id that owns runtime source-swap. Scenarios
// that want operator-toggleable sources reference it; scenarios that pin a
// specific source can still reference aviation.opensky or aviation.vatsim
// directly.
const aviationMultiProvider: PackSimulationProvider = {
  id: aviationMultiProviderId,
  label: 'Aviation (multi-source: OpenSky / VATSIM)',
  kind: 'remote',
}

const parseAircraft = (object: OperationalObject): AircraftDomainData | null => {
  if (!isAircraftKind(object.kind)) return null
  const parsed = aircraftDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const formatCallsign = (data: AircraftDomainData): string =>
  data.callsign ?? data.icao24 ?? 'unknown'

const formatFlightLevel = (data: AircraftDomainData): string => {
  const fl = altitudeToFlightLevel(data.altBaroM ?? data.altGeoM)
  if (fl === null) return data.onGround ? 'GND' : '—'
  return `FL${String(fl).padStart(3, '0')}`
}

const formatKnots = (data: AircraftDomainData): string => {
  const kt = velocityMpsToKnots(data.velocityMps)
  return kt === null ? '—' : `${kt} kt`
}

const formatHeading = (data: AircraftDomainData): string =>
  data.headingDeg === null ? '—' : `${Math.round(data.headingDeg)}°`

const formatVertRate = (data: AircraftDomainData): string => {
  if (data.vertRateMps === null) return '—'
  const fpm = Math.round(data.vertRateMps * 196.85) // m/s → ft/min
  if (fpm === 0) return 'level'
  return `${fpm > 0 ? '+' : ''}${fpm} ft/min`
}

const aircraftFields = (data: AircraftDomainData): ReadonlyArray<PackObjectField> => [
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

const aircraftColor = (data: AircraftDomainData): string => {
  if (data.onGround) return '#6b7280' // slate-500
  // Squawk emergency codes (7500 hijack, 7600 radio failure, 7700 emergency).
  if (data.squawk === '7500' || data.squawk === '7600' || data.squawk === '7700') return '#dc2626'
  return '#1d4ed8' // blue-700
}

export const aviationPack: LeitbildPack = {
  id: 'aviation',
  name: 'Aviation',
  domain: 'aviation',
  wikiRefs: [
    { name: 'Leitbild aviation domain wiki', url: 'https://samsinn-wikis.github.io/leitbild/domains/aviation/' },
  ],
  simulationProviders: [
    aviationNoopProvider,
    aviationOpenSkyProvider,
    aviationVatsimProvider,
    aviationMultiProvider,
  ],
  defaultSimulationProviderId: aviationNoopProviderId,
  referenceDatasetBuilders: [aeroNorwayBuilder],
  mapLayerGroups: layerGroups,
  categories: [
    {
      id: 'aircraft',
      label: 'Aircraft',
      emptyLabel: 'No aircraft in view',
      matches: (object: OperationalObject): boolean => parseAircraft(object) !== null,
    },
  ],
  createObjectTypes: [],
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
        fields: [packField('error', 'Error', 'Invalid aircraft domain data')],
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
}
