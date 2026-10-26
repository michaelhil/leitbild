import type { PackPhysicalScene } from '../../../core/packs/scene.ts'
import { copyPhysicalSceneForTransfer } from '../../../core/packs/scene-transfer.ts'
import { preparePhysicalSurfaceOwnership, type PhysicalSurfaceOwnershipDiagnostics } from './surface-ownership.ts'
import { buildVisibleMeshes, type PhysicalMesh } from './geometry.ts'
import { admitPhysicalPickAcceleration, preparePhysicalPickAcceleration, type PhysicalPickAcceleration } from './picking.ts'
import type { PhysicalSceneView } from './types.ts'
import { preparePhysicalRenderBuffers, type PhysicalRenderBuffers } from './render-buffers.ts'

export interface PhysicalPreparedGeometry { readonly sourceAsset?: PhysicalPreparedGeometry; readonly key: string; readonly identity: string; readonly meshes: ReadonlyArray<PhysicalMesh>; readonly acceleration: PhysicalPickAcceleration; readonly buffers: PhysicalRenderBuffers; readonly surfaceOwnership: PhysicalSurfaceOwnershipDiagnostics }
export interface PhysicalPreparationPoolMetrics { readonly workerAlive: boolean; readonly clients: number; readonly registeredSources: number; readonly registeredBytes: number; readonly leases: number; readonly inFlightJobs: number; readonly pinnedSources: number; readonly registrations: number; readonly viewRequests: number; readonly transferredBytes: number; readonly retainedViews: number; readonly retainedViewBytes: number; readonly cacheHits: number; readonly queuedViews: number; readonly skippedViews: number }
export type PhysicalGeometryPreparer = ((scene: PackPhysicalScene, view: PhysicalSceneView, key: string, identity?: string, sourceKey?: string, signal?: AbortSignal) => Promise<PhysicalPreparedGeometry>) & {
  /** Real worker ports retain exact source families; pure offline/test ports own no worker. */
  readonly retainIdentities?: (identities: ReadonlySet<string>) => void
  readonly destroy?: () => void
  readonly diagnostics?: () => PhysicalPreparationPoolMetrics
}
/** Shared with the module worker and explicit offline/test preparation ports. */
export const preparePhysicalGeometry = (scene: PackPhysicalScene, view: PhysicalSceneView, key: string, identity = key): PhysicalPreparedGeometry => {
  const owned = preparePhysicalSurfaceOwnership(buildVisibleMeshes(scene, view)), meshes = owned.meshes.map((mesh, index) => ({ ...mesh, assetKey: key, assetIndex: index }))
  return { key, identity, meshes, acceleration: preparePhysicalPickAcceleration(meshes), buffers: preparePhysicalRenderBuffers(meshes), surfaceOwnership: owned.diagnostics }
}
type WireMesh = Omit<PhysicalMesh, 'object'> & { readonly objectIndex: number }
export type PhysicalPreparationRequest =
  | { readonly kind: 'register'; readonly id: number; readonly sourceKey: string; readonly scene: PackPhysicalScene }
  | { readonly kind: 'prepare'; readonly id: number; readonly key: string; readonly identity: string; readonly sourceKey: string; readonly view: PhysicalSceneView }
  | { readonly kind: 'release'; readonly sourceKey: string }
export type PhysicalPreparationResponse =
  | { readonly kind: 'registered'; readonly id: number; readonly sourceKey: string }
  | { readonly kind: 'prepared'; readonly id: number; readonly key: string; readonly identity: string; readonly sourceKey: string; readonly meshes: ReadonlyArray<WireMesh>; readonly acceleration: PhysicalPickAcceleration; readonly buffers: PhysicalRenderBuffers; readonly surfaceOwnership: PhysicalSurfaceOwnershipDiagnostics }
  | { readonly kind: 'error'; readonly id: number; readonly message: string }
