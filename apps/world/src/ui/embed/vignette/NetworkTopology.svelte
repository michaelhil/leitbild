<script lang="ts">
  import type { Segment } from '@oicl/connector-diagram'
  import type { Observation } from '../../../core/observation/model.ts'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, UNFRAMED_PRESENTATION, visibleRoom, type DisplayPresentation } from '../view-host.ts'
  import Chooser from './Chooser.svelte'
  import { drawnScale, VIGNETTE_ROW_PX } from './grid.ts'
  import { NO_SCROLL_ENDS, scrollEnds, type ScrollEnds } from './scroll-ends.ts'
  import Continues from './Continues.svelte'
  import { paintLines } from './lines.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import { networkDrawing, widthFit } from './network.ts'
  import { NETWORK_SEPARATOR } from '../../../features/displays/topology/network-room.ts'
  import { FLOW_TEXT } from '../../../features/displays/topology/text.ts'
  import { vignetteOpening } from './opening.svelte.ts'
  import { openElementDetail, type Box, type OpenedFrom } from './popover.ts'
  import { componentActivationKey } from './component-activation.ts'
  import { onElementRequest } from './selection.ts'
  import ElementFaceplate from './ElementFaceplate.svelte'
  import type { AlertTone } from './readout.ts'
  import './openbridge.ts'

  // A network topology (architecture B2) in OpenBridge: lines, crossings and
  // end caps through connector-diagram on a canvas; obc-bus, obc-switch,
  // obc-transformer and obc-source over it; names and readings as text, each
  // whole in the room the composer measured for it (network.ts). At one grid
  // unit a row, scaled as the composer scaled it where its rows are fewer than
  // its height, down to its text floor on screen at the window's zoom, past
  // which it scrolls down within its rows (grid.ts drawnScale); further to a
  // chat's width (`fit`, W7.3); and to its frame's width down to the text
  // floor, past which it scrolls sideways (W4.3). Where it scrolls it says it
  // continues. Its attribution closes it.
  // Each named item (a bus, a line, a transformer, a connection point) whose
  // element is bound to what it measures is a button over its box (W9.1): a
  // press, Enter or Space opens its exact element faceplate. A continuation
  // names one target, or a chooser where it names several. Only the card's
  // explicit Open detail action advances the display.
  let { section, observations, alerts, runId, from, palette, frozen = false, fit = 1 }: { section: Extract<VignetteSection, { kind: 'topology' }>; observations: ReadonlyArray<Observation>; alerts: ReadonlyArray<AlertRow>; runId: SimulationRunId; from: OpenedFrom; palette: Palette; frozen?: boolean; fit?: number } = $props()

  const drawing = $derived(networkDrawing(section, observations, frozen))
  let presentation = $state.raw<DisplayPresentation>(UNFRAMED_PRESENTATION)
  let viewport = $state.raw({ width: window.innerWidth, height: window.innerHeight })
  const zoom = $derived(presentation.zoom)
  // Wider than its frame (W4.3): scaled to the frame's width while its text stays at TEXT_FLOOR_PX or more on screen,
  // as a window frame scales a flow drawing (grid.ts frameLayout); past that it scrolls sideways, an edge fading and
  // "drawing continues" showing where there is more.
  let available = $state(0)
  const scaledTo = $derived(drawnScale(section, zoom) * fit)
  const scale = $derived(scaledTo * widthFit(drawing.width, scaledTo, available, zoom))
  // Taller than its rows hold at its text floor (all but its attribution's, as a chat scales them): it scrolls down within them.
  const held = $derived((section.rows - 1) * VIGNETTE_ROW_PX * fit)
  const tall = $derived(drawing.height * scale > held + 0.5)
  let more = $state<ScrollEnds>(NO_SCROLL_ENDS)
  runOnMount(() => {
    const resized = (): void => { viewport = { width: window.innerWidth, height: window.innerHeight } }
    window.addEventListener('resize', resized)
    const stop = embeddedDisplayFrame().subscribe(next => { presentation = next })
    return () => { stop(); window.removeEventListener('resize', resized) }
  })

  // --- What a press on an item opens ----------------------------------------------------------------------------------
  const opening = vignetteOpening()
  const byId = $derived(new Map(section.nodes.map(node => [node.id, node])))
  /** A stop's far ends, else the item's own element where its default leads with what it is bound to; none, no button. */
  const targetsOf = (id: string): ReadonlyArray<{ readonly element: string; readonly name: string }> => {
    const node = byId.get(id)
    if (node?.stop !== undefined) return node.stop.far.flatMap(end => end.element === undefined ? [] : [{ element: end.element, name: end.label }])
    return node?.element === undefined || node.bindings.length === 0 ? [] : [{ element: node.element, name: node.label }]
  }
  const named = $derived(new Map([...drawing.buses.map(bus => [bus.id, bus.title] as const), ...drawing.texts.map(text => [text.id, text.title] as const)]))
  /** The items a press opens, each over its laid-out box (its symbol or bar and its words), in reading order for Tab (W8.3). */
  const items = $derived(section.layout.nodes.flatMap(node => {
    const title = named.get(node.id)
    return title === undefined || targetsOf(node.id).length === 0 ? [] : [{ id: node.id, title, x: node.x * VIGNETTE_ROW_PX, y: node.y * VIGNETTE_ROW_PX, width: node.width * VIGNETTE_ROW_PX, height: node.height * VIGNETTE_ROW_PX }]
  }).sort((left, right) => Math.round(left.y / VIGNETTE_ROW_PX) - Math.round(right.y / VIGNETTE_ROW_PX) || left.x - right.x))
  const buttons = new Map<string, HTMLElement>()
  const kept = (node: HTMLElement, id: string) => {
    buttons.set(id, node)
    return { destroy: () => { if (buttons.get(id) === node) buttons.delete(id) } }
  }
  let notice = $state<string | null>(null)
  const ownerIdentity = $derived(JSON.stringify([runId, section.objectId, section.packId]))
  let selected = $state<{ readonly owner: string; readonly element: string; readonly name: string; readonly origin: string } | null>(null)
  const inspected = $derived(selected?.owner === ownerIdentity ? selected : null)
  const room = $derived(visibleRoom(presentation, viewport))
  const anchor = $derived.by((): Box | null => {
    void presentation
    const box = inspected === null ? undefined : buttons.get(inspected.origin)?.getBoundingClientRect()
    return box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height }
  })
  const closeInspection = (returnFocus: boolean): void => {
    const was = selected; selected = null
    if (returnFocus && was !== null) buttons.get(was.origin)?.focus()
  }
  let chooser = $state.raw<{ readonly owner: string; readonly id: string; readonly box: Box } | null>(null)
  const open = (element: string, name: string, origin: string): void => { selected = { owner: ownerIdentity, element, name, origin } }
  const detail = async (element: string): Promise<void> => {
    closeInspection(false)
    try { notice = await openElementDetail(embeddedDisplayFrame(), runId, from, section.objectId, element) ? null : 'No display window can show this detail from here.' }
    catch (error) { notice = error instanceof Error ? error.message : String(error) }
  }
  const press = (id: string): void => {
    const targets = targetsOf(id)
    const rect = buttons.get(id)?.getBoundingClientRect()
    if (targets.length === 1) open(targets[0]!.element, targets[0]!.name, id)
    else if (rect !== undefined) chooser = { owner: ownerIdentity, id, box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } }
  }
  const key = (id: string) => (event: KeyboardEvent): void => {
    if (!componentActivationKey(event)) return
    event.preventDefault()
    press(id)
  }
  const closeChooser = (returnFocus: boolean): void => {
    const was = chooser
    chooser = null
    if (returnFocus && was !== null) buttons.get(was.id)?.focus()
  }
  runOnMount(() => onElementRequest(request => {
    if (request.objectId !== section.objectId) return false
    const item = items.find(item => targetsOf(item.id).some(target => target.element === request.elementId))
    if (!item) return false
    if (request.how === 'detail') void detail(request.elementId)
    else if (request.how === 'select') { const target = targetsOf(item.id).find(target => target.element === request.elementId)!; buttons.get(item.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); open(target.element, target.name, item.id) }
    return true
  }))

  /** OpenBridge's alert type for each priority drawn in colour; emergency is its critical level. */
  const ALERT_TYPE: Readonly<Record<AlertTone, string>> = { caution: 'caution', warning: 'warning', alarm: 'alarm', critical: 'level-critical' }

  type Paint = { readonly segments: ReadonlyArray<Segment>; readonly width: number; readonly height: number; readonly palette: Palette; readonly zoom: number }
  const lines = (canvas: HTMLCanvasElement, params: Paint) => {
    const paint = (next: Paint): void => paintLines(canvas, next, next.segments, next.zoom)
    paint(params)
    return { update: paint }
  }
