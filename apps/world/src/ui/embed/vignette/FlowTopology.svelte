<script lang="ts">
  import type { Segment } from '@oicl/connector-diagram'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import type { Observation } from '../../../core/observation/model.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, type DisplayOpening } from '../view-host.ts'
  import ElementPopover from './ElementPopover.svelte'
  import { FLOW_LINE_PX, flowDrawing } from './flow-symbols.ts'
  import { drawingScale } from './network.ts'
  import { paintLines } from './lines.ts'
  import { magnifierAt, MAGNIFIER } from './magnifier.ts'
  import { nextPopover, openElementDetail, POPOVER_CLOSED, type OpenedFrom, type PopoverState } from './popover.ts'
  import type { AlertTone } from './readout.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import Vessel from './Vessel.svelte'
  import './openbridge.ts'

  // A flow topology (architecture B3) in OpenBridge (flow-symbols.ts): pipes,
  // header bars and end caps through connector-diagram on a canvas; devices,
  // tanks, heat exchangers and buses as OpenBridge's own elements over it, the
  // lanes' hub as the registered vessel; names and readings as text where the
  // layout kept room for them. At one grid unit a row, scrolled sideways where
  // it is wider than its frame, and scaled as the composer scaled it where its
  // rows are fewer than its height (a chat column).
  // Option A (plan v5 §3): a press on an item's body, its symbol or its text
  // (Enter or Space), opens its detail, the element's World default as the
  // next display in the window (Back, and Esc, return here); in a chat answer
  // or a tag's dialog, which have no window to walk in, it opens the
  // faceplate. OpenBridge's 16 px magnifier after the item's name opens the
  // faceplate (L2, ElementPopover.svelte): it shows on hover and focus and
  // always on touch, it is its own tab stop straight after its item, and
  // Shift+Enter on the item does the same.
  let { section, observations, alerts, palette, frozen, runId, from }: {
    section: Extract<VignetteSection, { kind: 'topology' }>
    observations: ReadonlyArray<Observation>
    alerts: ReadonlyArray<AlertRow>
    palette: Palette
    /** The sample is frozen: everything reads as unknown. */
    frozen: boolean
    runId: SimulationRunId
    /** The display this drawing stands in: an element's detail opened from it names it, and Back returns here. */
    from: OpenedFrom
  } = $props()

  const drawing = $derived(flowDrawing(section, observations, alerts, frozen))
  const scale = $derived(drawingScale(section))
  let zoom = $state(1)
  let opening = $state<DisplayOpening | null>(null)
  runOnMount(() => {
    const host = embeddedDisplayFrame()
    const stops = [host.subscribe(presentation => { zoom = presentation.zoom }), host.subscribeOpening(where => { opening = where })]
    return () => { for (const stop of stops) stop() }
  })

  /** A device symbol's two grid cells. */
  const SYMBOL_PX = 2 * VIGNETTE_ROW_PX
  /** OpenBridge's alert type for each priority drawn in colour; emergency is its critical level. */
  const ALERT_TYPE: Readonly<Record<AlertTone, string>> = { caution: 'caution', warning: 'warning', alarm: 'alarm', critical: 'level-critical' }

  type Paint = { readonly segments: ReadonlyArray<Segment>; readonly width: number; readonly height: number; readonly palette: Palette; readonly zoom: number }
  const lines = (canvas: HTMLCanvasElement, params: Paint) => {
    const paint = (next: Paint): void => paintLines(canvas, next, next.segments, next.zoom)
    paint(params)
    return { update: paint }
  }

  const items = $derived(new Map([...drawing.devices, ...drawing.vessels].map(item => [item.id, item])))
  const texts = $derived(new Map(drawing.texts.map(text => [text.id, text])))
  const nameOf = (id: string): string => texts.get(id)?.lines[0]?.text ?? items.get(id)?.title ?? id

  // Each item's button and text block as drawn, for focus, the faceplate's place and the magnifier's measure.
  const buttons = new Map<string, HTMLElement>()
  const textBlocks = new Map<string, HTMLElement>()
  const kept = (store: Map<string, HTMLElement>) => (node: HTMLElement, id: string) => {
    store.set(id, node)
    return { destroy: () => { if (store.get(id) === node) store.delete(id) } }
  }
  const button = kept(buttons)
  const textBlock = kept(textBlocks)

  // --- L2: the faceplate --------------------------------------------------------------------------------------------
  let popover = $state<PopoverState>(POPOVER_CLOSED)
  const openFaceplate = (id: string): void => { popover = nextPopover(popover, { kind: 'pressed', item: id }) }
  const close = (returnFocus: boolean): void => {
    const was = popover
    popover = nextPopover(popover, { kind: 'dismissed' })
    if (returnFocus && was.kind === 'open') buttons.get(was.item)?.focus()
  }
  const open = $derived(popover.kind === 'open' ? items.get(popover.item) : undefined)

  // --- L3: the detail, the element's World default after this display -------------------------------------------------
  let notice = $state<string | null>(null)
  const openDetail = async (id: string): Promise<void> => {
    const item = items.get(id)
    if (item === undefined) return
    // A chat answer or a tag's dialog has no window to walk in: there the body opens the faceplate too.
    if (opening !== 'window') { openFaceplate(id); return }
    try {
      if (!(await openElementDetail(embeddedDisplayFrame(), runId, from, section.objectId, item.element))) openFaceplate(id)
      notice = null
    } catch (error) {
      notice = `${nameOf(id)} cannot be opened: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const bodyKey = (id: string) => (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); openFaceplate(id); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void openDetail(id)
  }

  // --- The magnifier --------------------------------------------------------------------------------------------------
  /** Each item's name as drawn, in drawing px, measured once its text is laid out and whenever a name changes. */
  let named = $state.raw<Readonly<Record<string, number>>>({})
  const names = $derived(drawing.texts.filter(text => items.has(text.id)).map(text => `${text.id}\u0000${text.lines[0]?.text ?? ''}`).join('\u0001'))
  $effect(() => {
    void names
    const factor = scale
    const frame = requestAnimationFrame(() => {
      const next: Record<string, number> = {}
      for (const [id, block] of textBlocks) {
        const first = block.firstElementChild
        if (!items.has(id) || first === null) continue
        const range = document.createRange()
        range.selectNodeContents(first)
        next[id] = range.getBoundingClientRect().width / factor
      }
      named = next
    })
    return () => cancelAnimationFrame(frame)
  })
  const magnifiers = $derived(new Map(drawing.texts.flatMap(text => {
    const width = named[text.id]
    return width === undefined || !items.has(text.id) ? [] : [[text.id, magnifierAt(text, FLOW_LINE_PX, width, drawing)] as const]
  })))
  let hovered = $state<string | null>(null)
  let focused = $state<string | null>(null)
  const shown = (id: string): boolean => hovered === id || focused === id || (popover.kind === 'open' && popover.item === id)
  const hover = (id: string) => ({ onpointerenter: () => { hovered = id }, onpointerleave: () => { if (hovered === id) hovered = null } })
  const focus = (id: string) => ({ onfocus: () => { focused = id }, onblur: () => { if (focused === id) focused = null } })
</script>

{#snippet magnifier(id: string)}
  {@const at = magnifiers.get(id)}
  {#if at !== undefined}
    <!-- Its own tab stop straight after its item; the 40 px square is the press target, the 16 px glyph its ink. -->
    <button type="button" class="magnifier" class:shown={shown(id)} data-magnifier={id} aria-label={`Faceplate: ${nameOf(id)}`} title={`Faceplate: ${nameOf(id)}`}
      style:left={`${at.hit.x}px`} style:top={`${at.hit.y}px`} style:--glyph-x={`${at.glyph.x - at.hit.x}px`} style:--glyph-y={`${at.glyph.y - at.hit.y}px`}
      onclick={() => openFaceplate(id)} {...hover(id)} {...focus(id)}>
      <span class="glyph"><obi-search usecsscolor></obi-search></span>
    </button>
  {/if}
{/snippet}

<div class="flow">
  <div class="fit" style:width={`${drawing.width * scale}px`} style:height={`${drawing.height * scale}px`}>
  <div class="drawing" style:width={`${drawing.width}px`} style:height={`${drawing.height}px`} style:transform={scale < 1 ? `scale(${scale})` : undefined} style:--magnifier-glyph={`${MAGNIFIER.glyph}px`} style:--magnifier-hit={`${MAGNIFIER.hit}px`} role="group" aria-label="Flow topology">
    <canvas use:lines={{ segments: drawing.segments, width: drawing.width, height: drawing.height, palette, zoom }}></canvas>
    {#each drawing.buses as bus (bus.id)}
      <obc-bus class="placed" size="small" vertical={bus.vertical} label="" title={bus.title} style:left={`${bus.x}px`} style:top={`${bus.y}px`} style:width={`${bus.width}px`} style:height={`${bus.height}px`}></obc-bus>
    {/each}
    {#each drawing.vessels as item (item.id)}
      <div class="placed box" class:hovered={hovered === item.id} class:activated={popover.kind === 'open' && popover.item === item.id} role="button" tabindex="0" aria-label={`Open ${item.title}`} title={item.title} use:button={item.id} style:left={`${item.x}px`} style:top={`${item.y}px`} style:width={`${item.width}px`} style:height={`${item.height}px`}
        onclick={() => void openDetail(item.id)} onkeydown={bodyKey(item.id)} {...hover(item.id)} {...focus(item.id)}>
        {#if item.kind === 'tank'}
          <obc-automation-tank type="generic" orientation="vertical" positioning="button" compact medium="normal" max={100} value={item.level ?? 0} static={item.unknown || item.level === null} showTrendSymbol={false} clickable={false} tag="" alert={item.tone !== null} alertFrameStatus={item.tone === null ? 'caution' : ALERT_TYPE[item.tone]} alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false} style:width="100%" style:height="100%"><span slot="readout"></span></obc-automation-tank>
        {:else if item.kind === 'exchanger'}
          <obc-heat-exchanger positioning="button" medium="graphic" static={item.unknown} clickable={false} showIcon tag="" alert={item.tone !== null} alertFrameStatus={item.tone === null ? 'caution' : ALERT_TYPE[item.tone]} alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false} style:width="100%" style:height="100%"></obc-heat-exchanger>
        {:else if item.drawing !== undefined}
          <Vessel id={item.id} width={item.width} height={item.height} origin={{ x: item.x, y: item.y }} drawing={item.drawing} level={item.level} parts={item.parts ?? []} />
        {/if}
      </div>
      {@render magnifier(item.id)}
    {/each}
    {#each drawing.devices as device (device.id)}
      <div class="placed device" role="button" tabindex="0" aria-label={`Open ${device.title}`} title={device.title} use:button={device.id} style:left={`${device.x - SYMBOL_PX / 2}px`} style:top={`${device.y - SYMBOL_PX / 2}px`}
        onclick={() => void openDetail(device.id)} onkeydown={bodyKey(device.id)} {...hover(device.id)} {...focus(device.id)}>
        <div class="point"><obc-automation-button variant="regular" positioning="point" showReadoutStack={false} state={device.on ? 'open' : 'closed'} static={device.unknown} orientation={device.orientation} activated={popover.kind === 'open' && popover.item === device.id} progress={false} hasBadgeSpacer={false} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false}>
          {#if device.glyph?.tag === 'obc-valve-analog-two-way-icon'}
            <obc-valve-analog-two-way-icon slot="icon" value={device.glyph.value} closed={device.glyph.value === 0} vertical={device.vertical}></obc-valve-analog-two-way-icon>
          {:else if device.glyph !== null}
            <svelte:element this={device.glyph.tag} slot="icon" usecsscolor></svelte:element>
          {/if}
        </obc-automation-button></div>
      </div>
      {@render magnifier(device.id)}
    {/each}
    {#each drawing.texts as text (text.id)}
      <!-- An item's text is part of its body: a press on it opens the item's detail, as a press on its symbol does. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class={`text ${text.tone ?? ''}`} class:body={items.has(text.id)} data-item={text.id} use:textBlock={text.id} style:left={`${text.x}px`} style:top={`${text.y}px`} style:width={`${text.width}px`} style:--line={`${FLOW_LINE_PX}px`} title={text.title}
        onclick={items.has(text.id) ? () => void openDetail(text.id) : undefined} {...(items.has(text.id) ? hover(text.id) : {})}>
        {#each text.lines as line, at (at)}<span class={line.kind}>{line.text}</span>{/each}
      </div>
    {/each}
  </div>
  </div>
  {#if notice !== null}<p class="notice" role="status">{notice}</p>{/if}
  <!-- Outside the drawing: a scaled drawing's transform would otherwise hold the faceplate's fixed place. -->
  {#if open !== undefined && buttons.get(open.id) !== undefined}
    <ElementPopover {runId} {from} objectId={section.objectId} packId={section.packId} elementId={open.element} name={nameOf(open.id)} anchor={buttons.get(open.id)!} text={textBlocks.get(open.id) ?? null} {zoom} {palette} onclose={close} />
  {/if}
</div>
{#if section.attribution !== undefined}<p class="attribution">{section.attribution}</p>{/if}

<style>
  .flow { overflow-x: auto; overflow-y: hidden; }
  .drawing { position: relative; transform-origin: 0 0; }
  canvas { position: absolute; left: 0; top: 0; }
  .placed { position: absolute; }
  /* A device's button is its symbol's two cells, so a press, a pointer and the focus ring find it; the symbol stands at its centre. */
  .device { width: calc(2 * var(--row)); height: calc(2 * var(--row)); }
  /* OpenBridge's point positioning centres the symbol on its host's origin: the host stands at the box's centre. */
  .point { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
  .box { display: block; border-radius: 4px; }
  [role='button'] { cursor: pointer; }
  [role='button']:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 2px; }
  /* A vessel takes OpenBridge's flat hover and activated surfaces, as its button would: it is pressed for its detail, opened for its faceplate. */
  .box:hover, .box.hovered { background: var(--flat-hover-background-color); }
  .box.activated { background: var(--flat-activated-background-color); outline: 1px solid var(--border-outline-color); }
  /* A line may run a few pixels past the width the sizing reserved (8 px a character; capitals are wider): the layout keeps text clear of other items by more. */
  .text { position: absolute; display: flex; flex-direction: column; font-size: 12px; line-height: var(--line); white-space: nowrap; pointer-events: none; }
  /* The body's ink (its symbol and its text lines, each as wide as written) stands above the magnifier's hit area:
     a press on the item opens its detail, a press on the room round the glyph its faceplate. */
  .device, .box { z-index: 2; }
  .text.body { z-index: 2; align-items: flex-start; }
  .text.body span { pointer-events: auto; cursor: pointer; }
  .text span { color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .text .name, .text .word { color: var(--element-active-color); }
  .text .word { font-weight: 600; }
  /* A command the item does not follow: bold, as today's display writes its CMD word. */
  .text .command { color: var(--element-active-color); font-weight: 700; }
  .text.caution .name, .text.warning .name, .text.alarm .name, .text.critical .name { font-weight: 700; text-decoration: underline 2px; text-underline-offset: 2px; }
  .text.caution .name { text-decoration-color: var(--display-caution-mark); }
  .text.warning .name { text-decoration-color: var(--display-warning-mark); }
  .text.alarm .name { text-decoration-color: var(--display-alarm-mark); }
  .text.critical .name { text-decoration-color: var(--display-critical-mark); }
  /* The magnifier: a transparent 40 px square, only its 16 px glyph drawn; seen on hover and focus, always on touch. */
  .magnifier { position: absolute; z-index: 1; width: var(--magnifier-hit); height: var(--magnifier-hit); padding: 0; border: none; background: none; cursor: pointer; opacity: 0; color: var(--element-neutral-color); }
  .magnifier .glyph { position: absolute; left: var(--glyph-x); top: var(--glyph-y); display: block; width: var(--magnifier-glyph); height: var(--magnifier-glyph); border-radius: 3px; }
  .magnifier obi-search { display: block; width: var(--magnifier-glyph); height: var(--magnifier-glyph); }
  .magnifier.shown, .magnifier:focus-visible { opacity: 1; }
  .magnifier:hover .glyph { background: var(--flat-hover-background-color); color: var(--element-active-color); }
  .magnifier:focus-visible { outline: none; }
  .magnifier:focus-visible .glyph { outline: 2px solid var(--border-focus-color); }
  @media (pointer: coarse) { .magnifier { opacity: 1; } }
  .notice { margin: 0; font-size: 12px; color: var(--element-active-color); }
  .attribution { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
