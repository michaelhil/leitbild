import type { PackPhysicalScene } from '../../../core/packs/scene.ts'
import { buildVisibleMeshes, type PhysicalMesh } from './geometry.ts'
import { admitPhysicalPickAcceleration, preparePhysicalPickAcceleration, type PhysicalPickAcceleration } from './picking.ts'
import type { PhysicalSceneView } from './types.ts'

export interface PhysicalPreparedGeometry { readonly key: string; readonly meshes: ReadonlyArray<PhysicalMesh>; readonly acceleration: PhysicalPickAcceleration }
export type PhysicalGeometryPreparer = (scene: PackPhysicalScene, view: PhysicalSceneView, key: string) => Promise<PhysicalPreparedGeometry>
/** Shared with the module worker and explicit offline/test preparation ports. */
export const preparePhysicalGeometry = (scene: PackPhysicalScene, view: PhysicalSceneView, key: string): PhysicalPreparedGeometry => {
  const meshes = buildVisibleMeshes(scene, view).map((mesh, index) => ({ ...mesh, assetKey: key, assetIndex: index }))
  return { key, meshes, acceleration: preparePhysicalPickAcceleration(meshes) }
}
type WireMesh = Omit<PhysicalMesh, 'object'> & { readonly objectIndex: number }
export interface PhysicalPreparationRequest { readonly id: number; readonly key: string; readonly scene: PackPhysicalScene; readonly view: PhysicalSceneView }
export interface PhysicalPreparationResponse { readonly id: number; readonly key: string; readonly meshes?: ReadonlyArray<WireMesh>; readonly acceleration?: PhysicalPickAcceleration; readonly error?: string }
const shared = new Map<string, WeakRef<PhysicalPreparedGeometry>>(), pending = new Map<string, Promise<PhysicalPreparedGeometry>>()
let worker: Worker | null = null, sequence = 0
const jobs = new Map<number, { readonly key: string; readonly scene: PackPhysicalScene; readonly resolve: (value: PhysicalPreparedGeometry) => void; readonly reject: (error: Error) => void }>()
const requireWorker = (): Worker => {
  if (worker) return worker
  if (typeof Worker === 'undefined') throw new Error('Physical layout preparation requires a module Worker')
  worker = new Worker(new URL('./preparation-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<PhysicalPreparationResponse>) => {
    const result = event.data, job = jobs.get(result.id)
    if (!job) return
    jobs.delete(result.id)
    if (result.key !== job.key || result.error || !result.meshes || !result.acceleration) { job.reject(new Error(result.error ?? 'Physical preparation returned an incompatible result')); return }
    try {
      const meshes = result.meshes.map(({ objectIndex, ...mesh }) => {
        const object = job.scene.objects[objectIndex]
        if (!object) throw new Error('Prepared fragment names an unknown occurrence')
        return { ...mesh, object }
      })
      admitPhysicalPickAcceleration(meshes, result.acceleration)
      const value = { key: job.key, meshes, acceleration: result.acceleration }; shared.set(job.key, new WeakRef(value)); job.resolve(value)
    } catch (error) { job.reject(error instanceof Error ? error : new Error(String(error))) }
  }
  worker.onerror = event => { const error = new Error(`Physical preparation worker failed: ${event.message}`); for (const job of jobs.values()) job.reject(error); jobs.clear(); worker?.terminate(); worker = null }
  return worker
}
export const createPhysicalGeometryPreparer = (): PhysicalGeometryPreparer => (scene, view, key) => {
  const cached = shared.get(key)?.deref()
  if (cached) return Promise.resolve(cached)
  const existing = pending.get(key)
  if (existing) return existing
  const task = new Promise<PhysicalPreparedGeometry>((resolve, reject) => {
    const id = ++sequence
    jobs.set(id, { key, scene, resolve, reject })
    try { requireWorker().postMessage({ id, key, scene, view } satisfies PhysicalPreparationRequest) }
    catch (error) { jobs.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
  })
  pending.set(key, task)
  void task.then(() => pending.delete(key), () => pending.delete(key))
  return task
}
