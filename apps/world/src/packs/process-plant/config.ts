import { z } from 'zod'

export const processPlantSystemDefinitionSchema = z.object({
  id: z.string().min(1),
  graph: z.unknown().optional(),
  graphRef: z.string().min(1).optional(),
  assemblyRef: z.string().min(1).optional(),
  assemblyConfig: z.record(z.string(), z.unknown()).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  initialState: z.record(z.string(), z.unknown()).optional(),
  runtime: z.unknown().optional(),
}).strict().superRefine((definition, ctx) => {
  const sourceCount = [definition.graph, definition.graphRef, definition.assemblyRef]
    .filter(value => value !== undefined).length
  if (sourceCount !== 1) ctx.addIssue({ code: 'custom', message: 'process system must define exactly one of graph, graphRef, or assemblyRef' })
  if (definition.assemblyConfig !== undefined && definition.assemblyRef === undefined) {
    ctx.addIssue({ code: 'custom', path: ['assemblyConfig'], message: 'process system assemblyConfig requires assemblyRef' })
  }
})

export type ProcessPlantSystemDefinition = z.infer<typeof processPlantSystemDefinitionSchema>

export const processPlantPackConfigSchema = z.object({
  systems: z.array(processPlantSystemDefinitionSchema).default([]),
}).strict()

export type ProcessPlantPackConfig = z.infer<typeof processPlantPackConfigSchema>
