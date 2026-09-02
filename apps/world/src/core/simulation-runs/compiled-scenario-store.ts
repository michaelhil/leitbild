import { writeAtomic } from '../storage/atomic-write.ts'
import { mkdir,readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { compiledScenarioSchema,type CompiledScenario } from '../model/index.ts'

export interface CompiledScenarioStore {
  readonly load: () => Promise<CompiledScenario>
  readonly create: (scenario: CompiledScenario) => Promise<void>
}

export const compiledScenarioDigest = (scenario: CompiledScenario): string => {
  const validated = compiledScenarioSchema.parse(scenario)
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(JSON.stringify(validated))
  return hasher.digest('hex')
}

export const createCompiledScenarioStore = (path: string): CompiledScenarioStore => ({
  load: async () => compiledScenarioSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown) as CompiledScenario,
  create: async scenario => {
    const validated = compiledScenarioSchema.parse(scenario)
    await mkdir(dirname(path), { recursive: true })
    await writeAtomic(path, `${JSON.stringify(validated, null, 2)}\n`)
  },
})
