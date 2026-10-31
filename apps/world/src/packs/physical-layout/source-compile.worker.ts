import { compileRetainedPhysicalSource } from './source-compile.ts'
import { copyPhysicalSceneForTransfer } from '../../core/packs/scene-transfer.ts'

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (message: unknown, transfers?: ArrayBuffer[]) => void }
scope.onmessage = async event => {
  try {
    const delivery = copyPhysicalSceneForTransfer(await compileRetainedPhysicalSource(event.data))
    scope.postMessage({ ok: true, scene: delivery.scene }, delivery.transfers)
  }
  catch (error) { scope.postMessage({ ok: false, message: error instanceof Error ? error.message : 'Physical source compilation failed' }) }
}
