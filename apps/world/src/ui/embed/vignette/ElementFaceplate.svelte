<script lang="ts">
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, type DisplayOpening } from '../view-host.ts'
  import { faceplateStates, readingsOf } from './faceplate.ts'
  import { FACEPLATE_MARGIN, type Box } from './popover.ts'
  import { createVignetteSession, sampleStale, vignetteRoutes, type VignetteSnapshot } from './vignette-client.ts'
  import Faceplate from './Faceplate.svelte'

  /** One active inspection, with the same card/read model as flow and map hosts.
   * The parent keys this component by exact Run, owner and element identity. */
  let { runId, objectId, packId, elementId, name, title, context = [], alerts, frozen, opening, zoom, room, anchor, item, onclose, ondetail, oninspect, onsize, maxWidth, showHistory = true }: {
    runId: SimulationRunId; objectId: string; packId: string; elementId: string; name: string; title: string
    /** Complete owner alert rows, as supplied by topology and layout owner reads. */
    alerts: ReadonlyArray<AlertRow>; frozen: boolean; opening: DisplayOpening | null; zoom: number; room: Box; anchor: Box | null
    context?: ReadonlyArray<{ readonly label: string; readonly value: string }>
    item: () => ReadonlyArray<Element>
    onclose: (returnFocus: boolean) => void
    ondetail: (element: string) => void
    oninspect: (element: string, name: string) => void
    onsize?: ((height: number) => void) | undefined
    maxWidth?: number | undefined
    showHistory?: boolean
  } = $props()
  let snapshot = $state.raw<VignetteSnapshot>({ phase: 'connecting', series: new Map(), sampleError: null })
  let wallNow = $state(Date.now())
  let root = $state<HTMLDivElement | null>(null)
  const inspectionId = $props.id()
  const fillReason = `element-inspection:${inspectionId}`
  const readings = $derived(readingsOf([elementId], snapshot.view, snapshot.latest, snapshot.series).get(elementId) ?? null)
  const doubtful = $derived(frozen || snapshot.phase !== 'live' || sampleStale(snapshot, wallNow))
  const reason = $derived(snapshot.failure ?? snapshot.sampleError ?? (snapshot.phase === 'inactive' ? 'The Run is not loaded.' : snapshot.phase === 'missing' ? 'The Run no longer exists.' : null))
  const devices = $derived(readings?.devices ?? [])
  runOnMount(() => {
    const host = embeddedDisplayFrame()
    const request = faceplateStates(objectId, [elementId], new Date().toISOString())[0]!
    const session = createVignetteSession({ runId, state: request.state, routes: vignetteRoutes, readHistory: showHistory, onChange: next => { snapshot = next; wallNow = Date.now() } })
    const unhost = host.subscribe(next => { session.setVisible(next.shown); if (!next.shown) onclose(false) })
    const outside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || root?.contains(event.target) || item().some(node => node.contains(event.target as Node))) return
      onclose(false)
    }
    const blurred = (): void => onclose(false)
    document.addEventListener('pointerdown', outside, { capture: true }); window.addEventListener('blur', blurred)
    const clock = setInterval(() => { wallNow = Date.now() }, 1000)
    host.reportFill(fillReason, true); session.start()
    return () => { unhost(); session.close(); clearInterval(clock); host.reportFill(fillReason, false); document.removeEventListener('pointerdown', outside, { capture: true }); window.removeEventListener('blur', blurred) }
  })
</script>

<div bind:this={root}>
  <!-- This host has one active inspection and no monitoring-overlay canvas. -->
  <Faceplate {runId} {objectId} {packId} {elementId} {name} word={null} {title} context={reason === null ? context : [...context, { label: 'Data status', value: reason }]} {readings} {alerts} alertElements={[elementId]} group={false}
    related={devices.length === 0 ? null : { heading: 'Devices', entries: devices.map(device => ({ element: device.id, name: device.shortLabel ?? device.label })) }}
    {anchor} at={null} avoid={[]} {zoom} {room} frozen={doubtful} {opening} pending={false} canPin={false} maxWidth={Math.min(maxWidth ?? Infinity, Math.max(0, room.width * zoom - 2 * FACEPLATE_MARGIN))} {showHistory}
    {onclose} {ondetail} onfaceplate={oninspect}
    onpin={() => {}} onoverlay={() => {}} ontouched={() => {}} onsize={height => onsize?.(height)} />
</div>
