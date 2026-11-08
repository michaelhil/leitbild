import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { calculationError } from './engineering-methods'
import { ENGINEERING_SCRIPT_LIMITS as limits, ENGINEERING_SCRIPT_PROFILE as profile, scriptWorkerResponseSchema } from './script-protocol'
import type { EngineeringJson, EngineeringScriptReceipt } from './script-protocol'
export type { EngineeringJson, EngineeringScriptReceipt } from './script-protocol'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const workerPath = fileURLToPath(new URL('./script-worker.ts', import.meta.url))
const runtime = Object.freeze({ ...profile, bun: Bun.version, platform: process.platform, architecture: process.arch })
let active = 0

/** Canonical finite JSON. Never invoke caller getters or toJSON methods. */
const encodeInput = (input: unknown): string => {
  let nodes = 0
  let minimumBytes = 0
  const account = (bytes: number) => {
    minimumBytes += bytes
    if (minimumBytes > limits.inputBytes) throw calculationError('input_limit', 'Serialized input exceeds the byte limit')
  }
  const ancestors = new Set<object>()
  const visit = (value: unknown, depth: number): EngineeringJson => {
    if (++nodes > limits.jsonNodes || depth > limits.jsonDepth) throw calculationError('input_structure_limit', 'Input structure exceeds its limit')
    account(1)
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'string') { account(Buffer.byteLength(value) + 2); return value }
    if (typeof value === 'number' && Number.isFinite(value)) { account(8); return value }
    if (typeof value !== 'object' || value === null) throw calculationError('invalid_input', 'Input must contain only finite plain JSON values')
    if (ancestors.has(value)) throw calculationError('invalid_input', 'Input must not contain cycles')
    const array = Array.isArray(value)
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw calculationError('invalid_input', 'Input must contain only plain objects and arrays')
    ancestors.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) throw calculationError('invalid_input', 'Input cannot contain symbol keys')
    const keys = Object.keys(descriptors).filter(key => !(array && key === 'length'))
    const result: EngineeringJson[] | Record<string, EngineeringJson> = array ? [] : Object.create(null) as Record<string, EngineeringJson>
    if (array && (keys.length !== (value as unknown[]).length || keys.some((key, index) => key !== String(index)))) throw calculationError('invalid_input', 'Input arrays must be dense and unextended')
    for (const key of keys.sort()) {
      account(Buffer.byteLength(key) + 3)
      const descriptor = descriptors[key]!
      if (!('value' in descriptor) || !descriptor.enumerable) throw calculationError('invalid_input', 'Input cannot contain accessors or hidden properties')
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
    }
    ancestors.delete(value)
    return result
  }
  const encoded = JSON.stringify(visit(input, 0))
  if (Buffer.byteLength(encoded) > limits.inputBytes) throw calculationError('input_limit', 'Serialized input exceeds the byte limit')
  return encoded
}

const readBounded = async (stream: ReadableStream<Uint8Array>, cap: number, overflow: () => void): Promise<string> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > cap) { overflow(); await reader.cancel(); break }
      chunks.push(item.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { reader.releaseLock() }
}

/**
 * Fresh disposable compiler + QuickJS/WASM subprocess per call. No shell, guest
 * host functions, package installation, reusable mutable VM, or module loader.
 * The parent owns receipts; arbitrary guest output cannot upgrade qualification.
 */
