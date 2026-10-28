import { expect, test } from 'bun:test'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
import { createPhysicalPreparationPool, physicalPreparationWorkerBudget, preparePhysicalGeometry, type PhysicalPreparationRequest, type PhysicalPreparationResponse } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

const serialPool = (factory: Parameters<typeof createPhysicalPreparationPool>[0]) => createPhysicalPreparationPool(factory, () => 1)
const scene = (): PackPhysicalScene => ({ id: 'a', targetObjectId: 'owner:a', revision: 'same-exact-source', anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 2 }], objects: [{ id: 'machine', label: 'Machine', kind: 'equipment', levelId: 'floor', subjectIds: ['component'], positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 1]), indices: new Uint32Array([0, 1, 2]) }] })
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const refused = (task: Promise<unknown>) => task.then(() => { throw Error('Expected cancellation') }, error => error as Error)
/** Explicit worker test double models transfer ownership, registration and held jobs. */
const workerDouble = () => {
  const sources = new Map<string, PackPhysicalScene>(), messages: { kind: string; sourceKey: string; hasScene: boolean; transferCount: number; bytes: number }[] = []
  const delayed: PhysicalPreparationRequest[] = []
  let holdRegistration = false, holdViews = false, terminations = 0
  const port = {
    onmessage: null as ((event: MessageEvent<PhysicalPreparationResponse>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: PhysicalPreparationRequest, transfers: Transferable[] = []) {
      messages.push({ kind: message.kind, sourceKey: message.sourceKey, hasScene: 'scene' in message, transferCount: transfers.length, bytes: transfers.reduce<number>((sum, item) => sum + (item instanceof ArrayBuffer ? item.byteLength : 0), 0) })
      const owned = structuredClone(message, { transfer: transfers })
      if (owned.kind === 'release') { sources.delete(owned.sourceKey); return }
      if (owned.kind === 'register') sources.set(owned.sourceKey, owned.scene)
      if (owned.kind === 'register' ? holdRegistration : holdViews) delayed.push(owned)
      else queueMicrotask(() => respond(owned))
    },
    terminate() { terminations++; sources.clear() },
  }
  const respond = (request: PhysicalPreparationRequest) => {
    if (request.kind === 'release') return
    if (request.kind === 'register') { port.onmessage?.(new MessageEvent<PhysicalPreparationResponse>('message', { data: { kind: 'registered', id: request.id, sourceKey: request.sourceKey } })); return }
    const source = sources.get(request.sourceKey)!, prepared = preparePhysicalGeometry(source, request.view, request.key, request.identity)
    const meshes = prepared.meshes.map(({ object, ...mesh }) => ({ ...mesh, objectIndex: source.objects.indexOf(object) }))
    port.onmessage?.(new MessageEvent<PhysicalPreparationResponse>('message', { data: { kind: 'prepared', id: request.id, sourceKey: request.sourceKey, key: request.key, identity: request.identity, meshes, acceleration: prepared.acceleration, buffers: prepared.buffers, surfaceOwnership: prepared.surfaceOwnership } }))
  }
  return { port, sources, messages, holdRegistration: () => { holdRegistration = true }, holdViews: () => { holdViews = true }, flush: () => { for (const request of delayed.splice(0)) respond(request) }, crash: () => port.onerror?.({ message: 'diagnostic crash' } as ErrorEvent), terminations: () => terminations }
}

test('one immutable registration serves new view jobs and two host leases without detaching the caller', async () => {
  const worker = workerDouble(), pool = serialPool(() => worker.port), a = pool.createPreparer(), b = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  a.retainIdentities!(new Set(['geometry'])); b.retainIdentities!(new Set(['geometry']))
  const [first, same] = await Promise.all([a(source, view, 'plan', 'geometry', 'detail'), b(source, view, 'plan', 'geometry', 'detail')]); expect(first).toBe(same)
  await b(source, { ...view, mode: '3d' }, '3d', 'geometry', 'detail')
  expect(worker.messages.filter(message => message.kind === 'register')).toHaveLength(1)
  expect(worker.messages.filter(message => message.kind === 'prepare')).toHaveLength(2)
  expect(worker.messages.filter(message => message.kind === 'prepare').every(message => !message.hasScene && message.transferCount === 0)).toBe(true)
  expect(Array.from(source.objects[0]!.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 1]); expect(pool.diagnostics().leases).toBe(2)
  a.destroy!(); expect(pool.diagnostics().registeredSources).toBe(1); expect(worker.terminations()).toBe(0)
  b.retainIdentities!(new Set()); expect(worker.sources.size).toBe(0); expect(pool.diagnostics().registeredBytes).toBe(0)
  b.destroy!(); expect(worker.terminations()).toBe(1); expect(pool.diagnostics().workerAlive).toBe(false)
})

test('geometry registration omits host Plan ink while retaining mesh lines and surface annotations', async () => {
  const worker = workerDouble(), pool = serialPool(() => worker.port), owner = pool.createPreparer(), source = scene()
  source.planDrawing = { views: [{ levelId: 'floor', bounds: { min: [0, 0], max: [1, 1] }, primitives: [{ id: 'ink', kind: 'path', depiction: 'projection', scopeIds: [], bounds: { min: [0, 0], max: [1, 1] }, commands: [['M', 0, 0], ['L', 1, 1]], stroke: 'line' }] }] }
  source.objects[0]!.planLines = [{ positions: new Float64Array([0, 0, 0, 1, 1, 0]), material: 'line' }]
  source.planAnnotations = [{ id: 'access', kind: 'hatch', role: 'access', outline: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 0]], label: 'Access', basis: 'illustrative', scopeIds: [], levelIds: ['floor'] }]
  const before = structuredClone(source)
  try {
    await owner(source, defaultPhysicalSceneView(source.levels), 'plan', 'geometry', 'detail')
    const registered = worker.sources.get('detail')!
    expect(Object.hasOwn(registered, 'planDrawing')).toBe(false)
    expect(registered.planAnnotations).toEqual(source.planAnnotations)
    expect(registered.objects[0]!.planLines).toEqual(source.objects[0]!.planLines)
    expect(source).toEqual(before)
  } finally { owner.destroy!() }
})

