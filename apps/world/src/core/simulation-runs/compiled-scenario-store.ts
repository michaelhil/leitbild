import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../model/index.ts'

export interface CompiledScenarioStore {
  readonly load: () => Promise<ScenarioDefinition>
  readonly create: (scenario: ScenarioDefinition) => Promise<void>
}

export const compiledScenarioDigest = (scenario: ScenarioDefinition): string => {
  const validated = scenarioDefinitionSchema.parse(scenario)
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(JSON.stringify(validated))
  return hasher.digest('hex')
}

export const createCompiledScenarioStore = (path: string): CompiledScenarioStore => ({
  load: async () => scenarioDefinitionSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown) as ScenarioDefinition,
  create: async scenario => {
    const validated = scenarioDefinitionSchema.parse(scenario)
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  },
})
