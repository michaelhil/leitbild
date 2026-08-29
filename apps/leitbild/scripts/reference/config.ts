import { resolve } from 'node:path'
import { createFetchCache } from '../../src/reference-data/fetch-cache.ts'

export interface CliFlags {
  readonly dataset: string | null
  readonly buildId: string | null
  readonly force: boolean
  readonly json: boolean
}

export const parseFlags = (argv: ReadonlyArray<string>): CliFlags => {
  let dataset: string | null = null
  let buildId: string | null = null
  let force = false
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dataset') dataset = argv[++i] ?? null
    else if (arg === '--build') buildId = argv[++i] ?? null
    else if (arg === '--force') force = true
    else if (arg === '--json') json = true
  }
  return { dataset, buildId, force, json }
}

export const referenceRoot = (): string =>
  resolve(process.env.LEITBILD_REFERENCE_ROOT ?? '/opt/leitbild/reference')

export const buildEnv = () => {
  const root = referenceRoot()
  return {
    referenceRoot: root,
    fetchCache: createFetchCache(`${root}/sources`),
    skipTileBuild: process.env.LEITBILD_REFERENCE_SKIP_TILE_BUILD === '1',
  }
}

export const formatHuman = (key: string, value: string | number | null | undefined): string =>
  `${key.padEnd(18)} ${value ?? '—'}`

export const exitFailure = (message: string): never => {
  console.error(message)
  process.exit(1)
}
