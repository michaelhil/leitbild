import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { StorageBudget } from '@leitbild/module-runtime'
import { z } from 'zod'
import { engineeringContinuationCancelSchema, engineeringContinuationInspectSchema, engineeringContinuationReceiptSchema, engineeringContinuationSubmitSchema, type EngineeringContinuationReceipt } from '@leitbild/contracts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { simulationRunIdSchema, type SimulationRunId } from '../model/ids.ts'
import { writeAtomic } from '../storage/atomic-write.ts'
import { captureEngineeringInputs, engineeringBasis, engineeringDigest, engineeringRefusal, engineeringSourceContext, qualifyEngineeringInputs } from './source.ts'
import { continuationSeedSchema, continuationWorkerOutputSchema } from './worker-protocol.ts'
import { engineeringCodeDigest } from './fingerprint.ts'

const WALL_SECONDS = 60
const OUTPUT_BYTES = 2 * 1024 * 1024
const SEED_BYTES = 16 * 1024 * 1024
const RETAINED_JOBS = 32
const RETENTION_MS = 24 * 3600 * 1000
const terminal = (status: EngineeringContinuationReceipt['status']) => !['queued', 'running', 'cancellation-requested'].includes(status)
const recordSchema = z.object({ token: z.string().uuid(), keyDigest: z.string(), requestDigest: z.string(), codeDigest: z.string(), receipt: engineeringContinuationReceiptSchema }).strict()
type Record = z.infer<typeof recordSchema>
type Supervisor = { child?: Bun.Subprocess; started: boolean; cancelled: boolean; done: Promise<void>; release: () => void }
// All Workspaces in this World process share this deliberately small admission
// bound. Jobs are persisted before joining it; there is no durable auto-resume.
let queueTail: Promise<void> = Promise.resolve()
let queued = 0
const unavailable = (message: string): never => engineeringRefusal('engineering_job_unavailable', message)

