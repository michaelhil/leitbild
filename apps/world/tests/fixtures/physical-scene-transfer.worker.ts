import { packPhysicalSceneSchema } from '../../src/core/packs/scene.ts'
import { copyPhysicalSceneForTransfer } from '../../src/core/packs/scene-transfer.ts'

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (message: unknown, transfers?: ArrayBuffer[]) => void }
scope.onmessage = event => {
  const input = packPhysicalSceneSchema.parse(event.data), positions = input.objects[0]!.positions
  const delivery = copyPhysicalSceneForTransfer(input)
  scope.postMessage({ scene: delivery.scene }, delivery.transfers)
  scope.postMessage({ detached: delivery.transfers.every(buffer => buffer.byteLength === 0), inputIntact: positions.length === 9 && positions[0] === 0.123456789012345 })
}
