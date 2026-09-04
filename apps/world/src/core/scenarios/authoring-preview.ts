import { workspaceDefinitionRevisionReferenceSchema } from '@leitbild/contracts'
import { z } from 'zod'
import { electricalConnectionDefinitionSchema, electricalPortDefinitionSchema, electricalPortsFromObject, geoJsonGeometrySchema, type CompiledScenario } from '../model/index.ts'
import type { WorldPack } from '../packs/protocol.ts'
import { defaultHistorianLimits } from '../../features/historian/policy.ts'

export const scenarioWriteResultSchema = z.object({
  definition: workspaceDefinitionRevisionReferenceSchema,
  title: z.string().min(1),
  uiPath: z.string().min(1),
}).strict()
export const scenarioPreviewSchema = z.object({
  scenarioId: z.string().min(1),
  packs: z.array(z.string()),
  objectives: z.array(z.string()),
  view: z.object({
    center: z.tuple([z.number().finite(), z.number().finite()]),
    zoom: z.number().finite(),
    layers: z.array(z.string()),
  }).strict(),
  assets: z.array(z.object({
    id: z.string(), label: z.string(), kind: z.string(), packId: z.string(),
    electricalPorts: z.array(electricalPortDefinitionSchema),
    geometry: geoJsonGeometrySchema.optional(),
  }).strict()),
  connections: z.array(electricalConnectionDefinitionSchema),
  timeline: z.object({
    cueCount: z.number().int().nonnegative(),
    lastCueAtSeconds: z.number().nonnegative().nullable(),
    cues: z.array(z.object({
      id: z.string().min(1),
      atSeconds: z.number().nonnegative(),
      title: z.string().min(1).optional(),
      actions: z.array(z.object({
        type: z.string().min(1),
        capabilityId: z.string().min(1).optional(),
      }).strict()),
    }).strict()),
  }).strict(),
  recording: z.object({
    selections: z.array(z.object({ packId: z.string(), profileId: z.string(), intervalMs: z.number(), initialSeriesCount: z.number().int().nonnegative().nullable(), samplesPerSimulationSecond: z.number().nonnegative().nullable() }).strict()),
    sampleBudget: z.number(), ageLimitSeconds: z.number(), byteBudget: z.number(),
    sampleWindowSimulationSeconds: z.number().nonnegative().nullable(),
  }).strict(),
}).strict()
export type ScenarioPreview = z.infer<typeof scenarioPreviewSchema>

export const scenarioPreviewFor = (scenario: CompiledScenario, packs: ReadonlyArray<WorldPack>): ScenarioPreview => {
  const selections = scenario.recording.map(selection => {
    const pack = packs.find(pack => pack.descriptor.id === selection.packId)!
    const profile = pack.recording!.profiles.find(profile => profile.id === selection.profileId)!
    const intervalMs = selection.intervalMs ?? profile.defaultIntervalMs
    const initialSeriesCount = pack.recording?.estimateSeries?.(scenario.initialObjects.filter(object => object.packId === selection.packId), selection.profileId) ?? null
    return { packId: selection.packId, profileId: selection.profileId, intervalMs, initialSeriesCount, samplesPerSimulationSecond: initialSeriesCount === null ? null : initialSeriesCount * 1000 / intervalMs }
  })
  const rate = selections.reduce((sum, selection) => sum + (selection.samplesPerSimulationSecond ?? 0), 0)
  return scenarioPreviewSchema.parse({
    scenarioId: scenario.id,
    packs: scenario.packs,
    objectives: scenario.objectives ?? [],
    view: {
      center: scenario.view.map.center.coordinates,
      zoom: scenario.view.map.zoom,
      layers: scenario.view.map.layers,
    },
    assets: scenario.initialObjects.map(object => ({
      id: object.id, label: object.label, kind: object.kind, packId: object.packId,
      electricalPorts: electricalPortsFromObject(object),
      geometry: packs.find(pack => pack.descriptor.id === object.packId)?.scenario?.previewGeometry?.(object)
        ?? object.spatial.geometry ?? object.spatial.position?.point,
    })),
    connections: scenario.connections,
    timeline: {
      cueCount: scenario.timeline?.cues.length ?? 0,
      lastCueAtSeconds: scenario.timeline?.cues.reduce<number | null>(
        (latest, cue) => latest === null ? cue.at.seconds : Math.max(latest, cue.at.seconds),
        null,
      ) ?? null,
      cues: (scenario.timeline?.cues ?? []).map(cue => ({
        id: cue.id,
        atSeconds: cue.at.seconds,
        ...(cue.title === undefined ? {} : { title: cue.title }),
        actions: cue.actions.map(action => ({
          type: action.type,
          ...(action.type === 'invoke_capability' ? { capabilityId: action.capabilityId } : {}),
        })),
      })),
    },
    recording: {
      selections, sampleBudget: defaultHistorianLimits.maxSamples, ageLimitSeconds: defaultHistorianLimits.maxAgeMs / 1000, byteBudget: defaultHistorianLimits.maxBytes,
      sampleWindowSimulationSeconds: rate > 0 && selections.every(selection => selection.initialSeriesCount !== null) ? defaultHistorianLimits.maxSamples / rate : null,
    },
  })
}
