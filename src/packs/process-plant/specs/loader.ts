import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PlantGraphSpec } from '../graph/index.ts'
import { plantGraphSpecSchema } from '../graph/index.ts'

const specDir = dirname(fileURLToPath(import.meta.url))

export const readProcessPlantGraphSpec = (fileName: string): PlantGraphSpec => {
  const raw = JSON.parse(readFileSync(join(specDir, fileName), 'utf8')) as unknown
  return plantGraphSpecSchema.parse(raw)
}