interface WorkerPort {
  onmessage: ((event: MessageEvent<PhysicalPreparationResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  readonly postMessage: (message: PhysicalPreparationRequest, transfer: Transferable[]) => void
  readonly terminate: () => void
}
interface Source { readonly key: string; readonly identity: string; readonly scene: PackPhysicalScene; readonly owners: Set<number>; pins: number; registered: boolean; registration: Promise<void> | null; bytes: number }
interface Client { readonly identities: Set<string>; explicit: boolean }
type Job = { readonly source: Source; readonly reject: (error: Error) => void } & (
  | { readonly kind: 'registration'; readonly resolve: () => void }
  | { readonly kind: 'view'; readonly key: string; readonly identity: string; readonly scene: PackPhysicalScene; readonly view: PhysicalSceneView; readonly demands: Set<symbol>; readonly resolve: (value: PhysicalPreparedGeometry) => void }
)
interface PendingView { readonly sourceKey: string; readonly identity: string; readonly demands: Set<symbol>; readonly task: Promise<PhysicalPreparedGeometry> }
const released = (): Error => Object.assign(new Error('Physical preparation source lease was released'), { name: 'AbortError' })

/** Owned typed storage only; shared buffers are counted once, not once per view. */
const preparedBuffers = (value: PhysicalPreparedGeometry): ReadonlySet<ArrayBufferLike> => {
  const buffers = new Set<ArrayBufferLike>([value.buffers.vertices.buffer, value.buffers.lines.buffer])
  for (const mesh of value.meshes) for (const values of [mesh.vertices, mesh.lines]) if (ArrayBuffer.isView(values)) buffers.add(values.buffer)
  for (const index of [value.acceleration.meshes, ...value.acceleration.triangles.map(item => item.triangles)]) for (const values of [index.bounds, index.children, index.ranges, index.order]) buffers.add(values.buffer)
  return buffers
}
export const physicalPreparedGeometryBytes = (value: PhysicalPreparedGeometry): number => [...preparedBuffers(value)].reduce((bytes, buffer) => bytes + buffer.byteLength, 0)

/** One shared real worker, immutable source registrations and independent host leases. */
export const createPhysicalPreparationPool = (workerFactory: () => WorkerPort = () => {
  if (typeof Worker === 'undefined') throw new Error('Physical layout preparation requires a module Worker')
  return new Worker(new URL('./preparation-worker.ts', import.meta.url), { type: 'module' })
}) => {
  const sources = new Map<string, Source>(), clients = new Map<number, Client>(), jobs = new Map<number, Job>()
  // Active views and resident GPU assets own the strong CPU lease. The pool
  // only discovers those assets; eviction can collect unused view variants.
  const shared = new Map<string, { readonly sourceKey: string; readonly identity: string; readonly value: WeakRef<PhysicalPreparedGeometry> }>()
  const pending = new Map<string, PendingView>(), viewQueue: number[] = []
  let worker: WorkerPort | null = null, activeView: number | null = null, sequence = 0, clientSequence = 0, registrations = 0, viewRequests = 0, transferredBytes = 0, cacheHits = 0, skippedViews = 0
  const stopIfUnused = (): void => { if (!clients.size && !sources.size && !jobs.size && worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); worker = null } }
  const releaseSource = (source: Source): void => {
    if (source.owners.size || source.pins || sources.get(source.key) !== source) return
    if (source.registered) worker?.postMessage({ kind: 'release', sourceKey: source.key }, [])
    sources.delete(source.key)
    for (const [key, entry] of shared) if (entry.sourceKey === source.key) shared.delete(key)
    stopIfUnused()
  }
  const forgetPending = (job: Extract<Job, { kind: 'view' }>): void => { if (pending.get(job.key)?.demands === job.demands) pending.delete(job.key) }
  const cancelUnneededQueued = (): void => {
    for (let at = viewQueue.length - 1; at >= 0; at--) {
      const id = viewQueue[at]!, job = jobs.get(id)
      if (job?.kind !== 'view' || job.demands.size && job.source.owners.size) continue
      viewQueue.splice(at, 1); jobs.delete(id); forgetPending(job); skippedViews++; job.reject(released())
    }
  }
  // The worker's preparation is synchronous. Keep not-yet-started work here so
  // superseded caller demand can be removed before it enters the worker FIFO.
  const dispatchView = (): void => {
    cancelUnneededQueued()
    if (activeView !== null) return
    while (viewQueue.length) {
      const id = viewQueue.shift()!, job = jobs.get(id)
      if (job?.kind !== 'view') continue
      activeView = id
      try { requireWorker().postMessage({ kind: 'prepare', id, sourceKey: job.source.key, key: job.key, identity: job.identity, view: job.view }, []); viewRequests++; return }
      catch (error) { activeView = null; jobs.delete(id); forgetPending(job); job.reject(error instanceof Error ? error : new Error(String(error))) }
    }
  }
  const demand = (key: string, request: PendingView, signal?: AbortSignal): Promise<PhysicalPreparedGeometry> => {
    if (signal?.aborted) return Promise.reject(released())
    const token = Symbol(); request.demands.add(token)
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { signal?.removeEventListener('abort', abort); request.demands.delete(token) }
      const abort = (): void => {
        cleanup(); reject(released()); cancelUnneededQueued()
        // Registration can outlive its caller. Forget only an obsolete request,
        // never another caller's shared demand or an already running view.
        const running = activeView === null ? null : jobs.get(activeView)
        if (!request.demands.size && !(running?.kind === 'view' && running.demands === request.demands) && pending.get(key) === request) pending.delete(key)
      }
      signal?.addEventListener('abort', abort, { once: true })
      void request.task.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
  }
  const requireWorker = (): WorkerPort => {
    if (worker) return worker
    const owned = workerFactory(); worker = owned
    owned.onmessage = (event: MessageEvent<PhysicalPreparationResponse>) => {
      if (worker !== owned) return
      const result = event.data, job = jobs.get(result.id)
      if (!job) return
      jobs.delete(result.id)
      if (job.kind === 'view') activeView = null
      try {
        if (result.kind === 'error') throw new Error(result.message)
        if (job.kind === 'registration') {
          if (result.kind !== 'registered' || result.sourceKey !== job.source.key) throw new Error('Physical source registration returned an incompatible identity')
          job.source.registered = true; job.resolve(); return
        }
        if (result.kind !== 'prepared' || result.key !== job.key || result.identity !== job.identity || result.sourceKey !== job.source.key) throw new Error('Physical preparation returned an incompatible result')
        const meshes = result.meshes.map(({ objectIndex, ...mesh }) => { const object = job.scene.objects[objectIndex]; if (!object) throw new Error('Prepared fragment names an unknown occurrence'); return { ...mesh, object } })
        admitPhysicalPickAcceleration(meshes, result.acceleration)
        const value = { key: job.key, identity: job.identity, meshes, acceleration: result.acceleration, buffers: result.buffers, surfaceOwnership: result.surfaceOwnership }
        shared.set(job.key, { sourceKey: job.source.key, identity: job.identity, value: new WeakRef(value) }); job.resolve(value)
      } catch (error) { job.reject(error instanceof Error ? error : new Error(String(error))) }
      finally { dispatchView() }
    }
    owned.onerror = event => {
      if (worker !== owned) return
      worker = null; activeView = null; viewQueue.length = 0; owned.onmessage = null; owned.onerror = null; owned.terminate()
      for (const source of sources.values()) { source.registered = false; source.registration = null }
      const error = new Error(`Physical preparation worker failed: ${event.message}`)
      for (const job of jobs.values()) job.reject(error)
      jobs.clear()
    }
    return owned
  }
  const register = (source: Source): Promise<void> => {
    if (source.registration) return source.registration
    const task = new Promise<void>((resolve, reject) => {
      const id = ++sequence
      jobs.set(id, { kind: 'registration', source, resolve, reject })
      try {
        const packed = copyPhysicalSceneForTransfer(source.scene), bytes = packed.transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0)
        requireWorker().postMessage({ kind: 'register', id, sourceKey: source.key, scene: packed.scene }, packed.transfers)
        source.bytes = bytes; registrations++; transferredBytes += bytes
      } catch (error) { jobs.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
    })
    source.registration = task
    void task.catch(() => { if (source.registration === task) source.registration = null })
    return task
  }
  const sourceFor = (scene: PackPhysicalScene, identity: string, sourceKey: string): Source => {
    let source = sources.get(sourceKey)
    if (source) { if (source.identity !== identity) throw new Error('Physical source registration key reused by a different geometry identity'); return source }
    source = { key: sourceKey, identity, scene, owners: new Set([...clients].filter(([, client]) => client.identities.has(identity)).map(([id]) => id)), pins: 0, registered: false, registration: null, bytes: 0 }
    sources.set(sourceKey, source); return source
  }
  const diagnostics = (): PhysicalPreparationPoolMetrics => {
    const retained = [...shared.values()].flatMap(entry => { const value = entry.value.deref(); return value ? [value] : [] })
    const buffers = new Set(retained.flatMap(value => [...preparedBuffers(value)]))
    return { workerAlive: worker !== null, clients: clients.size, registeredSources: [...sources.values()].filter(source => source.registered).length, registeredBytes: [...sources.values()].reduce((bytes, source) => bytes + source.bytes, 0), leases: [...sources.values()].reduce((sum, source) => sum + source.owners.size, 0), inFlightJobs: jobs.size, pinnedSources: [...sources.values()].filter(source => source.pins > 0).length, registrations, viewRequests, transferredBytes, retainedViews: retained.length, retainedViewBytes: [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0), cacheHits, queuedViews: viewQueue.length, skippedViews }
  }
  return {
    createPreparer(): PhysicalGeometryPreparer {
      const owner = ++clientSequence, client: Client = { identities: new Set(), explicit: false }; clients.set(owner, client)
      let destroyed = false
      const prepare: PhysicalGeometryPreparer = (scene, view, key, identity = key, sourceKey = identity, signal) => {
        if (destroyed || signal?.aborted) return Promise.reject(released())
        if (client.explicit && !client.identities.has(identity)) return Promise.reject(released())
        if (!client.explicit) client.identities.add(identity)
        const source = sourceFor(scene, identity, sourceKey); source.owners.add(owner)
        for (const [name, value] of shared) if (!value.value.deref() && !pending.has(name)) shared.delete(name)
        const cached = shared.get(key), cachedValue = cached?.value.deref()
        if (cachedValue) { if (cached!.sourceKey !== sourceKey || cached!.identity !== identity) return Promise.reject(new Error('Physical prepared key reused by a different source')); cacheHits++; return Promise.resolve(cachedValue) }
        const existing = pending.get(key)
        if (existing) { if (existing.sourceKey !== sourceKey || existing.identity !== identity) return Promise.reject(new Error('Physical pending key reused by a different source')); return demand(key, existing, signal) }
        source.pins++
        const demands = new Set<symbol>()
        const task = (async () => {
          try {
            await register(source)
            if (!source.owners.size || !demands.size) throw released()
            return await new Promise<PhysicalPreparedGeometry>((resolve, reject) => {
              const id = ++sequence; jobs.set(id, { kind: 'view', source, scene, key, identity, view, demands, resolve, reject }); viewQueue.push(id); dispatchView()
            })
          } finally { source.pins--; releaseSource(source) }
        })()
        const request = { sourceKey, identity, demands, task }
        pending.set(key, request)
        const clear = (): void => { if (pending.get(key) === request) pending.delete(key) }
        void task.then(clear, clear)
        return demand(key, request, signal)
      }
      return Object.assign(prepare, { diagnostics,
        retainIdentities(identities: ReadonlySet<string>): void {
          if (destroyed) return
          client.explicit = true; client.identities.clear(); for (const identity of identities) client.identities.add(identity)
          for (const source of sources.values()) { if (identities.has(source.identity)) source.owners.add(owner); else source.owners.delete(owner); releaseSource(source) }
          cancelUnneededQueued()
        },
        destroy(): void { if (destroyed) return; destroyed = true; clients.delete(owner); for (const source of sources.values()) { source.owners.delete(owner); releaseSource(source) }; cancelUnneededQueued(); stopIfUnused() },
      })
    },
    diagnostics,
  }
}
const sharedPool = createPhysicalPreparationPool()
export const createPhysicalGeometryPreparer = (): PhysicalGeometryPreparer => sharedPool.createPreparer()
export const physicalPreparationDiagnostics = sharedPool.diagnostics
