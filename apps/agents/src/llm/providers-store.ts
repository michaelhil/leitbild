// ============================================================================
// Providers store — persistent, file-backed provider configuration.
//
// Stored at ~/.leitbild/providers.json (mode 0600). Env vars take precedence
// over stored values. This module handles file I/O; merging with env lives
// in mergeWithEnv().
//
// Never logs key values. Never exposes raw keys via any returned string.
// ============================================================================

import { readFile, writeFile, rename, chmod, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PROVIDER_PROFILES, isLocal, type CloudProviderName } from './provider-catalog.ts'
import { DEFAULT_MODEL_FALLBACK } from './models/catalog.ts'
import { z } from 'zod'

export const STORE_VERSION = 1

export interface StoredCloudEntry {
  readonly apiKey?: string          // stored key (may be empty string)
  readonly enabled?: boolean        // default: true when apiKey present (or always for local providers)
  readonly maxConcurrent?: number   // override default in PROVIDER_PROFILES
  readonly pinnedModels?: ReadonlyArray<string>  // user-pinned model IDs
  readonly baseUrl?: string         // local providers (llamacpp): override the profile baseUrl
  readonly embeddingModel?: string  // model id for the /embeddings surface (provider-specific)
}

export interface StoredOllamaEntry {
  readonly enabled?: boolean
  readonly maxConcurrent?: number
}

export interface ProvidersFileShape {
  readonly version: number
  readonly providers: {
    readonly ollama?: StoredOllamaEntry
  } & Partial<Record<CloudProviderName, StoredCloudEntry>>
  // User-chosen router fallback order. When present, overrides
  // DEFAULT_PROVIDER_ORDER but is itself overridden by env PROVIDER_ORDER.
  // Unknown names ignored on load; missing names appended in default position.
  readonly order?: ReadonlyArray<string>
  readonly defaults: {
    readonly modelFallback: ReadonlyArray<string>
  }
}

const EMPTY: ProvidersFileShape = {
  version: STORE_VERSION,
  providers: {},
  defaults: { modelFallback: DEFAULT_MODEL_FALLBACK },
}

const cloudEntrySchema = z.object({
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().finite().positive().optional(),
  pinnedModels: z.array(z.string().min(1)).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  embeddingModel: z.string().trim().min(1).optional(),
}).strict()

const ollamaEntrySchema = z.object({
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().finite().positive().optional(),
}).strict()

const providerShape: Record<string, typeof cloudEntrySchema | ReturnType<typeof ollamaEntrySchema.optional>> = {
  ollama: ollamaEntrySchema.optional(),
}
for (const name of Object.keys(PROVIDER_PROFILES)) providerShape[name] = cloudEntrySchema.optional()

const providersFileSchema = z.object({
  version: z.literal(STORE_VERSION),
  providers: z.object(providerShape).strict(),
  order: z.array(z.string().min(1)).optional(),
  defaults: z.object({
    modelFallback: z.array(z.string().trim().min(1)),
  }).strict(),
}).strict()

// === Load ===

export interface LoadResult {
  readonly data: ProvidersFileShape
  readonly warnings: ReadonlyArray<string>
}

export const loadProviderStore = async (path: string): Promise<LoadResult> => {
  const warnings: string[] = []
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    // Missing file is fine — return empty.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: EMPTY, warnings }
    throw new Error(`Could not read ${path}`, { cause: err })
  }

  // Warn if file mode is wider than 0600 (group or world readable).
  try {
    const s = await stat(path)
    // Mask off type bits; keep permission bits.
    const mode = s.mode & 0o777
    if (mode & 0o077) {
      warnings.push(`providers.json has permissive mode 0${mode.toString(8)} — recommend 0600 (chmod 600 ${path})`)
    }
  } catch {
    // Stat failure is non-fatal.
  }

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    throw new Error(`${path} is not valid JSON`, { cause: err })
  }

  const result = providersFileSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`${path} does not match the canonical provider schema: ${result.error.message}`)
  }
  return { data: result.data as ProvidersFileShape, warnings }
}

// === Save — atomic write with 0600 ===

export const saveProviderStore = async (path: string, data: ProvidersFileShape): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  try { await chmod(tmpPath, 0o600) } catch { /* best-effort */ }
  await rename(tmpPath, path)
}

export interface ProviderPolicyStore {
  readonly getModelFallback: () => ReadonlyArray<string>
  readonly setModelFallback: (chain: ReadonlyArray<string> | undefined) => Promise<void>
}

export const createProviderPolicyStore = (
  path: string,
  initial: ProvidersFileShape,
): ProviderPolicyStore => {
  let modelFallback = [...initial.defaults.modelFallback]
  return {
    getModelFallback: () => modelFallback,
    setModelFallback: async (chain) => {
      const { data } = await loadProviderStore(path)
      const nextChain = chain ? [...chain] : []
      await saveProviderStore(path, {
        ...data,
        defaults: { ...data.defaults, modelFallback: nextChain },
      })
      modelFallback = nextChain
    },
  }
}

