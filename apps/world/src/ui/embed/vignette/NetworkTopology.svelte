<script lang="ts">
  import type { Segment } from '@oicl/connector-diagram'
  import type { Observation } from '../../../core/observation/model.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, UNFRAMED_PRESENTATION, visibleRoom, type DisplayPresentation } from '../view-host.ts'
  import Chooser from './Chooser.svelte'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { paintLines } from './lines.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import { drawingScale, networkDrawing } from './network.ts'
  import { vignetteOpening } from './opening.svelte.ts'
  import type { Box } from './popover.ts'
  import type { AlertTone } from './readout.ts'
  import './openbridge.ts'

  // A network topology (architecture B2) in OpenBridge: lines, crossings and
  // end caps through connector-diagram on a canvas; obc-bus, obc-switch,
  // obc-transformer and obc-source over it; names and readings as text. At
  // one grid unit a row, scrolled sideways where it is wider than its frame,
  // and scaled as the composer scaled it where its rows are fewer than its
  // height (a chat column), and further to a chat's width (`fit`, W7.3). Its attribution closes it.
  // Each named item (a bus, a line, a transformer, a connection point) whose
  // element is bound to what it measures is a button over its box (W9.1): a
  // press, Enter or Space opens the element's default after this display
  // (L3, Back returns), through the page that frames it; a stop opens the
  // line it names, or a chooser where it names several. Where no page can
  // open a display (a frame no page hosts), nothing is a button.
  let { section, observations, palette, frozen = false, fit = 1 }: { section: Extract<VignetteSection, { kind: 'topology' }>; observations: ReadonlyArray<Observation>; palette: Palette; frozen?: boolean; fit?: number } = $props()

  const drawing = $derived(networkDrawing(section, observations, frozen))
  const scale = $derived(drawingScale(section) * fit)
  let presentation = $state.raw<DisplayPresentation>(UNFRAMED_PRESENTATION)
  let viewport = $state.raw({ width: window.innerWidth, height: window.innerHeight })
  const zoom = $derived(presentation.zoom)
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
  const named = $derived(new Map([...drawing.texts.map(text => [text.id, text.title] as const), ...drawing.buses.map(bus => [bus.id, bus.title] as const)]))
  /** The items a press opens, each over its laid-out box (its symbol or bar and its words), in reading order for Tab (W8.3). */
  const items = $derived(opening === undefined || opening.where === null ? [] : section.layout.nodes.flatMap(node => {
    const title = named.get(node.id)
    return title === undefined || targetsOf(node.id).length === 0 ? [] : [{ id: node.id, title, x: node.x * VIGNETTE_ROW_PX, y: node.y * VIGNETTE_ROW_PX, width: node.width * VIGNETTE_ROW_PX, height: node.height * VIGNETTE_ROW_PX }]
  }).sort((left, right) => Math.round(left.y / VIGNETTE_ROW_PX) - Math.round(right.y / VIGNETTE_ROW_PX) || left.x - right.x))
  const buttons = new Map<string, HTMLElement>()
  const kept = (node: HTMLElement, id: string) => {
    buttons.set(id, node)
    return { destroy: () => { if (buttons.get(id) === node) buttons.delete(id) } }
  }
  let notice = $state<string | null>(null)
  let chooser = $state.raw<{ readonly id: string; readonly box: Box } | null>(null)
  const open = (element: string, name: string): void => {
    void opening?.element(section.objectId, element, 'detail').then(reason => { notice = reason === null ? null : `${name} cannot be opened: ${reason}` })
  }
  const press = (id: string): void => {
    const targets = targetsOf(id)
    const rect = buttons.get(id)?.getBoundingClientRect()
    if (targets.length === 1) open(targets[0]!.element, targets[0]!.name)
    else if (rect !== undefined) chooser = { id, box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } }
  }
  const key = (id: string) => (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    press(id)
  }
  const closeChooser = (returnFocus: boolean): void => {
    const was = chooser
    chooser = null
    if (returnFocus && was !== null) buttons.get(was.id)?.focus()
  }

  /** OpenBridge's alert type for each priority drawn in colour; emergency is its critical level. */
  const ALERT_TYPE: Readonly<Record<AlertTone, string>> = { caution: 'caution', warning: 'warning', alarm: 'alarm', critical: 'level-critical' }

  type Paint = { readonly segments: ReadonlyArray<Segment>; readonly width: number; readonly height: number; readonly palette: Palette; readonly zoom: number }
  const lines = (canvas: HTMLCanvasElement, params: Paint) => {
    const paint = (next: Paint): void => paintLines(canvas, next, next.segments, next.zoom)
    paint(params)
    return { update: paint }
  }
