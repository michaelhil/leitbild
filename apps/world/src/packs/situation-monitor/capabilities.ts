import { z } from 'zod'
import { commandResultSchema } from '../../core/model/commands.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { packMapFeatureSchema } from '../../core/packs/protocol.ts'
import { externalRecordSchema, recordSearchSchema, situationConfigSchema, situationStateSchema, sourceIdSchema, sourceStatusSchema, boundsSchema } from './model.ts'

export const situationStatusSchema = z.object({
  revision: z.number().int(), config: situationConfigSchema, sources: z.array(sourceStatusSchema),
  storage: z.object({ bytes: z.number(), maxBytes: z.number(), maxRecords: z.number() }).strict(),
  observationTime: z.iso.datetime(), limitations: z.array(z.string()),
}).strict()
export const recordsPageSchema = z.object({ records: z.array(externalRecordSchema), total: z.number().int(), hasMore: z.boolean(), retainedWindowOnly: z.literal(true) }).strict()
export const replaceConfigSchema = z.object({ expectedRevision: z.number().int().nonnegative(), config: situationConfigSchema }).strict()
export const refreshSourceSchema = z.object({ sourceId: sourceIdSchema }).strict()
const query = (id: string, title: string, description: string, input: z.ZodType, output: z.ZodType): SimulationCapability => ({ id: 'world.situation-monitor.' + id, title, description, kind: 'query', risk: 'read', idempotent: true, input, output })
const command = (id: string, title: string, description: string, input: z.ZodType): SimulationCapability => ({ id: 'world.situation-monitor.' + id, title, description, kind: 'command', risk: 'write', idempotent: false, input, output: commandResultSchema, buildCommand: payload => ({ targetObjectIds: [], payload }) })
export const situationCapabilities: ReadonlyArray<SimulationCapability> = [
  query('map.features', 'Map external records', 'Return bounded native map geometry for the retained source window. Located records only; rendering truncation is explicit, not evidence of complete coverage.', z.object({ bounds: boundsSchema, limit: z.number().int().min(1).max(2000).default(1000) }).strict(), z.object({ features: z.array(packMapFeatureSchema), truncated: z.boolean() }).strict()),
  query('status', 'Inspect Situation Monitor', 'Read source configuration, revision, freshness, errors and storage limits. External reports are not simulated truth. No network refresh.', z.object({}).strict(), situationStatusSchema),
  query('records.search', 'Search external records', 'Search retained external reports, events, forecasts and media by source, text, geography and time. Returns evidence URLs and timestamps; no live provider call. Missing coverage is not proof of no events.', recordSearchSchema, recordsPageSchema),
  query('record.inspect', 'Inspect external evidence', 'Read one exact record by source and record ID, including provenance, measurements and media references. Returns null only when the record is no longer retained or its source was removed. Retrieval failures remain errors. Does not claim to watch linked video.', z.object({ sourceId: sourceIdSchema, recordId: z.string().max(256) }).strict(), externalRecordSchema.nullable()),
  command('configuration.replace', 'Configure Situation Monitor', 'Replace this Run’s source/area settings with an expected revision. Source IDs are stable; set enabled=false to pause a source, omit it to remove it. Does not modify the reusable Scenario or any physical system.', replaceConfigSchema),
  command('source.refresh', 'Request source refresh', 'Request collection when provider rate/cache limits allow it. Does not bypass limits; inspect status to see the next eligible refresh.', refreshSourceSchema),
]
export { situationStateSchema, boundsSchema }
