import type { OperationalObject } from '../../core/model/index.ts'
import type {
  LeitbildPack,
  PackCommandRequest,
  PackCreationGeometry,
  PackObjectPresentation,
  PackMapLayerGroup,
  PackReferenceDatasetBuilder,
} from '../../core/packs/protocol.ts'
import { asDatasetId } from '../../reference-data/types.ts'
import { aviationNoopProvider, aviationNoopProviderId } from './sim/noop-adapter.ts'

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
  // 'aviation:aircraft' lands in Phase B.2 alongside the live providers.
]

export const aviationPack: LeitbildPack = {
  id: 'aviation',
  name: 'Aviation',
  domain: 'aviation',
  wikiRefs: [
    { name: 'Leitbild aviation domain wiki', url: 'https://samsinn-wikis.github.io/leitbild/domains/aviation/' },
  ],
  simulationProviders: [aviationNoopProvider],
  defaultSimulationProviderId: aviationNoopProviderId,
  referenceDatasetBuilders: [aeroNorwayBuilder],
  mapLayerGroups: layerGroups,
  categories: [],
  createObjectTypes: [],
  presentObject: (_object: OperationalObject): PackObjectPresentation => {
    throw new Error('aviation pack has no operational objects in this phase')
  },
  defaultObjectLabel: (typeId: string): string => typeId,
  buildCreateObjectCommand: (typeId: string, _label: string, _geometry: PackCreationGeometry): PackCommandRequest => {
    throw new Error(`aviation pack cannot create object of type ${typeId} — no createObjectTypes in this phase`)
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
