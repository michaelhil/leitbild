import { expect, test } from 'bun:test'
import type { PackPhysicalScene } from '../src/core/packs/scene.ts'
import { createPhysicalPreparationPool, preparePhysicalGeometry, type PhysicalPreparationRequest, type PhysicalPreparationResponse } from '../src/ui/map/physical-scene/preparation.ts'
import { defaultPhysicalSceneView } from '../src/ui/map/physical-scene/types.ts'

const scene = (): PackPhysicalScene => ({ id: 'a', targetObjectId: 'owner:a', revision: 'same-exact-source', anchor: [0, 0], bearing: 0, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, levels: [{ id: 'floor', label: 'Floor', elevation: 0, cutHeight: 2 }], objects: [{ id: 'machine', label: 'Machine', kind: 'equipment', levelId: 'floor', subjectIds: ['component'], positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 1]), indices: new Uint32Array([0, 1, 2]) }] })
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
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
  const worker = workerDouble(), pool = createPhysicalPreparationPool(() => worker.port), a = pool.createPreparer(), b = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
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

test('in-flight jobs pin their source until completion; last lease release then unregisters and stops the worker', async () => {
  const worker = workerDouble(); worker.holdViews()
  const pool = createPhysicalPreparationPool(() => worker.port), owner = pool.createPreparer(), source = scene()
  const pending = owner(source, defaultPhysicalSceneView(source.levels), 'plan', 'geometry', 'detail'); await settle(); owner.destroy!()
  expect(pool.diagnostics().pinnedSources).toBe(1); expect(worker.sources.size).toBe(1); expect(worker.terminations()).toBe(0)
  worker.flush(); expect((await pending).meshes.length).toBeGreaterThan(0); await settle()
  expect(pool.diagnostics().registeredSources).toBe(0); expect(worker.sources.size).toBe(0); expect(worker.terminations()).toBe(1)
})

test('releasing the last lease during registration skips an obsolete view without breaking a later owner', async () => {
  const workers = [workerDouble(), workerDouble()]; workers[0]!.holdRegistration(); let created = 0
  const pool = createPhysicalPreparationPool(() => workers[created++]!.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const pending = owner(source, view, 'plan', 'geometry', 'detail').then((): never => { throw Error('Expected preparation rejection') }, error => error as Error); owner.destroy!(); workers[0]!.flush()
  expect((await pending).name).toBe('AbortError'); expect(workers[0]!.messages.some(message => message.kind === 'prepare')).toBe(false); expect(workers[0]!.terminations()).toBe(1)
  const next = pool.createPreparer(); expect((await next(source, view, 'plan', 'geometry', 'detail')).meshes.length).toBeGreaterThan(0); next.destroy!()
})

test('worker failure rejects pending work and a retained owner can register on a fresh worker', async () => {
  const workers = [workerDouble(), workerDouble()]; workers[0]!.holdViews(); let created = 0
  const pool = createPhysicalPreparationPool(() => workers[created++]!.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const pending = owner(source, view, 'plan', 'geometry', 'detail').then((): never => { throw Error('Expected preparation rejection') }, error => error as Error); await settle(); workers[0]!.crash()
  expect((await pending).message).toContain('diagnostic crash'); await settle()
  expect((await owner(source, view, 'plan', 'geometry', 'detail')).meshes.length).toBeGreaterThan(0); expect(created).toBe(2); owner.destroy!()
})

test('overview and detailed sources have distinct immutable registrations within one leased family', async () => {
  const worker = workerDouble(), pool = createPhysicalPreparationPool(() => worker.port), owner = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
  const overview = { ...source, objects: [{ ...source.objects[0]!, id: 'building-context', subjectIds: [], positions: new Float64Array([.5, 0, 0, 1, 0, 0, .5, 1, 1]) }] }
  const detail = await owner(source, view, 'detail-view', 'same-family', 'same-family/detail'), coarse = await owner(overview, view, 'overview-view', 'same-family', 'same-family/overview')
  expect(detail.meshes[0]!.object.id).toBe('machine'); expect(coarse.meshes[0]!.object.id).toBe('building-context')
  expect(worker.messages.filter(message => message.kind === 'register')).toHaveLength(2)
  owner.retainIdentities!(new Set()); expect(worker.sources.size).toBe(0); owner.destroy!(); expect(worker.terminations()).toBe(1)
})

test('resident view discovery reports reuse and releases accounting with the last source owner', async () => {
  const worker = workerDouble(), pool = createPhysicalPreparationPool(() => worker.port), first = pool.createPreparer(), second = pool.createPreparer(), source = scene(), view = defaultPhysicalSceneView(source.levels)
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