export const runEngineeringScript = async ({ source, input, signal }: {
  source: string
  input: unknown
  signal?: AbortSignal
}): Promise<EngineeringScriptReceipt> => {
  const started = performance.now()
  const runtimeSources = await Promise.all([readFile(workerPath, 'utf8'), readFile(new URL('./script-protocol.ts', import.meta.url), 'utf8'), readFile(fileURLToPath(import.meta.url), 'utf8')])
  const receipt: EngineeringScriptReceipt = {
    status: 'failed', qualification: 'execution-only', sourceHash: hash(source), inputHash: null,
    runtimeHash: hash(JSON.stringify({ runtime, limits, sources: runtimeSources.map(hash) })),
    runtime, limits, elapsedMs: 0, peakSampledProcessRssBytes: 0,
  }
  const finish = (status: EngineeringScriptReceipt['status'], error?: EngineeringScriptReceipt['error']): EngineeringScriptReceipt => ({ ...receipt, status, ...(error ? { error } : {}), elapsedMs: Math.round(performance.now() - started) })
  if (signal?.aborted) return finish('cancelled', { code: 'cancelled', message: 'Calculation cancelled before admission' })
  if (Buffer.byteLength(source) > limits.sourceBytes) return finish('failed', { code: 'source_limit', message: 'Source exceeds the byte limit' })
  let inputJson: string
  try { inputJson = encodeInput(input) } catch (error) {
    return finish('failed', { code: error instanceof Error && 'code' in error ? String(error.code) : 'invalid_input', message: error instanceof Error ? error.message : 'Invalid input' })
  }
  receipt.inputHash = hash(inputJson)
  if (!['linux', 'darwin'].includes(process.platform)) return finish('failed', { code: 'unsupported_platform', message: 'The process RSS supervisor requires Linux or macOS' })
  if (active >= limits.concurrency) return finish('failed', { code: 'busy', message: 'Both calculation process slots are occupied; retry after one finishes' })
  active += 1
  let scratch: string | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setInterval> | undefined
  let samplePending: Promise<void> | undefined
  let stopped: EngineeringScriptReceipt['error'] | undefined
  const stop = (code: string, message: string) => {
    if (stopped) return
    stopped = { code, message }
    child?.kill('SIGKILL')
  }
  const abort = () => stop('cancelled', 'Calculation cancelled; the disposable process was terminated')
  signal?.addEventListener('abort', abort, { once: true })
  try {
    scratch = await mkdtemp(join(tmpdir(), 'leitbild-engineering-'))
    if (signal?.aborted) return finish('cancelled', { code: 'cancelled', message: 'Calculation cancelled before process start' })
    child = Bun.spawn([process.execPath, '--no-env-file', '--smol', workerPath], {
      cwd: scratch,
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC', LANG: 'C' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const running = child
    timer = setTimeout(() => stop('wall_deadline', 'Calculation exceeded its external wall-clock deadline'), Math.max(1, limits.wallTimeMs - (performance.now() - started)))
    const sampleRss = async () => {
      if (running.exitCode !== null) return
      const probe = Bun.spawn(['/bin/ps', '-o', 'rss=', '-p', String(running.pid)], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
      const probeTimeout = setTimeout(() => probe.kill('SIGKILL'), limits.processRssSampleMs)
      try {
        const value = (await new Response(probe.stdout).text()).trim()
        const code = await probe.exited
        if (running.exitCode !== null || stopped) return
        if (code !== 0 || !/^\d+$/.test(value)) { stop('supervisor_unavailable', 'Process memory monitoring failed; execution refused'); return }
        const bytes = Number(value) * 1024
        receipt.peakSampledProcessRssBytes = Math.max(receipt.peakSampledProcessRssBytes, bytes)
        if (bytes > limits.processRssBytes) stop('process_memory_limit', 'Disposable process exceeded the sampled resident-memory limit')
      } finally { clearTimeout(probeTimeout) }
    }
    const launchSample = () => {
      if (samplePending) return
      samplePending = sampleRss().catch(() => stop('supervisor_unavailable', 'Process memory monitoring failed; execution refused')).finally(() => { samplePending = undefined })
    }
    // Initial observation verifies that monitoring is available before guest work.
    launchSample()
    await samplePending
    watchdog = setInterval(launchSample, limits.processRssSampleMs)
    const stdout = readBounded(running.stdout as ReadableStream<Uint8Array>, limits.outputBytes * 6 + 4096, () => stop('output_limit', 'Worker output exceeded its transport limit'))
    const stderr = readBounded(running.stderr as ReadableStream<Uint8Array>, limits.stderrBytes, () => stop('stderr_limit', 'Worker diagnostics exceeded their limit'))
    if (!stopped) {
      const stdin = running.stdin
      if (typeof stdin === 'number' || !stdin) throw new Error('Missing worker input pipe')
      stdin.write(JSON.stringify({ source, inputJson }))
      await stdin.end()
    }
    const [code, output] = await Promise.all([running.exited, stdout, stderr])
    if (stopped) return finish(stopped.code === 'cancelled' ? 'cancelled' : 'failed', stopped)
    if (code !== 0) return finish('failed', { code: 'worker_exit', message: `Disposable worker exited unsuccessfully (${code})` })
    let response: unknown
    try { response = JSON.parse(output) } catch { return finish('failed', { code: 'invalid_worker_response', message: 'Worker did not return its strict result envelope' }) }
    const validated = scriptWorkerResponseSchema.safeParse(response)
    if (!validated.success) return finish('failed', { code: 'invalid_worker_response', message: 'Worker did not return its strict result envelope' })
    if (validated.data.status === 'failed') return finish('failed', validated.data.error)
    if (Buffer.byteLength(validated.data.outputJson) > limits.outputBytes) return finish('failed', { code: 'output_limit', message: 'Output exceeds its byte limit' })
    // Recheck JSON structure in the supervisor; the guest cannot author metadata.
    try {
      const outputValue: unknown = JSON.parse(validated.data.outputJson)
      encodeInput(outputValue)
      receipt.output = outputValue as EngineeringJson
    } catch { return finish('failed', { code: 'invalid_output', message: 'Worker output did not satisfy the finite JSON contract' }) }
    return finish('completed')
  } catch {
    return finish('failed', { code: 'supervisor_failure', message: 'Could not supervise the disposable calculation process' })
  } finally {
    if (timer) clearTimeout(timer)
    if (watchdog) clearInterval(watchdog)
    signal?.removeEventListener('abort', abort)
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await samplePending
    try { if (scratch) await rm(scratch, { recursive: true, force: true }) } finally { active -= 1 }
  }
}
