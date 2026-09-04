import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { resourceTypeSchema, toolGrantSetSchema } from '@leitbild/contracts'

const agentDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(128),
  persona: z.string().max(64_000),
  model: z.string().trim().min(1).max(256).optional(),
  tools: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
  toolGrants: toolGrantSetSchema.optional(),
  temperature: z.number().finite().optional(),
  maxToolIterations: z.number().int().min(1).max(50).optional(),
  includeContext: z.object({
    participants: z.boolean().optional(),
    activity: z.boolean().optional(),
    knownAgents: z.boolean().optional(),
  }).strict().optional(),
}).strict()

const promptDeckActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('post-message'),
    content: z.string().min(1).max(1_000_000),
    pauseAfterMs: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    kind: z.literal('start-script'),
    scriptName: z.string().min(1).max(256),
  }).strict(),
])

export const promptDeckEntrySchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  description: z.string().min(1).max(2048),
  action: promptDeckActionSchema,
}).strict()
export type PromptDeckEntry = z.infer<typeof promptDeckEntrySchema>

const roomSetupSchema = z.object({
  prompt: z.string().max(16_384).optional(),
  deliveryMode: z.enum(['broadcast', 'manual']),
  packs: z.array(z.string().min(1)),
  agents: z.array(agentDefinitionSchema),
}).strict()

const promptDeckSchema = z.object({ entries: z.array(promptDeckEntrySchema) }).strict()

export const roomDefinitionSchema = z.object({
  companionFor: resourceTypeSchema.optional(),
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  category: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(4096),
  room: roomSetupSchema,
  deck: promptDeckSchema,
}).strict()
export type RoomDefinition = z.infer<typeof roomDefinitionSchema>

const bundledDefinitionsDirectory = join(import.meta.dir, '../../definitions')

const loadBundledRoomDefinitions = (): ReadonlyArray<RoomDefinition> => {
  const filenames = readdirSync(bundledDefinitionsDirectory)
    .filter(filename => filename.endsWith('.room.json'))
    .sort()
  const definitions = filenames.map(filename => {
    const path = join(bundledDefinitionsDirectory, filename)
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`Could not read bundled Room Definition ${filename}`, { cause: error })
    }
    return roomDefinitionSchema.parse(value)
  })
  const ids = new Set<string>()
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`Duplicate bundled Room Definition id "${definition.id}"`)
    ids.add(definition.id)
  }
  return definitions
}

export const BUNDLED_ROOM_DEFINITIONS = loadBundledRoomDefinitions()

export const getBundledRoomDefinition = (id: string): RoomDefinition | undefined =>
  BUNDLED_ROOM_DEFINITIONS.find(definition => definition.id === id)
