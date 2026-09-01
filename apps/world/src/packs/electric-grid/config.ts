import { z } from 'zod'

export const electricGridPackConfigSchema = z.object({
  topology: z.object({
    kind: z.literal('built-in'),
    arenaId: z.literal('source-derived-norway-grid'),
  }).strict().optional(),
}).strict()