export const createEngineeringService = ({ registry, root, storageBudget }: { registry: SimulationRunRegistry; root: string; storageBudget: StorageBudget }) => {
  const records = new Map<string, Record>()
  const sourceGenerations = new Map<string, number>()
  const blockedSources = new Set<string>()
  const writes = new Map<string, Promise<void>>()
  const running = new Map<string, Supervisor>()
  let closed = false
  let serial: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = serial.then(operation, operation)
    serial = next.then(() => undefined, () => undefined)
    return next
  }
  const folder = (id: string) => join(root, id)
  const persist = (record: Record) => {
    record.receipt.updatedAt = new Date().toISOString()
    const id = record.receipt.jobId, encoded = JSON.stringify(recordSchema.parse(record))
    const next = (writes.get(id) ?? Promise.resolve()).then(() => writeAtomic(join(folder(id), 'record.json'), encoded))
    writes.set(id, next)
    return next
  }
  const output = async (record: Record) => {
    const path = join(folder(record.receipt.jobId), 'output.json')
    // Open once: size and bytes must come from the same inode while the worker
    // atomically replaces this file. A cached Bun.file size can belong to the
    // prior receipt and truncate a later read after rename.
    let file
    try { file = await open(path, 'r') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    let contents: unknown
    try {
      if ((await file.stat()).size > OUTPUT_BYTES) throw new Error('Continuation result exceeded its output bound')
      contents = JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
    const result = continuationWorkerOutputSchema.parse(contents)
    if (result.token !== record.token || result.receipt.jobId !== record.receipt.jobId || result.receipt.origin.digest !== record.receipt.origin.digest || engineeringDigest(result.receipt.request) !== record.requestDigest) throw new Error('Continuation result identity mismatch')
    if (terminal(record.receipt.status)) return
    record.receipt.cases = result.receipt.cases
    return result.receipt.status
  }
  const finishCases = (record: Record) => {
    for (const result of record.receipt.cases) if (result.status === 'running' || result.status === 'pending') {
      result.status = result.samples.length ? 'partial' : 'failed'
      result.reason ??= record.receipt.reason ?? 'Worker ended before this case was confirmed complete'
    }
  }
  const cleanup = async (id: string) => {
    for (const name of ['scratch', 'input.json', 'output.json']) await rm(join(folder(id), name), { recursive: true, force: true })
  }
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const id of await readdir(root)) {
      if (!z.string().uuid().safeParse(id).success) continue
      const file = Bun.file(join(folder(id), 'record.json'))
      if (!await file.exists()) {
        // Admission did not publish a receipt before the prior process stopped.
        await rm(folder(id), { recursive: true, force: true })
        continue
      }
      const record = recordSchema.parse(await file.json())
      if (record.receipt.source.workspaceId !== registry.workspaceId || record.receipt.jobId !== id) throw new Error('Engineering storage scope mismatch')
      if (!terminal(record.receipt.status)) {
        try { await output(record) } catch (error) { record.receipt.reason = `Interrupted output unavailable: ${String(error).slice(0, 500)}` }
        record.receipt.status = 'interrupted'
        record.receipt.reason ??= 'World restarted before confirmed completion; explicitly rerun with a new submission key'
        finishCases(record)
        await persist(record)
      }
      await cleanup(id)
      records.set(id, record)
    }
  })()
  const reap = async () => {
    for (const [id, record] of records) if (terminal(record.receipt.status) && Date.parse(record.receipt.expiresAt) <= Date.now()) {
      await rm(folder(id), { recursive: true, force: true }); records.delete(id)
    }
  }
  const qualify = async (record: Record) => {
    const basis = record.receipt.origin
    const { epoch, scenarioDigest, restrictionRevision } = basis.frame
    const result = await qualifyEngineeringInputs(registry, simulationRunIdSchema.parse(record.receipt.source.id), { profile: basis.profile, subjectId: basis.subjectId, profileRevision: basis.profileRevision, frame: { epoch, scenarioDigest, restrictionRevision } })
    if (!result.allowed) return unavailable(result.reason ?? 'Original source is unavailable')
  }
  const get = async (id: SimulationRunId, jobId: string) => {
    await ready
    const record = records.get(jobId)
    if (!record || String(record.receipt.source.id) !== String(id) || Date.parse(record.receipt.expiresAt) <= Date.now()) return unavailable('This comparison is unavailable or expired')
    await qualify(record)
    return record
  }
  const cancelRecord = async (record: Record) => {
    if (terminal(record.receipt.status)) return
    const control = running.get(record.receipt.jobId)
    if (!control) throw new Error('Active comparison is missing its supervisor')
    control.cancelled = true
    record.receipt.status = 'cancellation-requested'; await persist(record)
    if (control.started) { control.child?.kill('SIGKILL'); await control.done }
    else { record.receipt.status = 'cancelled'; record.receipt.reason = 'Cancelled before worker start'; await persist(record); control.release() }
  }
  const page = (record: Record, offset = 0, limit = 20) => engineeringContinuationReceiptSchema.parse({ ...record.receipt,
    sampleOffset: offset, sampleLimit: limit,
    cases: record.receipt.cases.map(result => ({ ...result, samples: result.samples.slice(offset, offset + limit) })),
  })
  const execute = async (record: Record, control: { child?: Bun.Subprocess; started: boolean; cancelled: boolean }) => {
    if (closed || control.cancelled || terminal(record.receipt.status)) return
    control.started = true
    const id = record.receipt.jobId
    let deadline: ReturnType<typeof setTimeout> | undefined
    let timeout = false
    try {
      await storageBudget.withGrowth(dirname(root), SEED_BYTES * 3 + OUTPUT_BYTES * 2, async () => {
      await qualify(record)
      if (control.cancelled || closed) return
      record.receipt.status = 'running'; await persist(record)
      const seed = continuationSeedSchema.parse(await Bun.file(join(folder(id), 'origin.json')).json())
      const scratch = join(folder(id), 'scratch')
      await mkdir(scratch, { recursive: true, mode: 0o700 })
      const inputPath = join(folder(id), 'input.json'), outputPath = join(folder(id), 'output.json')
      await writeAtomic(inputPath, JSON.stringify({ token: record.token, codeDigest: record.codeDigest, seed, receipt: record.receipt }))
      if (control.cancelled || closed) return
      const child = Bun.spawn([process.execPath, '--no-env-file', '--no-install', '--no-macros', join(import.meta.dir, '../../engineering-worker.ts'), inputPath, outputPath, scratch], {
        cwd: scratch, env: { LANG: 'C', TZ: 'UTC' }, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
      })
      control.child = child
      let stderr = ''
      const consume = (async () => { for await (const chunk of child.stderr) {
        stderr += new TextDecoder().decode(chunk)
        if (stderr.length > 8192) { stderr = stderr.slice(0, 8192); child.kill('SIGKILL'); break }
      } })()
      deadline = setTimeout(() => { timeout = true; child.kill('SIGKILL') }, WALL_SECONDS * 1000)
      const exit = await child.exited
      await consume
      const status = await output(record)
      if (control.cancelled || closed) {
        record.receipt.status = 'cancelled'; record.receipt.reason = 'Worker terminated and private runtime removed'
      } else if (exit === 0 && (status === 'completed' || status === 'partial')) record.receipt.status = status
      else {
        record.receipt.status = record.receipt.cases.some(result => result.samples.length) ? 'partial' : 'failed'
        record.receipt.reason = timeout ? 'Worker wall-clock budget exhausted; only recorded reached boundaries are evidence' : `Worker failed before confirmed completion${stderr ? `: ${stderr.slice(0, 1500)}` : ''}`
      }
      })
    } catch (error) {
      record.receipt.status = control.cancelled || closed ? 'cancelled' : 'failed'
      record.receipt.reason = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
    } finally {
      if (deadline) clearTimeout(deadline)
      control.child?.kill('SIGKILL')
      if (!terminal(record.receipt.status)) { record.receipt.status = 'cancelled'; record.receipt.reason = 'Cancelled before worker start' }
      finishCases(record)
      await cleanup(id)
      if (records.get(id) === record) await persist(record)
    }
  }
  return {
    capture: (id: SimulationRunId, input: unknown) => captureEngineeringInputs(registry, id, input),
    qualify: (id: SimulationRunId, input: unknown) => qualifyEngineeringInputs(registry, id, input),
    submit: (id: SimulationRunId, actor: string, key: string | undefined, raw: unknown) => exclusive(async () => {
      await ready; await reap()
      if (closed) return unavailable('Engineering service is closing')
      if (!key || key.length > 200) return engineeringRefusal('engineering_key_required', 'Supply a nonempty idempotency key for this submission')
      const request = engineeringContinuationSubmitSchema.parse(raw)
      if (blockedSources.has(id)) return engineeringRefusal('engineering_source_changed', 'Source lifecycle is changing; capture again after it completes')
      const generation = sourceGenerations.get(id) ?? 0
      const context = await engineeringSourceContext(registry, id, request.profile, request.subjectId)
      const keyDigest = engineeringDigest({ id, actor, epoch: context.epoch, key })
      const requestDigest = engineeringDigest(request)
      const previous = [...records.values()].find(record => record.keyDigest === keyDigest)
      if (previous) {
        if (previous.requestDigest !== requestDigest) return engineeringRefusal('engineering_key_conflict', 'This submission key already identifies a different comparison')
        await qualify(previous)
        return page(previous)
      }
      if (queued >= 4 || records.size >= RETAINED_JOBS) return engineeringRefusal('engineering_capacity', 'Engineering comparison capacity is full; wait for completion or evidence expiry')
      // Reserve synchronously before capture/hash awaits, including submissions
      // from other Workspace service instances in this process.
      queued++
      let scheduled = false
      try {
      const codeDigest = await engineeringCodeDigest()
      let seed, origin
      if (request.replayJobId) {
        const original = await get(id, request.replayJobId)
        if (original.codeDigest !== codeDigest) return engineeringRefusal('engineering_code_changed', 'Execution code changed; refresh from the current source instead')
        seed = continuationSeedSchema.parse(await Bun.file(join(folder(original.receipt.jobId), 'origin.json')).json())
        origin = original.receipt.origin
      } else {
        seed = continuationSeedSchema.parse(await registry.captureContinuation(id, [context.query('capture')]))
        const after = await engineeringSourceContext(registry, id, request.profile, request.subjectId)
        if (after.epoch !== context.epoch || after.revision !== context.revision) return engineeringRefusal('engineering_source_changed', 'Source qualification changed during capture')
        origin = engineeringBasis(registry, id, request, context, seed.checkpoint.snapshot, seed.checkpoint.reads?.[0])
      }
      const encoded = JSON.stringify(seed)
      if (Buffer.byteLength(encoded) > SEED_BYTES) return engineeringRefusal('engineering_snapshot_limit', 'Source snapshot exceeds this research profile memory/storage bound')
      const now = new Date().toISOString(), jobId = randomUUID()
      const receipt = engineeringContinuationReceiptSchema.parse({ jobId, source: origin.source, status: 'queued', createdAt: now, updatedAt: now,
        expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(), request, origin, cases: [], sampleOffset: 0, sampleLimit: 20,
        limits: { wallSeconds: WALL_SECONDS, workerCount: 1, outputBytes: OUTPUT_BYTES }, evidenceKind: 'exact-state-conditional-continuation', executionDigest: codeDigest, observationGrid: 'new-grid-at-captured-origin', qualification: 'research-only' })
      const record = recordSchema.parse({ token: randomUUID(), keyDigest, requestDigest, codeDigest, receipt })
      await storageBudget.withGrowth(dirname(root), Buffer.byteLength(encoded) + OUTPUT_BYTES, async () => {
        await mkdir(folder(jobId), { recursive: true, mode: 0o700 })
        await writeAtomic(join(folder(jobId), 'origin.json'), encoded)
        await persist(record)
      })
      if (blockedSources.has(id) || (sourceGenerations.get(id) ?? 0) !== generation) {
        await rm(folder(jobId), { recursive: true, force: true })
        return engineeringRefusal('engineering_source_changed', 'Source changed during admission; capture again')
      }
      records.set(jobId, record)
      let released = false
      const release = () => { if (!released) { released = true; queued--; running.delete(jobId) } }
      const control: Supervisor = { started: false, cancelled: false, done: Promise.resolve(), release }
      const operation = queueTail.then(() => execute(record, control))
      control.done = operation.finally(release)
      // Keep the admission chain available even if persistence or cleanup fails.
      queueTail = control.done.catch(error => { console.error('Engineering job cleanup failed', jobId, error) })
      running.set(jobId, control)
      scheduled = true
      return page(record)
      } finally { if (!scheduled) queued-- }
    }),
    inspect: async (id: SimulationRunId, raw: unknown) => {
      const input = engineeringContinuationInspectSchema.parse(raw), record = await get(id, input.jobId)
      if (record.receipt.status === 'running') await output(record)
      await qualify(record)
      return page(record, input.offset, input.limit)
    },
    cancel: async (id: SimulationRunId, raw: unknown) => {
      const input = engineeringContinuationCancelSchema.parse(raw)
      await ready
      const record = records.get(input.jobId)
      if (!record || String(record.receipt.source.id) !== String(id)) return unavailable('This comparison is unavailable')
      await cancelRecord(record)
      if (Date.parse(record.receipt.expiresAt) <= Date.now()) return { jobId: record.receipt.jobId, status: record.receipt.status as 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted', evidenceAvailable: false as const }
      try { await qualify(record); return page(record) }
      catch { return { jobId: record.receipt.jobId, status: record.receipt.status as 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted', evidenceAvailable: false as const } }
    },
    // Lifecycle-owned cleanup does not read/qualify the disappearing parent.
    // Increment before the first await to fence an in-flight admission too.
    invalidateSource: async (id: SimulationRunId, remove: boolean, hold = false) => {
      if (hold) blockedSources.add(id)
      sourceGenerations.set(id, (sourceGenerations.get(id) ?? 0) + 1)
      await ready
      const matching = [...records].filter(([, record]) => String(record.receipt.source.id) === String(id))
      await Promise.all(matching.map(([, record]) => cancelRecord(record)))
      if (remove) for (const [jobId] of matching) { await rm(folder(jobId), { recursive: true, force: true }); records.delete(jobId); writes.delete(jobId) }
    },
    releaseSource: (id: SimulationRunId) => { blockedSources.delete(id) },
    busy: () => running.size > 0,
    close: async () => {
      closed = true; await ready; await serial
      for (const control of running.values()) { control.cancelled = true; control.child?.kill('SIGKILL') }
      await Promise.allSettled([...running.values()].map(control => control.done))
    },
  }
}
export type EngineeringService = ReturnType<typeof createEngineeringService>
