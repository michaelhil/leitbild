import { z } from 'zod'

export type EngineeringJson = null | boolean | number | string | EngineeringJson[] | { [key: string]: EngineeringJson }

/** Fixed research profile. The deadline includes cold compiler/runtime startup. */
export const ENGINEERING_SCRIPT_LIMITS = Object.freeze({
  wallTimeMs: 5_000,
  guestTimeMs: 3_000,
  guestMemoryBytes: 32 * 1024 * 1024,
  guestStackBytes: 256 * 1024,
  sourceBytes: 64 * 1024,
  inputBytes: 256 * 1024,
  outputBytes: 256 * 1024,
  stderrBytes: 8 * 1024,
  jsonDepth: 32,
  jsonNodes: 20_000,
  processRssBytes: 512 * 1024 * 1024,
  processRssSampleMs: 100,
  concurrency: 2,
})

export const ENGINEERING_SCRIPT_PROFILE = Object.freeze({
  name: 'engineering-typescript-quickjs-research',
  quickjs: '0.32.0',
  typescript: '6.0.3',
  clock: 'unavailable',
  randomness: 'unavailable',
  modules: 'unavailable',
  hostIO: 'unavailable',
  qualification: 'execution-only',
  processMemoryEnforcement: 'sampled-rss-watchdog',
})

export const scriptWorkerResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), outputJson: z.string() }).strict(),
  z.object({ status: z.literal('failed'), error: z.object({ code: z.string().min(1).max(80), message: z.string().max(2000) }).strict() }).strict(),
])
export type ScriptWorkerResponse = z.infer<typeof scriptWorkerResponseSchema>

export type EngineeringScriptReceipt = {
  status: 'completed' | 'failed' | 'cancelled'
  qualification: 'execution-only'
  sourceHash: string
  inputHash: string | null
  runtimeHash: string
  runtime: typeof ENGINEERING_SCRIPT_PROFILE & { bun: string; platform: string; architecture: string }
  limits: typeof ENGINEERING_SCRIPT_LIMITS
  elapsedMs: number
  peakSampledProcessRssBytes: number
  output?: EngineeringJson
  error?: { code: string; message: string }
}
