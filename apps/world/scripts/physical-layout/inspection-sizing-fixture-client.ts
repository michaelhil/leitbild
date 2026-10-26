// Developer protocol fixture only. The iframe is the real built Inspection/Faceplate.
import { layoutInspectionHostRoom, layoutInspectionMessageSchema, layoutInspectionSpaceMessage, layoutInspectionStateSchema } from '../../src/ui/physical-layout/inspection.ts'

const config = await (await fetch('/fixture/config')).json() as { state: unknown; frameUrl: string; source: string }
const state = layoutInspectionStateSchema.parse(config.state)
const room = document.querySelector<HTMLElement>('#room')!
const frame = document.querySelector<HTMLIFrameElement>('#inspection')!
const receipt = document.querySelector<HTMLElement>('#receipt')!
const failures = document.querySelector<HTMLElement>('#failure')!
const deliver = document.querySelector<HTMLButtonElement>('#deliver')!
let ready = false, intrinsic: number | null = null, reads = 0, delivered = false
const sizes: Array<{ intrinsic: number; available: number; allocated: number; afterSample: boolean }> = []
let current = layoutInspectionHostRoom({ width: room.clientWidth, height: room.clientHeight }, { top: 0, right: 0, bottom: 0, left: 0 }, 0)
const show = (): void => {
  receipt.textContent = JSON.stringify({ source: config.source, ready, delivered, reads, availableHeight: current.height,
    intrinsicHeight: intrinsic, allocatedHeight: frame.getBoundingClientRect().height, sizes }, null, 2)
}
const layout = (): void => {
  current = layoutInspectionHostRoom({ width: room.clientWidth, height: room.clientHeight }, { top: 0, right: 0, bottom: 0, left: 0 }, 0)
  frame.style.left = `${current.x}px`; frame.style.top = `${current.y}px`; frame.style.width = `${current.width}px`
  frame.style.height = `${Math.min(intrinsic ?? current.height, current.height)}px`
  if (ready) frame.contentWindow!.postMessage(layoutInspectionSpaceMessage(state, current.height), location.origin)
  show()
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return
  const type = event.data?.type
  if (!['world:layout-inspection-ready', 'world:layout-inspection-size', 'world:layout-inspection-close'].includes(type)) return
  try {
    const message = layoutInspectionMessageSchema.parse(event.data)
    if (message.layoutObjectId !== state.layoutObjectId || message.elementId !== state.elementId) throw new Error('Wrong inspection target')
    if (message.type === 'world:layout-inspection-ready') {
      if (message.channel !== state.channel) throw new Error('Wrong inspection channel')
      ready = true; deliver.disabled = false; layout()
    } else if (message.type === 'world:layout-inspection-size') {
      intrinsic = message.height; layout()
      sizes.push({ intrinsic, available: current.height, allocated: frame.getBoundingClientRect().height, afterSample: delivered }); show()
    } else failures.textContent = 'Inspection closed. Reload fixture for a new run.'
  } catch (error) { failures.textContent = String(error) }
})
deliver.onclick = async () => {
  deliver.disabled = true
  try {
    const response = await fetch('/fixture/sample', { method: 'POST' })
    const result = await response.json() as { message?: unknown; receivedWallMs?: number; error?: string }
    if (!response.ok || !result.message) throw new Error(result.error ?? `HTTP ${response.status}`)
    reads++; delivered = true
    frame.contentWindow!.postMessage(result.message, location.origin)
    document.querySelector('#sample-receipt')!.textContent = `Actual owner sample received at ${new Date(result.receivedWallMs!).toISOString()}. Resize never renews this stamp.`
    show()
  } catch (error) { failures.textContent = String(error); deliver.disabled = false }
}
document.querySelector<HTMLButtonElement>('#shrink')!.onclick = () => { room.classList.add('compact'); layout() }
document.querySelector<HTMLButtonElement>('#grow')!.onclick = () => { room.classList.remove('compact'); layout() }
new ResizeObserver(layout).observe(room)
window.addEventListener('resize', layout)
frame.src = config.frameUrl
layout()
