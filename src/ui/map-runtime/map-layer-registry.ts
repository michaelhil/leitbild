import type { Map as MapLibreMap } from 'maplibre-gl'
import type { PackMapLayerGroup } from '../../core/packs/protocol.ts'
import type { RenderPhase } from './types.ts'
import { createReferenceDataController, type ReferenceDatasetController } from '../map/reference-data-controller.ts'
import { createPackLayerGroupController, type PackLayerGroupController } from '../map/pack-layer-group-controller.ts'

export interface MapLayerRegistration {
  readonly phase: RenderPhase
  readonly sourceIds: ReadonlyArray<string>
  readonly layerIds: ReadonlyArray<string>
  readonly teardown?: () => void
}

export interface MapLayerRegistry {
  readonly registerReferenceLayers: (config: ReferenceLayerRegistrationConfig) => Promise<MapLayerRegistration>
  readonly applyLayerGroupVisibility: (visibility: Readonly<Record<string, boolean>>) => void
  readonly reset: () => void
}

export interface ReferenceLayerRegistrationConfig {
  readonly map: MapLibreMap
  readonly datasetIds: ReadonlyArray<string>
  readonly layerGroups: ReadonlyArray<PackMapLayerGroup>
  readonly visibility: Readonly<Record<string, boolean>>
  readonly beforeLayerId?: string | null
  readonly logger?: (message: string) => void
}

const collectSourceIds = (controller: ReferenceDatasetController): ReadonlyArray<string> =>
  controller.registered.map(dataset => `reference:${dataset.datasetId}`)

const collectLayerIds = (controller: ReferenceDatasetController): ReadonlyArray<string> =>
  controller.registered.flatMap(dataset =>
    Object.values(dataset.layerIdsByCategory).flatMap(ids => ids),
  )

export const createMapLayerRegistry = (): MapLayerRegistry => {
  let referenceController: ReferenceDatasetController | null = null
  let layerGroupController: PackLayerGroupController | null = null

  return {
    registerReferenceLayers: async (config) => {
      referenceController = await createReferenceDataController({
        map: config.map,
        beforeLayerId: config.beforeLayerId ?? null,
        datasetIds: config.datasetIds,
        ...(config.logger === undefined ? {} : { logger: config.logger }),
      })
      if (config.layerGroups.length > 0) {
        layerGroupController = createPackLayerGroupController({
          map: config.map,
          packs: [{
            id: 'map-layer-registry',
            name: 'Map layer registry',
            categories: [],
            createObjectTypes: [],
            presentObject: () => { throw new Error('map-layer-registry synthetic pack has no object presentation') },
            defaultObjectLabel: () => 'unused',
            buildCreateObjectCommand: () => { throw new Error('map-layer-registry synthetic pack has no create command') },
            isController: () => false,
            isTarget: () => false,
            buildSetTargetCommand: () => { throw new Error('map-layer-registry synthetic pack has no target command') },
            buildCancelTargetCommand: () => { throw new Error('map-layer-registry synthetic pack has no cancel command') },
            mapLayerGroups: config.layerGroups,
          }],
        })
        layerGroupController.apply({ ...layerGroupController.defaults, ...config.visibility })
      }
      return {
        phase: 'reference',
        sourceIds: referenceController ? collectSourceIds(referenceController) : [],
        layerIds: referenceController ? collectLayerIds(referenceController) : [],
      }
    },
    applyLayerGroupVisibility: (visibility) => {
      const controller = layerGroupController
      if (!controller) return
      controller.apply({ ...controller.defaults, ...visibility })
    },
    reset: () => {
      referenceController = null
      layerGroupController = null
    },
  }
}
