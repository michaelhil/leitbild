<script lang="ts">
  import type { Segment } from '@oicl/connector-diagram'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import type { Observation } from '../../../core/observation/model.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, UNFRAMED_PRESENTATION, visibleRoom, type DisplayOpening, type DisplayPresentation } from '../view-host.ts'
  import Faceplate from './Faceplate.svelte'
  import { faceplateStates, readingsOf, type FaceplateReadings } from './faceplate.ts'
  import { FLOW_LINE_PX, flowDrawing } from './flow-symbols.ts'
  import { drawingScale } from './network.ts'
  import { paintLines } from './lines.ts'
  import { magnifierAt, MAGNIFIER } from './magnifier.ts'
  import {
    FACEPLATE_CLOSED, FACEPLATE_WIDTH, movedOverlay, nextFaceplate, openElementDetail, raisedOverlay, readPins, replacedOverlays, resizedOverlay, togglePinned, writePins,
    type Box, type FaceplateState, type OpenedFrom, type OverlayChange, type PinnedOverlay,
  } from './popover.ts'
  import type { AlertTone } from './readout.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { createVignetteSession, vignetteRoutes, type VignetteSession } from './vignette-client.ts'
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
  // faceplate (L2, Faceplate.svelte): it shows on hover and focus and always
  // on touch, it is its own tab stop straight after its item, and Shift+Enter
  // on the item does the same. One faceplate opens at a time; pinned ones
  // stay, by the item they were opened on, for the browser session
  // (popover.ts readPins). One sample a second reads every faceplate's
  // readings (faceplate.ts).
  let { section, observations, alerts, palette, frozen, runId, from }: {
    section: Extract<VignetteSection, { kind: 'topology' }>
    observations: ReadonlyArray<Observation>
    alerts: ReadonlyArray<AlertRow>
    palette: Palette
    /** The sample is frozen: everything reads as unknown, and the faceplates' controls are disabled. */
    frozen: boolean
    runId: SimulationRunId
    /** The display this drawing stands in: an element's detail opened from it names it, and Back returns here. */
    from: OpenedFrom
  } = $props()

  const drawing = $derived(flowDrawing(section, observations, alerts, frozen))
  const scale = $derived(drawingScale(section))
  let presentation = $state.raw<DisplayPresentation>(UNFRAMED_PRESENTATION)
  let opening = $state<DisplayOpening | null>(null)
  let viewport = $state.raw({ width: window.innerWidth, height: window.innerHeight })
  const zoom = $derived(presentation.zoom)
  /** Where a faceplate may stand: the part of the frame the window shows, else the page. */
  const room = $derived(visibleRoom(presentation, viewport))

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
  const nodes = $derived(new Map(section.nodes.map(node => [node.id, node])))
  /** A drawn group's members (alike items drawn as one symbol), each by its element and name; one for a lone item. */
  const membersOf = (id: string): ReadonlyArray<{ readonly element: string; readonly name: string }> =>
    (section.layout.nodes.find(node => node.id === id)?.members ?? [id]).flatMap(member => {
      const node = nodes.get(member)
      return node === undefined ? [] : [{ element: node.element ?? node.id, name: node.shortLabel ?? node.label }]
    })

  // Each item's button and text block as drawn: focus returns there, a faceplate stands beside them, the magnifier measures the name.
  const buttons = new Map<string, HTMLElement>()
  const textBlocks = new Map<string, HTMLElement>()
  const kept = (store: Map<string, HTMLElement>) => (node: HTMLElement, id: string) => {
    store.set(id, node)
    return { destroy: () => { if (store.get(id) === node) store.delete(id) } }
  }
  const button = kept(buttons)
  const textBlock = kept(textBlocks)
  /** An item's symbol and text as the page shows them, in page px; null where it is not drawn. */
  const itemBox = (id: string): Box | null => {
    const rects = [buttons.get(id), textBlocks.get(id)].flatMap(element => element === undefined ? [] : [element.getBoundingClientRect()])
    if (rects.length === 0) return null
    const [left, top] = [Math.min(...rects.map(rect => rect.left)), Math.min(...rects.map(rect => rect.top))]
    return { x: left, y: top, width: Math.max(...rects.map(rect => rect.right)) - left, height: Math.max(...rects.map(rect => rect.bottom)) - top }
  }

  // --- L2: the faceplate and the pinned overlays -----------------------------------------------------------------------
  // A faceplate is opened on a drawn item (its id), or on an element the drawing does not draw on its own (a device a
  // vessel bundles, a group's member: `#<element>`), which stands where the faceplate that opened it stood. Every
  // change goes through show(): it keeps the pins, the faceplates' sample and the window's room in step.
  let faceplate = $state.raw<FaceplateState>(FACEPLATE_CLOSED)
  let openedAt = $state.raw<{ readonly x: number; readonly y: number } | null>(null)
  let anchor = $state.raw<Box | null>(null)
  let overlays = $state.raw<ReadonlyArray<PinnedOverlay>>([])
  let heights = $state.raw<Readonly<Record<string, number>>>({})
  let notice = $state<string | null>(null)
  const elementOf = (key: string): string => key.startsWith('#') ? key.slice(1) : items.get(key)?.element ?? key
  const pinned = (key: string): boolean => overlays.some(overlay => overlay.item === key)
  const groupKey = (key: string): boolean => !key.startsWith('#') && membersOf(key).length > 1
  /** Where a faceplate stands as drawn, for the one it opens in its place. */
  const cardPlace = (key: string, overlay: PinnedOverlay | null): { readonly x: number; readonly y: number } => {
    if (overlay !== null) return { x: overlay.x, y: overlay.y }
    const box = document.querySelector<HTMLElement>(`[data-faceplate="${CSS.escape(elementOf(key))}"]`)?.getBoundingClientRect()
    return box === undefined ? { x: room.x, y: room.y } : { x: box.left, y: box.top }
  }

  // One sample a second for every faceplate open or pinned: their elements' readings, four to a state.
  let readings = $state.raw<ReadonlyMap<string, FaceplateReadings>>(new Map())
  let sessions: ReadonlyArray<VignetteSession> = []
  let sampled = ''
  const sample = (): void => {
    const elements = [...new Set([...(faceplate.kind === 'open' ? [faceplate.item] : []), ...overlays.map(overlay => overlay.item)].filter(key => !groupKey(key)).map(elementOf))]
    const key = elements.join('\u0000')
    if (key === sampled) return
    sampled = key
    for (const session of sessions) session.close()
    readings = new Map([...readings].filter(([element]) => elements.includes(element)))
    const at = new Date().toISOString()
    sessions = faceplateStates(section.objectId, elements, at).map(chunk => {
      const session = createVignetteSession({
        runId, state: chunk.state, routes: vignetteRoutes,
        onChange: snapshot => { readings = new Map([...readings, ...readingsOf(chunk.elements, snapshot.view, snapshot.latest)]) },
      })
      session.setVisible(presentation.shown)
      session.start()
      return session
    })
  }
  let pinsRead = false
  const show = (next: { readonly faceplate?: FaceplateState; readonly overlays?: ReadonlyArray<PinnedOverlay> }): void => {
    if (next.faceplate !== undefined) faceplate = next.faceplate
    if (next.overlays !== undefined && next.overlays !== overlays) {
      overlays = next.overlays
      if (pinsRead) {
        try { writePins(sessionStorage, from.key, overlays) } catch (error) { notice = `The pinned faceplates cannot be kept: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    sample()
    // The window gives the frame its whole body while a faceplate stands on the display (W3.4).
    embeddedDisplayFrame().reportFaceplate(faceplate.kind === 'open' || overlays.length > 0)
  }

  const openFaceplate = (key: string, at: { readonly x: number; readonly y: number } | null = null): void => {
    if (pinned(key)) { show({ overlays: raisedOverlay(overlays, key) }); return }
    anchor = key.startsWith('#') ? null : itemBox(key)
    openedAt = at
    show({ faceplate: nextFaceplate(faceplate, { kind: 'pressed', item: key }) })
  }
  const closeFaceplate = (returnFocus: boolean): void => {
    const was = faceplate
    show({ faceplate: nextFaceplate(faceplate, { kind: 'dismissed' }) })
    if (returnFocus && was.kind === 'open') buttons.get(was.item)?.focus()
  }
  const pin = (key: string, place: { readonly x: number; readonly y: number }): void => {
    const standing = overlays.find(overlay => overlay.item === key)
    if (standing !== undefined) { show({ overlays: togglePinned(overlays, standing) }); buttons.get(key)?.focus(); return }
    show({
      overlays: togglePinned(overlays, { item: key, x: place.x, y: place.y, width: FACEPLATE_WIDTH, rows: null }),
      ...(faceplate.kind === 'open' && faceplate.item === key ? { faceplate: FACEPLATE_CLOSED } : {}),
    })
  }
  // A drag or a resize runs from where the overlay stood as it began, to the pointer's travel since.
  let dragging: { readonly item: string; readonly from: PinnedOverlay } | null = null
  const changeOverlay = (key: string, change: OverlayChange, height: number): void => {
    const standing = overlays.find(overlay => overlay.item === key)
    if (standing === undefined) return
    heights = { ...heights, [key]: height }
    if (dragging?.item !== key) dragging = { item: key, from: standing }
    const start = dragging.from
    const next = change.kind === 'move'
      ? movedOverlay(start, change.travel, height, room, zoom)
      : resizedOverlay(start, { width: start.width, rows: start.rows ?? change.available }, change.travel, change.available, height, room, zoom)
    show({ overlays: overlays.map(overlay => (overlay.item === key ? next : overlay)) })
    if (change.end) dragging = null
  }
  // The room narrowed or moved (the window resized, the chat opened, the body scrolled): an overlay no longer wholly in
  // it goes beside its item again, pushed inside only where its item is not drawn.
  const roomChanged = (): void => {
    show({ overlays: replacedOverlays(overlays, overlay => ({ item: overlay.item.startsWith('#') ? null : itemBox(overlay.item), height: heights[overlay.item] ?? 160 }), room, zoom) })
  }

  // --- L3: the detail, the element's World default after this display -------------------------------------------------
  const openDetail = async (element: string, item: string | null): Promise<void> => {
    // A chat answer or a tag's dialog has no window to walk in: there the body opens the faceplate too.
    if (opening !== 'window') { if (item !== null) openFaceplate(item); return }
    try {
      if (!(await openElementDetail(embeddedDisplayFrame(), runId, from, section.objectId, element)) && item !== null) openFaceplate(item)
      notice = null
    } catch (error) {
      notice = `${element} cannot be opened: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const bodyPress = (id: string): void => { void openDetail(items.get(id)?.element ?? id, id) }
  const bodyKey = (id: string) => (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); openFaceplate(id); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    bodyPress(id)
  }

  // --- The magnifier --------------------------------------------------------------------------------------------------
  /** Each item's name as drawn, in drawing px: measured once its text is laid out and again whenever its name changes. */
  let named = $state.raw<Readonly<Record<string, number>>>({})
  const nameWidth = (node: HTMLElement, params: { readonly id: string; readonly name: string; readonly scale: number }) => {
    let frame = 0
    let last = ''
    const measure = (next: typeof params): void => {
      if (`${next.name}\u0000${next.scale}` === last) return
      last = `${next.name}\u0000${next.scale}`
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const first = node.firstElementChild
        if (first === null) return
        const range = document.createRange()
        range.selectNodeContents(first)
        const width = range.getBoundingClientRect().width / next.scale
        if (named[next.id] !== width) named = { ...named, [next.id]: width }
      })
    }
    measure(params)
    return { update: measure, destroy: () => cancelAnimationFrame(frame) }
  }
  const magnifiers = $derived(new Map(drawing.texts.flatMap(text => {
    const width = named[text.id]
    return width === undefined || !items.has(text.id) ? [] : [[text.id, magnifierAt(text, FLOW_LINE_PX, width, drawing)] as const]
  })))
  let hovered = $state<string | null>(null)
  let focused = $state<string | null>(null)
  const activated = (id: string): boolean => (faceplate.kind === 'open' && faceplate.item === id) || pinned(id)
  const shown = (id: string): boolean => hovered === id || focused === id || activated(id)
  const hover = (id: string) => ({ onpointerenter: () => { hovered = id }, onpointerleave: () => { if (hovered === id) hovered = null } })
  const focus = (id: string) => ({ onfocus: () => { focused = id }, onblur: () => { if (focused === id) focused = null } })

  // --- Lifecycle: the window's presentation, the close rules, the room --------------------------------------------------
  runOnMount(() => {
    const host = embeddedDisplayFrame()
    try { show({ overlays: readPins(sessionStorage, from.key) }) } catch (error) { notice = error instanceof Error ? error.message : String(error) }
    pinsRead = true
    const stops = [
      host.subscribe(next => {
        const moved = !sameRoom(next, presentation)
        presentation = next
        for (const session of sessions) session.setVisible(next.shown)
        // The display put away (another one shown in the window): an open faceplate closes; pinned ones stay with it.
        if (!next.shown && faceplate.kind === 'open') show({ faceplate: FACEPLATE_CLOSED })
        if (moved) roomChanged()
      }),
      host.subscribeOpening(where => { opening = where }),
    ]
    // A press outside an open faceplate, its item and its magnifier closes it; so does focus leaving the display.
    const down = (event: PointerEvent): void => {
      if (faceplate.kind !== 'open' || !(event.target instanceof Element)) return
      if (event.target.closest('[data-faceplate], [data-magnifier]') !== null) return
      const item = faceplate.item
      if (buttons.get(item)?.contains(event.target) === true || textBlocks.get(item)?.contains(event.target) === true) return
      show({ faceplate: FACEPLATE_CLOSED })
    }
    const blurred = (): void => { if (faceplate.kind === 'open') show({ faceplate: FACEPLATE_CLOSED }) }
    const resized = (): void => { viewport = { width: window.innerWidth, height: window.innerHeight }; roomChanged() }
    document.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('blur', blurred)
    window.addEventListener('resize', resized)
    return () => {
      for (const stop of stops) stop()
      for (const session of sessions) session.close()
      document.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('blur', blurred)
      window.removeEventListener('resize', resized)
      host.reportFaceplate(false)
    }
  })
  const sameRoom = (left: DisplayPresentation, right: DisplayPresentation): boolean => {
    const [a, b] = [left.visible, right.visible]
    return left.zoom === right.zoom && (a === b || (a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height))
  }

  /** What a faceplate on `key` shows besides its readings: a group's members, else the devices its element bundles. */
  const relatedOf = (key: string) => {
    const members = key.startsWith('#') ? [] : membersOf(key)
    if (members.length > 1) return { heading: 'Members' as const, entries: members }
    const devices = readings.get(elementOf(key))?.devices ?? []
    return devices.length === 0 ? null : { heading: 'Devices' as const, entries: devices.map(device => ({ element: device.id, name: device.shortLabel ?? device.label })) }
  }
  const wordOf = (key: string): string | null => key.startsWith('#') ? null : texts.get(key)?.lines.find(line => line.kind === 'word' || line.kind === 'command')?.text ?? null
  /** The names of faceplates opened on elements the drawing does not draw on their own, as the list that opened them named them. */
  let elementNames = $state.raw<Readonly<Record<string, string>>>({})
  const faceplateName = (key: string): string => key.startsWith('#') ? elementNames[key] ?? key.slice(1) : nameOf(key)
</script>

{#snippet magnifier(id: string)}
  {@const at = magnifiers.get(id)}
  {#if at !== undefined}
    <!-- Its own tab stop straight after its item; the 40 px square is the press target, the 16 px glyph its ink. -->
    <button type="button" class="magnifier" class:shown={shown(id)} data-magnifier={id} aria-label={`Faceplate: ${nameOf(id)}`} aria-expanded={activated(id)} title={`Faceplate: ${nameOf(id)}`}
      style:left={`${at.hit.x}px`} style:top={`${at.hit.y}px`} style:--glyph-x={`${at.glyph.x - at.hit.x}px`} style:--glyph-y={`${at.glyph.y - at.hit.y}px`}
      onclick={() => openFaceplate(id)} {...hover(id)} {...focus(id)}>
      <span class="glyph"><obi-search usecsscolor></obi-search></span>
    </button>
  {/if}
{/snippet}

{#snippet card(key: string, overlay: PinnedOverlay | null)}
  {@const element = elementOf(key)}
  {@const group = groupKey(key)}
  <Faceplate {runId} objectId={section.objectId} packId={section.packId} elementId={element} name={faceplateName(key)} word={wordOf(key)} title={from.title}
    readings={group ? null : readings.get(element) ?? null} {alerts} alertElements={group ? membersOf(key).map(member => member.element) : [element]} {group} related={relatedOf(key)}
    anchor={overlay === null ? (key.startsWith('#') ? null : anchor) : null} at={overlay === null ? openedAt : null} avoid={overlay === null ? overlays.map(entry => ({ x: entry.x, y: entry.y, width: entry.width / zoom, height: (heights[entry.item] ?? 160) / zoom })) : []} {zoom} {room} {frozen} {opening} pending={false} pinned={overlay}
    onclose={closeFaceplate} onpin={place => pin(key, place)} onoverlay={(change, height) => changeOverlay(key, change, height)} ontouched={() => { if (overlay !== null) show({ overlays: raisedOverlay(overlays, key) }) }}
    onsize={height => { if (heights[key] !== height) heights = { ...heights, [key]: height } }}
    ondetail={target => { if (overlay === null) closeFaceplate(false); void openDetail(target, null) }}
    onfaceplate={(target, name) => { elementNames = { ...elementNames, [`#${target}`]: name }; openFaceplate(`#${target}`, cardPlace(key, overlay)) }} />
{/snippet}

<div class="flow">
  <div class="fit" style:width={`${drawing.width * scale}px`} style:height={`${drawing.height * scale}px`}>
  <div class="drawing" style:width={`${drawing.width}px`} style:height={`${drawing.height}px`} style:transform={scale < 1 ? `scale(${scale})` : undefined} style:--magnifier-glyph={`${MAGNIFIER.glyph}px`} style:--magnifier-hit={`${MAGNIFIER.hit}px`} role="group" aria-label="Flow topology">
    <canvas use:lines={{ segments: drawing.segments, width: drawing.width, height: drawing.height, palette, zoom }}></canvas>
    {#each drawing.buses as bus (bus.id)}
      <obc-bus class="placed" size="small" vertical={bus.vertical} label="" title={bus.title} style:left={`${bus.x}px`} style:top={`${bus.y}px`} style:width={`${bus.width}px`} style:height={`${bus.height}px`}></obc-bus>
    {/each}
    {#each drawing.vessels as item (item.id)}
      <div class="placed box" class:hovered={hovered === item.id} class:activated={activated(item.id)} role="button" tabindex="0" aria-label={`Open ${item.title}`} title={item.title} use:button={item.id} style:left={`${item.x}px`} style:top={`${item.y}px`} style:width={`${item.width}px`} style:height={`${item.height}px`}
        onclick={() => bodyPress(item.id)} onkeydown={bodyKey(item.id)} {...hover(item.id)} {...focus(item.id)}>
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
        onclick={() => bodyPress(device.id)} onkeydown={bodyKey(device.id)} {...hover(device.id)} {...focus(device.id)}>
        <div class="point"><obc-automation-button variant="regular" positioning="point" showReadoutStack={false} state={device.on ? 'open' : 'closed'} static={device.unknown} orientation={device.orientation} activated={activated(device.id)} progress={false} hasBadgeSpacer={false} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false}>
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
      <div class={`text ${text.tone ?? ''}`} class:body={items.has(text.id)} data-item={text.id} use:textBlock={text.id} use:nameWidth={{ id: text.id, name: text.lines[0]?.text ?? '', scale }} style:left={`${text.x}px`} style:top={`${text.y}px`} style:width={`${text.width}px`} style:--line={`${FLOW_LINE_PX}px`} title={text.title}
        onclick={items.has(text.id) ? () => bodyPress(text.id) : undefined} {...(items.has(text.id) ? hover(text.id) : {})}>
        {#each text.lines as line, at (at)}<span class={line.kind}>{line.text}</span>{/each}
      </div>
    {/each}
  </div>
  </div>
  {#if notice !== null}<p class="notice" role="status">{notice}</p>{/if}
  <!-- Outside the drawing: a scaled drawing's transform would otherwise hold the faceplates' fixed places. -->
  {#each overlays as overlay (overlay.item)}{@render card(overlay.item, overlay)}{/each}
  {#if faceplate.kind === 'open' && !pinned(faceplate.item)}
    {#key faceplate.item}{@render card(faceplate.item, null)}{/key}
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