test('one host leaving cancels only its result while running work remains pinned for another source owner', async () => {
  const worker = workerDouble(); worker.holdViews()
  const pool = serialPool(() => worker.port), owner = pool.createPreparer(), remaining = pool.createPreparer(), source = scene()
  remaining.retainIdentities!(new Set(['geometry']))
  const pending = refused(owner(source, defaultPhysicalSceneView(source.levels), 'plan', 'geometry', 'detail')); await settle(); owner.destroy!()
  expect((await pending).name).toBe('AbortError')
  expect(pool.diagnostics().pinnedSources).toBe(1); expect(worker.sources.size).toBe(1); expect(worker.terminations()).toBe(0)
  worker.flush(); await settle(); expect(pool.diagnostics().pinnedSources).toBe(0); expect(pool.diagnostics().registeredSources).toBe(1)
  remaining.destroy!(); expect(pool.diagnostics().registeredSources).toBe(0); expect(worker.sources.size).toBe(0); expect(worker.terminations()).toBe(1)
})

test('releasing the last lease during registration skips an obsolete view without breaking a later owner', async () => {
  const workers = [workerDouble(), workerDouble()]; workers[0]!.holdRegistration(); let created = 0
  const pool = serialPool(() => workers[created++]!.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const pending = owner(source, view, 'plan', 'geometry', 'detail').then((): never => { throw Error('Expected preparation rejection') }, error => error as Error); owner.destroy!(); workers[0]!.flush()
  expect((await pending).name).toBe('AbortError'); expect(workers[0]!.messages.some(message => message.kind === 'prepare')).toBe(false); expect(workers[0]!.terminations()).toBe(1)
  const next = pool.createPreparer(); expect((await next(source, view, 'plan', 'geometry', 'detail')).meshes.length).toBeGreaterThan(0); next.destroy!()
})

test('worker failure rejects pending work and a retained owner can register on a fresh worker', async () => {
  const workers = [workerDouble(), workerDouble()]; workers[0]!.holdViews(); let created = 0
  const pool = serialPool(() => workers[created++]!.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const pending = owner(source, view, 'plan', 'geometry', 'detail').then((): never => { throw Error('Expected preparation rejection') }, error => error as Error); await settle(); workers[0]!.crash()
  expect((await pending).message).toContain('diagnostic crash'); await settle()
  expect((await owner(source, view, 'plan', 'geometry', 'detail')).meshes.length).toBeGreaterThan(0); expect(created).toBe(2); owner.destroy!()
})

test('overview and detailed sources have distinct immutable registrations within one leased family', async () => {
  const worker = workerDouble(), pool = serialPool(() => worker.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const overview = { ...source, objects: [{ ...source.objects[0]!, id: 'building-context', subjectIds: [], positions: new Float64Array([.5, 0, 0, 1, 0, 0, .5, 1, 1]) }] }
  const detail = await owner(source, view, 'detail-view', 'same-family', 'same-family/detail'), coarse = await owner(overview, view, 'overview-view', 'same-family', 'same-family/overview')
  expect(detail.meshes[0]!.object.id).toBe('machine'); expect(coarse.meshes[0]!.object.id).toBe('building-context')
  expect(worker.messages.filter(message => message.kind === 'register')).toHaveLength(2)
  owner.retainIdentities!(new Set()); expect(worker.sources.size).toBe(0); owner.destroy!(); expect(worker.terminations()).toBe(1)
})

test('resident view discovery reports reuse and releases accounting with the last source owner', async () => {
  const worker = workerDouble(), pool = serialPool(() => worker.port), first = pool.createPreparer(), second = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  first.retainIdentities!(new Set(['geometry'])); second.retainIdentities!(new Set(['geometry']))
  const resident = await first(source, view, 'floor', 'geometry', 'detail')
  const current = await first(source, { ...view, mode: '3d' }, 'all', 'geometry', 'detail')
  await Bun.sleep(0)
  Bun.gc(true)
  expect(pool.diagnostics().retainedViews).toBe(2)
  expect(pool.diagnostics().retainedViewBytes).toBeGreaterThan(0)
  expect(await second(source, view, 'floor', 'geometry', 'detail')).toBe(resident)
  expect(pool.diagnostics().viewRequests).toBe(2)
  expect(pool.diagnostics().cacheHits).toBe(1)
  expect(current).not.toBe(resident)
  first.destroy!()
  expect(pool.diagnostics().retainedViews).toBe(2)
  second.retainIdentities!(new Set())
  expect(pool.diagnostics().retainedViews).toBe(0)
  expect(pool.diagnostics().retainedViewBytes).toBe(0)
  second.destroy!()
  const fresh = pool.createPreparer()
  await fresh(source, view, 'floor', 'geometry', 'detail')
  expect(pool.diagnostics().registrations).toBe(2)
  expect(pool.diagnostics().viewRequests).toBe(3)
  fresh.destroy!()
})

test('superseded queued views never enter the worker, while the latest demand waits for the running view', async () => {
  const worker = workerDouble(); worker.holdViews()
  const pool = serialPool(() => worker.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const a = new AbortController(), b = new AbortController(), c = new AbortController()
  const first = refused(owner(source, view, 'first', 'geometry', 'detail', a.signal)); await settle()
  const obsolete = refused(owner(source, view, 'obsolete', 'geometry', 'detail', b.signal))
  const latest = owner(source, { ...view, mode: '3d' }, 'latest', 'geometry', 'detail', c.signal); await settle()
  expect(pool.diagnostics().viewRequests).toBe(1); expect(pool.diagnostics().queuedViews).toBe(2)
  a.abort(); b.abort()
  expect((await first).name).toBe('AbortError'); expect((await obsolete).name).toBe('AbortError')
  expect(pool.diagnostics().viewRequests).toBe(1); expect(pool.diagnostics().queuedViews).toBe(1); expect(pool.diagnostics().skippedViews).toBe(1)
  worker.flush(); await settle()
  expect(pool.diagnostics().viewRequests).toBe(2); expect(pool.diagnostics().queuedViews).toBe(0)
  worker.flush(); expect((await latest).key).toBe('latest'); owner.destroy!(); await settle()
  expect(pool.diagnostics().inFlightJobs).toBe(0); expect(worker.terminations()).toBe(1)
})

test('cancelling one host cannot cancel another host shared queued demand', async () => {
  const worker = workerDouble(); worker.holdViews()
  const pool = serialPool(() => worker.port), a = pool.createPreparer(), b = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const blocker = a(source, view, 'running', 'geometry', 'detail'); await settle()
  const stop = new AbortController(), abandoned = refused(a(source, view, 'shared', 'geometry', 'detail', stop.signal)), remaining = b(source, view, 'shared', 'geometry', 'detail'); await settle()
  stop.abort(); expect((await abandoned).name).toBe('AbortError'); expect(pool.diagnostics().queuedViews).toBe(1)
  worker.flush(); await blocker; await settle(); worker.flush()
  expect((await remaining).key).toBe('shared'); expect(pool.diagnostics().viewRequests).toBe(2); expect(pool.diagnostics().skippedViews).toBe(0)
  a.destroy!(); b.destroy!()
})

test('a selected view can rejoin its still-running work after earlier demand was cancelled', async () => {
  const worker = workerDouble(); worker.holdViews()
  const pool = serialPool(() => worker.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels), stop = new AbortController()
  const old = refused(owner(source, view, 'return', 'geometry', 'detail', stop.signal)); await settle(); stop.abort(); expect((await old).name).toBe('AbortError')
  const current = owner(source, view, 'return', 'geometry', 'detail'); worker.flush()
  expect((await current).key).toBe('return'); expect(pool.diagnostics().viewRequests).toBe(1); owner.destroy!()
})

test('an immediate same-key selection after registration cancellation owns a fresh demand without duplicating transport', async () => {
  const worker = workerDouble(); worker.holdRegistration()
  const pool = serialPool(() => worker.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels), stop = new AbortController()
  const old = refused(owner(source, view, 'selected', 'geometry', 'detail', stop.signal)); stop.abort()
  const latest = owner(source, view, 'selected', 'geometry', 'detail'); worker.flush()
  expect((await old).name).toBe('AbortError'); expect((await latest).key).toBe('selected')
  expect(pool.diagnostics().registrations).toBe(1); expect(pool.diagnostics().viewRequests).toBe(1); owner.destroy!()
})

test('worker failure rejects both running and queued views and does not poison later same-key demand', async () => {
  const workers = [workerDouble(), workerDouble()]; workers[0]!.holdViews(); let next = 0
  const pool = serialPool(() => workers[next++]!.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const running = refused(owner(source, view, 'running', 'geometry', 'detail')); await settle()
  const queued = refused(owner(source, view, 'queued', 'geometry', 'detail')); await settle(); workers[0]!.crash()
  expect((await running).message).toContain('diagnostic crash'); expect((await queued).message).toContain('diagnostic crash'); await settle()
  expect(pool.diagnostics().queuedViews).toBe(0)
  expect((await owner(source, view, 'queued', 'geometry', 'detail')).key).toBe('queued'); expect(next).toBe(2); owner.destroy!()
})

test('last-owner disposal removes queued work and its source pin without interrupting another leased source', async () => {
  const worker = workerDouble(); worker.holdViews()
  const pool = serialPool(() => worker.port), a = pool.createPreparer(), b = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const running = a(source, view, 'running', 'first-family', 'first-detail'); await settle()
  const queued = refused(b(source, view, 'queued', 'second-family', 'second-detail')); await settle(); b.destroy!()
  expect((await queued).name).toBe('AbortError'); await settle()
  expect(pool.diagnostics().queuedViews).toBe(0); expect(pool.diagnostics().registeredSources).toBe(1); expect(pool.diagnostics().viewRequests).toBe(1)
  worker.flush(); await running; a.destroy!(); await settle()
  expect(pool.diagnostics().inFlightJobs).toBe(0); expect(pool.diagnostics().registeredBytes).toBe(0); expect(worker.terminations()).toBe(1)
})

test('client lifetime revokes its signal-free queued demand even when another client owns the same source family', async () => {
  for (const withdrawal of ['destroy', 'retain'] as const) {
    const worker = workerDouble(); worker.holdViews()
    const pool = serialPool(() => worker.port), a = pool.createPreparer(), b = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
    a.retainIdentities!(new Set(['geometry'])); b.retainIdentities!(new Set(['geometry']))
    const running = b(source, view, 'b-running', 'geometry', 'detail'); await settle()
    const obsolete = refused(a(source, view, 'a-queued', 'geometry', 'detail')); await settle()
    if (withdrawal === 'destroy') a.destroy!(); else a.retainIdentities!(new Set())
    expect((await obsolete).name).toBe('AbortError'); expect(pool.diagnostics().queuedViews).toBe(0)
    worker.flush(); expect((await running).key).toBe('b-running'); await settle()
    expect(pool.diagnostics().viewRequests).toBe(1); expect(pool.diagnostics().skippedViews).toBe(1)
    expect(pool.diagnostics().leases).toBe(1); a.destroy!(); b.destroy!(); expect(worker.terminations()).toBe(1)
  }
})

test('client lifetime withdraws only its demand on a shared queued view, not the other client demand', async () => {
  const worker = workerDouble(); worker.holdViews()
  const pool = serialPool(() => worker.port), a = pool.createPreparer(), b = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const blocker = b(source, view, 'running', 'geometry', 'detail'); await settle()
  const abandoned = refused(a(source, view, 'shared', 'geometry', 'detail')), current = b(source, view, 'shared', 'geometry', 'detail'); await settle()
  a.destroy!(); expect((await abandoned).name).toBe('AbortError'); expect(pool.diagnostics().queuedViews).toBe(1)
  worker.flush(); await blocker; await settle(); worker.flush(); expect((await current).key).toBe('shared')
  expect(pool.diagnostics().viewRequests).toBe(2); b.destroy!()
})

test('last-client close terminates an unresponsive worker and immediate same-key recreation cannot join old work', async () => {
  for (const blocked of ['registration', 'view'] as const) {
    const workers = [workerDouble(), workerDouble()]; if (blocked === 'registration') workers[0]!.holdRegistration(); else workers[0]!.holdViews()
    let created = 0
    const pool = serialPool(() => workers[created++]!.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
    const old = refused(owner(source, view, 'same-key', 'geometry', 'detail')); await settle()
    const staleReceive = workers[0]!.port.onmessage!
    owner.destroy!()
    expect(workers[0]!.terminations()).toBe(1)
    expect(pool.diagnostics()).toMatchObject({ workerAlive: false, clients: 0, registeredSources: 0, registeredBytes: 0, retainedViews: 0, retainedViewBytes: 0, inFlightJobs: 0, pinnedSources: 0, queuedViews: 0 })
    const fresh = pool.createPreparer(), next = fresh(source, view, 'same-key', 'geometry', 'detail')
    expect((await old).name).toBe('AbortError')
    staleReceive(new MessageEvent<PhysicalPreparationResponse>('message', { data: { kind: 'error', id: 1, message: 'Late obsolete worker callback' } }))
    expect((await next).key).toBe('same-key'); expect(created).toBe(2)
    expect(pool.diagnostics().registeredSources).toBe(1); expect(pool.diagnostics().leases).toBe(1)
    fresh.destroy!(); expect(workers[1]!.terminations()).toBe(1)
  }
})

test('preparation parallelism follows reported logical CPUs while reserving the UI, with real serial execution when unreported', () => {
  expect(physicalPreparationWorkerBudget()).toBe(1)
  expect(physicalPreparationWorkerBudget(1)).toBe(1)
  expect(physicalPreparationWorkerBudget(2)).toBe(1)
  expect(physicalPreparationWorkerBudget(3)).toBe(2)
  expect(physicalPreparationWorkerBudget(32)).toBe(31)
  for (const value of [0,-1,1.5,Infinity,NaN]) expect(() => physicalPreparationWorkerBudget(value)).toThrow('positive reported')
})

test('distinct source families prepare concurrently without replicating placement or overview/detail geometry', async () => {
  const workers = [workerDouble(),workerDouble()]; for (const worker of workers) worker.holdViews()
  let created = 0
  const pool = createPhysicalPreparationPool(() => workers[created++]!.port,() => 3), a = pool.createPreparer(), b = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const first = a(source,view,'a','family:a','a/detail'), same = b(source,view,'a','family:a','a/detail'), second = a(source,view,'b','family:b','b/detail')
  await settle()
  expect(pool.diagnostics()).toMatchObject({workerCount:2,workerBudget:2,activeWorkers:2,viewRequests:2,queuedViews:0,registeredSources:2})
  expect(workers.map(worker => worker.messages.filter(message => message.kind === 'register').length)).toEqual([1,1])
  workers[0]!.flush(); workers[1]!.flush()
  expect(await same).toBe(await first); await second
  const overview = a(source,view,'a-overview','family:a','a/overview'); await settle()
  expect(created).toBe(2); expect(workers[0]!.sources.size).toBe(2); expect(workers[1]!.sources.size).toBe(1)
  workers[0]!.flush(); await overview
  expect(Array.from(source.objects[0]!.positions)).toEqual([0,0,0,1,0,0,0,1,1])
  a.destroy!(); b.destroy!(); expect(workers.map(worker => worker.terminations())).toEqual([1,1])
  expect(pool.diagnostics()).toMatchObject({workerCount:0,registeredSources:0,registeredBytes:0,inFlightJobs:0,retainedViews:0})
})

test('CPU capacity queues additional families fairly and cancellation removes only their undispatched work', async () => {
  const workers = [workerDouble(),workerDouble()]; for (const worker of workers) worker.holdViews()
  let created = 0
  const pool = createPhysicalPreparationPool(() => workers[created++]!.port,() => 3), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels), stop = new AbortController()
  const first = owner(source,view,'a','a','a/detail'), second = owner(source,view,'b','b','b/detail'), obsolete = refused(owner(source,view,'c','c','c/detail',stop.signal))
  await settle(); expect(created).toBe(2); expect(pool.diagnostics()).toMatchObject({activeWorkers:2,queuedViews:1,viewRequests:2})
  stop.abort(); expect((await obsolete).name).toBe('AbortError'); expect(pool.diagnostics().queuedViews).toBe(0)
  const latest = owner(source,view,'c-latest','c','c/detail'); await settle(); expect(pool.diagnostics().queuedViews).toBe(1)
  workers[0]!.flush(); await first; await settle(); expect(pool.diagnostics()).toMatchObject({activeWorkers:2,queuedViews:0,viewRequests:3})
  workers[0]!.flush(); workers[1]!.flush(); await Promise.all([second,latest]); owner.destroy!()
  expect(workers.map(worker => worker.terminations())).toEqual([1,1])
})

test('one failed affinity worker rejects only its families and can retry without disturbing the other worker', async () => {
  const workers = [workerDouble(),workerDouble(),workerDouble()]; for (const worker of workers) worker.holdViews()
  let created = 0
  const pool = createPhysicalPreparationPool(() => workers[created++]!.port,() => 3), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const failed = refused(owner(source,view,'a','a','a/detail')), other = owner(source,view,'b','b','b/detail'); await settle()
  const lateCallback = workers[0]!.port.onmessage!
  workers[0]!.crash(); expect((await failed).message).toContain('diagnostic crash'); await settle()
  expect(pool.diagnostics()).toMatchObject({workerCount:1,activeWorkers:1,registeredSources:1})
  expect(pool.diagnostics().registeredBytes).toBe(workers[1]!.messages.find(message => message.kind === 'register')!.bytes)
  const retry = owner(source,view,'a','a','a/detail'); await settle(); expect(created).toBe(3)
  lateCallback(new MessageEvent<PhysicalPreparationResponse>('message',{data:{kind:'error',id:1,message:'obsolete'}}))
  workers[1]!.flush(); workers[2]!.flush(); expect((await other).key).toBe('b'); expect((await retry).key).toBe('a')
  expect(workers[1]!.messages.filter(message => message.kind === 'register')).toHaveLength(1)
  owner.destroy!(); expect(workers.map(worker => worker.terminations())).toEqual([1,1,1])
})

test('releasing a family terminates its idle worker while a different host keeps its own family', async () => {
  const workers = [workerDouble(),workerDouble()]; let created = 0
  const pool = createPhysicalPreparationPool(() => workers[created++]!.port,() => 3), a = pool.createPreparer(), b = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  a.retainIdentities!(new Set(['a'])); b.retainIdentities!(new Set(['b']))
  await Promise.all([a(source,view,'a','a','a/detail'),b(source,view,'b','b','b/detail')])
  a.retainIdentities!(new Set()); expect(workers[0]!.terminations()).toBe(1); expect(workers[1]!.terminations()).toBe(0)
  expect(pool.diagnostics()).toMatchObject({workerCount:1,registeredSources:1,leases:1})
  a.destroy!(); b.destroy!(); expect(workers[1]!.terminations()).toBe(1)
})

test('last-host disposal terminates all unresponsive workers and immediate recreation does not join their jobs', async () => {
  const workers = [workerDouble(),workerDouble(),workerDouble()]; workers[0]!.holdRegistration(); workers[1]!.holdRegistration(); let created = 0
  const pool = createPhysicalPreparationPool(() => workers[created++]!.port,() => 3), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const first = refused(owner(source,view,'a','a','a/detail')), second = refused(owner(source,view,'b','b','b/detail')); await settle(); owner.destroy!()
  expect((await first).name).toBe('AbortError'); expect((await second).name).toBe('AbortError')
  expect(workers.slice(0,2).map(worker => worker.terminations())).toEqual([1,1]); expect(pool.diagnostics()).toMatchObject({workerCount:0,inFlightJobs:0,pinnedSources:0,registeredBytes:0,queuedViews:0})
  const fresh = pool.createPreparer(); expect((await fresh(source,view,'a','a','a/detail')).key).toBe('a'); expect(created).toBe(3); fresh.destroy!()
})

test('a new family uses an idle worker before queueing behind another family at CPU capacity', async () => {
  const workers = [workerDouble(),workerDouble()]; workers[0]!.holdViews(); let created = 0
  const pool = createPhysicalPreparationPool(() => workers[created++]!.port,() => 3), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const first = owner(source,view,'a','a','a/detail'); await owner(source,view,'b','b','b/detail')
  const third = owner(source,view,'c','c','c/detail'); await settle()
  expect(workers[1]!.sources.has('c/detail')).toBe(true); expect(pool.diagnostics().queuedViews).toBe(0)
  expect((await third).key).toBe('c'); workers[0]!.flush(); await first; owner.destroy!()
})