// === Merge with env ===

export interface MergedProviderEntry {
  readonly apiKey: string                       // '' if none
  readonly source: 'env' | 'stored' | 'none'
  readonly enabled: boolean
  readonly maxConcurrent: number | undefined    // undefined → use default from PROVIDER_PROFILES
  readonly maskedKey: string                    // safe for UI / logs
  readonly pinnedModels: ReadonlyArray<string>  // [] when none
  readonly baseUrl: string | undefined          // local providers: override of profile baseUrl
  readonly embeddingModel: string | undefined   // model id for /embeddings; '' / undefined → use provider default
}

export interface MergedProviders {
  readonly cloud: Partial<Record<CloudProviderName, MergedProviderEntry>>
  readonly ollama: { readonly enabled: boolean; readonly maxConcurrent: number | undefined }
  // Stored router-order preference (unchanged from the file; env still wins).
  readonly order?: ReadonlyArray<string>
}

export const maskKey = (key: string): string => {
  if (!key) return ''
  if (key.length <= 4) return '•'.repeat(key.length)
  return `•••${key.slice(-4)}`
}

export interface MergeOptions {
  readonly env?: Record<string, string | undefined>
}

export type ProviderMergeInput = Pick<ProvidersFileShape, 'version' | 'providers' | 'order'>

// mergeWithEnv is the SINGLE source of truth for env-vs-stored precedence
// for cloud-provider keys / maxConcurrent / baseUrl. parseProviderConfig
// (providers-config.ts) consumes this output; it does NOT re-read those
// env vars when given a fileStore.
export const mergeWithEnv = (
  store: ProviderMergeInput,
  opts: MergeOptions = {},
): MergedProviders => {
  const env = opts.env ?? process.env
  const cloud: Partial<Record<CloudProviderName, MergedProviderEntry>> = {}

  for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
    const stored = (store.providers as Record<string, StoredCloudEntry | undefined>)[name]
    const envKey = env[`${name.toUpperCase()}_API_KEY`]?.trim()
    const storedKey = stored?.apiKey?.trim() ?? ''

    let apiKey = ''
    let source: MergedProviderEntry['source'] = 'none'
    if (envKey) { apiKey = envKey; source = 'env' }
    else if (storedKey) { apiKey = storedKey; source = 'stored' }

    // Enabled defaults: true when a key is set (via any source). Local
    // providers (llamacpp) default to enabled even without a key — they
    // don't need one.
    const enabled = stored?.enabled ?? (isLocal(name) || apiKey !== '')

    // maxConcurrent precedence: env > stored > undefined (fall through to default).
    const envMc = env[`${name.toUpperCase()}_MAX_CONCURRENT`]
    const envMcNum = envMc ? Number.parseInt(envMc, 10) : undefined
    const maxConcurrent = Number.isFinite(envMcNum) && (envMcNum as number) > 0
      ? envMcNum
      : stored?.maxConcurrent

    // baseUrl: env var first, then stored, else undefined (consumer falls
    // through to PROVIDER_PROFILES default). Only meaningful for local
    // providers; cloud baseUrls are fixed.
    const envBaseUrl = env[`${name.toUpperCase()}_BASE_URL`]?.trim()
    const baseUrl = (envBaseUrl && envBaseUrl.length > 0)
      ? envBaseUrl
      : (stored?.baseUrl?.trim() || undefined)

    // embeddingModel: env var first, then stored, else undefined (consumer
    // falls through to provider default). Same precedence as other fields.
    const envEmbeddingModel = env[`${name.toUpperCase()}_EMBEDDING_MODEL`]?.trim()
    const embeddingModel = (envEmbeddingModel && envEmbeddingModel.length > 0)
      ? envEmbeddingModel
      : (stored?.embeddingModel?.trim() || undefined)

    cloud[name] = {
      apiKey, source, enabled, maxConcurrent,
      maskedKey: maskKey(apiKey),
      pinnedModels: stored?.pinnedModels ?? [],
      baseUrl,
      embeddingModel,
    }
  }

  const ollamaStored = store.providers.ollama
  const ollamaEnabledEnv = env.PROVIDER?.toLowerCase() === 'ollama'
    ? true
    : undefined
  const envOllamaMc = env.OLLAMA_MAX_CONCURRENT
  const envOllamaMcNum = envOllamaMc ? Number.parseInt(envOllamaMc, 10) : undefined
  const ollama = {
    enabled: ollamaEnabledEnv ?? ollamaStored?.enabled ?? true,
    maxConcurrent: Number.isFinite(envOllamaMcNum) && (envOllamaMcNum as number) > 0
      ? envOllamaMcNum
      : ollamaStored?.maxConcurrent,
  }

  return { cloud, ollama, ...(store.order ? { order: store.order } : {}) }
}
