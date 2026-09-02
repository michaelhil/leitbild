import { workspaceDefinitionRevisionReferenceSchema } from '@leitbild/contracts'
import { z } from 'zod'
import { electricalConnectionDefinitionSchema, electricalPortDefinitionSchema, electricalPortsFromObject, geoJsonGeometrySchema, type CompiledScenario } from '../model/index.ts'
import type { WorldPack } from '../packs/protocol.ts'

export const scenarioWriteResultSchema = z.object({ definition: workspaceDefinitionRevisionReferenceSchema, title: z.string().min(1) }).strict()
export const scenarioPreviewSchema = z.object({
  scenarioId: z.string().min(1),
  packs: z.array(z.string()),
  assets: z.array(z.object({
    id: z.string(), label: z.string(), kind: z.string(), packId: z.string(),
    electricalPorts: z.array(electricalPortDefinitionSchema),
    geometry: geoJsonGeometrySchema.optional(),
  }).strict()),
  connections: z.array(electricalConnectionDefinitionSchema),
}).strict()
export type ScenarioPreview = z.infer<typeof scenarioPreviewSchema>

export const scenarioPreviewFor = (scenario: CompiledScenario, packs: ReadonlyArray<WorldPack>): ScenarioPreview =>
  scenarioPreviewSchema.parse({
    scenarioId: scenario.id,
    packs: scenario.packs,
    assets: scenario.initialObjects.map(object => ({
      id: object.id, label: object.label, kind: object.kind, packId: object.packId,
      electricalPorts: electricalPortsFromObject(object),
      geometry: packs.find(pack => pack.descriptor.id === object.packId)?.scenario?.previewGeometry?.(object)
        ?? object.spatial.geometry ?? object.spatial.position?.point,
    })),
    connections: scenario.connections,
  })
