import type { PackPhysicalScene } from '../../core/packs/scene.ts'
import type { RetainedPhysicalLayoutData } from './model.ts'
import { validateRetainedPhysicalSource } from './source-validation.ts'

/** A browser cannot silently fall back to synchronous family construction. */
export const compilePhysicalSourceInWorker = (data: RetainedPhysicalLayoutData): Promise<PackPhysicalScene> => new Promise((resolve, reject) => {
  if (typeof Worker === 'undefined') { reject(new Error('Physical source compilation requires module worker support')); return }
  const worker = new Worker(new URL('./source-compile.worker.ts', import.meta.url), { type: 'module' })
  const fail = (error: Error): void => { worker.terminate(); reject(error) }
  worker.addEventListener('error', event => fail(new Error(event.message || 'Physical source worker failed')), { once: true })
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const response = event.data as { ok?: unknown; scene?: PackPhysicalScene; message?: unknown } | null
    if (response?.ok !== true || response.scene?.revision !== data.design.digest || response.scene.objects === undefined) { fail(new Error(typeof response?.message === 'string' ? response.message : 'Physical source worker returned a different artifact')); return }
    worker.terminate(); resolve(response.scene)
  }, { once: true })
  worker.postMessage(data)
})

const pending = new Map<string, Promise<PackPhysicalScene>>()
// Weak ownership: the renderer/scene instances retain used assets. This cache
// shares content across hosts without keeping closed Runs' geometry alive.
const assets = new Map<string, WeakRef<PackPhysicalScene['objects']>>()
type IntrinsicScene = Omit<PackPhysicalScene,'id'|'revision'|'targetObjectId'|'anchor'|'bearing'|'group'>
// The objects array is retained by delivered placement wrappers. Its ephemeron
// owns the entire intrinsic delivery, including drafting and future facets;
// neither cache independently keeps a closed Run's objects alive.
const intrinsic = new WeakMap<PackPhysicalScene['objects'],IntrinsicScene>()
const retainIntrinsic = (scene: PackPhysicalScene): void => {
  const {id:_id,revision:_revision,targetObjectId:_owner,anchor:_anchor,bearing:_bearing,group:_group,...body}=scene
  intrinsic.set(scene.objects,body)
}

export const loadPhysicalSourceAsset = async (data: RetainedPhysicalLayoutData): Promise<PackPhysicalScene> => {
  const key = `${data.compiler.id}/${data.compiler.digest}/${data.design.digest}`
  const objects = assets.get(key)?.deref()
  let loading = pending.get(key)
  if (objects !== undefined || loading !== undefined) await validateRetainedPhysicalSource(data)
  else {
    loading = (async () => {
      try {
        const scene = !('document' in globalThis)
          ? await (await import('./source-compile.ts')).compileRetainedPhysicalSource(data)
          : await compilePhysicalSourceInWorker(data)
        retainIntrinsic(scene)
        assets.set(key, new WeakRef(scene.objects))
        return scene
      } finally { pending.delete(key) }
    })()
    pending.set(key, loading)
  }
  const delivered = objects ?? (await loading!).objects, body = intrinsic.get(delivered)
  if (body === undefined) throw new Error('Live physical source discovery lost its intrinsic delivery')
  return { ...body, id: data.design.id, revision: data.design.digest, targetObjectId: data.owner.objectId,
    anchor: data.placement.anchor, bearing: data.placement.bearing,
    ...('group' in data && data.group !== undefined ? {group:data.group} : {}) }
}
