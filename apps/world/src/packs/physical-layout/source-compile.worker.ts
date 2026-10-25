import { compileRetainedPhysicalSource } from './source-compile.ts'

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (message: unknown) => void }
scope.onmessage = async event => {
  try { scope.postMessage({ ok: true, scene: await compileRetainedPhysicalSource(event.data) }) }
  catch (error) { scope.postMessage({ ok: false, message: error instanceof Error ? error.message : 'Physical source compilation failed' }) }
}