</script>

<div class="network">
  <div class="fit" style:width={`${drawing.width * scale}px`} style:height={`${drawing.height * scale}px`}>
  <div class="drawing" style:width={`${drawing.width}px`} style:height={`${drawing.height}px`} style:transform={scale < 1 ? `scale(${scale})` : undefined} style:--unscale={1 / scale} role="group" aria-label="Network topology">
    <canvas use:lines={{ segments: drawing.segments, width: drawing.width, height: drawing.height, palette, zoom }}></canvas>
    {#each drawing.buses as bus (bus.id)}
      <obc-bus class="placed" size="small" vertical={bus.vertical} label={bus.label} title={bus.title} style:left={`${bus.x}px`} style:top={`${bus.y}px`} style:width={`${bus.width}px`} style:height={`${bus.height}px`}></obc-bus>
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
      <div class={`text ${text.tone ?? ''}`} class:below={text.below} style:left={`${text.x}px`} style:top={`${text.y}px`} style:width={`${text.width}px`} title={text.title}>
        <span class="name">{text.name}</span>{#if text.reading !== null}<span class="reading">{text.below ? '' : ' · '}{text.reading}</span>{/if}
      </div>
    {/each}
    {#each items as item (item.id)}
      {@const several = targetsOf(item.id).length > 1}
      <div class="placed area" role="button" tabindex="0" aria-label={`Open ${item.title}`} aria-haspopup={several ? 'dialog' : undefined} title={item.title} use:kept={item.id}
        style:left={`${item.x}px`} style:top={`${item.y}px`} style:width={`${item.width}px`} style:height={`${item.height}px`} onclick={() => press(item.id)} onkeydown={key(item.id)}></div>
    {/each}
  </div>
  </div>
  {#if notice !== null}<p class="notice" role="status">{notice}</p>{/if}
  {#if chooser !== null}
    {@const id = chooser.id}
    <Chooser name={named.get(id) ?? id} entries={targetsOf(id)} box={chooser.box} room={visibleRoom(presentation, viewport)} {zoom} item={() => buttons.get(id) === undefined ? [] : [buttons.get(id)!]}
      onchoose={entry => { chooser = null; open(entry.element, entry.name) }} onclose={closeChooser} />
  {/if}
</div>
{#if section.attribution !== undefined}<p class="attribution">{section.attribution}</p>{/if}

<style>
  .network { overflow-x: auto; overflow-y: hidden; }
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
  .text { position: absolute; height: var(--row); line-height: 20px; font-size: 12px; white-space: nowrap; overflow: hidden; }
  .text.below { height: calc(2 * var(--row)); display: flex; flex-direction: column; justify-content: space-between; line-height: 18px; }
  .reading { color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .text.caution .name, .text.warning .name, .text.alarm .name, .text.critical .name { font-weight: 700; text-decoration: underline 2px; text-underline-offset: 2px; }
  .text.caution .name { text-decoration-color: var(--display-caution-mark); }
  .text.warning .name { text-decoration-color: var(--display-warning-mark); }
  .text.alarm .name { text-decoration-color: var(--display-alarm-mark); }
  .text.critical .name { text-decoration-color: var(--display-critical-mark); }
  .attribution { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