</script>

<div class="frame">
<div class="network" class:tall style:max-height={tall ? `${held}px` : undefined} bind:clientWidth={available} use:scrollEnds={ends => { more = ends }}>
  <div class="fit" style:width={`${drawing.width * scale}px`} style:height={`${drawing.height * scale}px`}>
  <div class="drawing" style:width={`${drawing.width}px`} style:height={`${drawing.height}px`} style:transform={scale < 1 ? `scale(${scale})` : undefined} style:--unscale={1 / scale} role="group" aria-label="Network topology">
    <canvas use:lines={{ segments: drawing.segments, width: drawing.width, height: drawing.height, palette, zoom }}></canvas>
    {#each drawing.buses as bus (bus.id)}
      <obc-bus class="placed" size="small" vertical={bus.vertical} label={bus.label} title={bus.title} style:left={`${bus.x}px`} style:top={`${bus.y}px`} style:width={`${bus.width}px`} style:height={`${bus.height}px`}></obc-bus>
      <!-- An alert on a bus whose name is in its bar: marked under the bar, as an unframed name is underlined. -->
      {#if bus.tone !== null && bus.label !== ''}<div class={`placed bar-mark ${bus.tone}`} aria-hidden="true" style:left={`${bus.x}px`} style:top={`${bus.y + bus.height + 2}px`} style:width={`${bus.width}px`}></div>{/if}
    {/each}
    {#each drawing.devices as device (device.id)}
      <!-- Inert: OpenBridge's symbol draws a <button> of its own; the item's area is its button (W8.3). -->
      <div class="placed" inert style:left={`${device.x}px`} style:top={`${device.y}px`} title={device.title}>
        {#if device.element === 'obc-switch'}
          <obc-switch positioning="point" showReadoutStack={false} turnedOn={device.on} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small"></obc-switch>
        {:else if device.element === 'obc-transformer'}
          <obc-transformer positioning="point" showReadoutStack={false} turnedOn={device.on} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small"></obc-transformer>
        {:else}
          <obc-source positioning="point" showReadoutStack={false} turnedOn={device.on} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small"></obc-source>
        {/if}
      </div>
    {/each}
    {#each drawing.texts as text (text.id)}
      {#each text.rows as row, at (at)}
        <div class={`text ${text.tone ?? ''}`} class:framed={text.framed} class:end={row.align === 'end'} style:left={`${row.x}px`} style:top={`${row.y}px`} style:width={`${row.width}px`} style:height={`${row.height}px`} title={text.title}>
          {#each row.parts as part, index (index)}{#if index > 0}<span class="name">{NETWORK_SEPARATOR}</span>{/if}<span class={part.kind} style:font-size={`${FLOW_TEXT[part.style].size}px`}>{part.text}</span>{/each}
        </div>
      {/each}
    {/each}
    {#each items as item (item.id)}
      <div class="placed area" role="button" tabindex="0" aria-label={`Faceplate: ${item.title}`} aria-haspopup="dialog" aria-expanded={inspected?.origin === item.id} title={item.title} use:kept={item.id}
        style:left={`${item.x}px`} style:top={`${item.y}px`} style:width={`${item.width}px`} style:height={`${item.height}px`} onclick={() => press(item.id)} onkeydown={key(item.id)}></div>
    {/each}
  </div>
  </div>
  {#if notice !== null}<p class="notice" role="status">{notice}</p>{/if}
  {#if chooser !== null && chooser.owner === ownerIdentity}
    {@const id = chooser.id}
    <Chooser name={named.get(id) ?? id} entries={targetsOf(id)} box={chooser.box} room={visibleRoom(presentation, viewport)} {zoom} item={() => buttons.get(id) === undefined ? [] : [buttons.get(id)!]}
      onchoose={entry => { const current = chooser; if (current === null || current.owner !== ownerIdentity) return; chooser = null; open(entry.element, entry.name, current.id) }} onclose={closeChooser} />
  {/if}
  {#if inspected !== null}
    {#key JSON.stringify([ownerIdentity, inspected.element])}
      <ElementFaceplate {runId} objectId={section.objectId} packId={section.packId} elementId={inspected.element} name={inspected.name} title={from.title} {alerts} {frozen} opening={opening?.where ?? null} {zoom} {room} {anchor}
        item={() => inspected === null || buttons.get(inspected.origin) === undefined ? [] : [buttons.get(inspected.origin)!]} onclose={closeInspection} ondetail={element => { void detail(element) }} oninspect={(element, name) => { if (inspected !== null) open(element, name, inspected.origin) }} />
    {/key}
  {/if}
</div>
<Continues ends={more} />
</div>
{#if section.attribution !== undefined}<p class="attribution">{section.attribution}</p>{/if}

<style>
  .frame { position: relative; }
  .network { overflow-x: auto; overflow-y: hidden; }
  .network.tall { overflow-y: auto; }
  .drawing { position: relative; transform-origin: 0 0; }
  canvas { position: absolute; left: 0; top: 0; }
  .placed { position: absolute; }
  /* An item's button: its box over its symbol or bar and its words, OpenBridge's flat hover and focus on it. */
  .area { z-index: 1; border-radius: 4px; cursor: pointer; }
  .area:hover { background: var(--flat-hover-background-color); }
  .area:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 2px; }
  /* On a touch screen an item's press target reaches 40 px on screen, whatever the drawing's scale (W8.3). */
  @media (pointer: coarse) {
    .area::before { content: ''; position: absolute; left: 50%; top: 50%; width: max(100%, calc(40px * var(--unscale))); height: max(100%, calc(40px * var(--unscale))); transform: translate(-50%, -50%); }
  }
  .notice { margin: 0; font-size: 12px; color: var(--element-active-color); }
  /* Each row in the room the composer kept for it (topology/network-room.ts), whole, in Noto Sans: names 12 px neutral, readings 14 px in the active colour. */
  .text { position: absolute; display: flex; align-items: center; white-space: pre; pointer-events: none; }
  .text.end { justify-content: flex-end; }
  .text .name { font-size: 12px; color: var(--element-neutral-color); }
  .reading { color: var(--element-active-color); font-variant-numeric: tabular-nums; }
  /* An alert on the item: its name bold in the active colour; underlined in its colour only where no frame marks it (U-27). */
  .text.caution .name, .text.warning .name, .text.alarm .name, .text.critical .name { font-weight: 700; color: var(--element-active-color); }
  .text:not(.framed):is(.caution, .warning, .alarm, .critical) .name { text-decoration-line: underline; text-decoration-thickness: 2px; text-underline-offset: 2px; }
  /* A name is marked by its underline, a bus by its mark under the bar: only the mark is filled. */
  .text.caution .name { text-decoration-color: var(--display-caution-mark); }
  .text.warning .name { text-decoration-color: var(--display-warning-mark); }
  .text.alarm .name { text-decoration-color: var(--display-alarm-mark); }
  .text.critical .name { text-decoration-color: var(--display-critical-mark); }
  .bar-mark.caution { background-color: var(--display-caution-mark); }
  .bar-mark.warning { background-color: var(--display-warning-mark); }
  .bar-mark.alarm { background-color: var(--display-alarm-mark); }
  .bar-mark.critical { background-color: var(--display-critical-mark); }
  .bar-mark { height: 2px; border-radius: 1px; }
  .attribution { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
