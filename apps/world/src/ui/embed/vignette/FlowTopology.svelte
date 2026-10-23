<script lang="ts">
  import type { Segment } from '@oicl/connector-diagram'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import type { Observation } from '../../../core/observation/model.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteSection } from '../../../features/displays/compose/model.ts'
  import type { Palette } from '../../displays/severity.ts'
  import type { PackElementMarks } from '../../../core/packs/protocol.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { loadEmbedPack } from '../pack-embed-loader.ts'
  import { embeddedDisplayFrame, UNFRAMED_PRESENTATION, visibleRoom, type DisplayOpening, type DisplayPresentation } from '../view-host.ts'
  import Faceplate from './Faceplate.svelte'
  import { faceplateStates, readingsOf, type FaceplateReadings } from './faceplate.ts'
  import { FLOW_LINE_PX, flowDrawing } from './flow-symbols.ts'
  import { drawingScale } from './network.ts'
  import { paintLines } from './lines.ts'
  import { magnifierAt, MAGNIFIER } from './magnifier.ts'
  import {
    FACEPLATE_CLOSED, FACEPLATE_WIDTH, faceplatePlacement, keptInRoom, movedOverlay, nextFaceplate, openElementDetail, raisedOverlay, readPins, replacedOverlays, resizedOverlay, togglePinned, writePins,
    type Box, type FaceplateState, type OpenedFrom, type OverlayChange, type PinnedOverlay,
  } from './popover.ts'
  import type { AlertTone } from './readout.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { onElementRequest } from './selection.ts'
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
  // on touch and on items the Pack offers controls on or a proposal waits on,
  // it is its own tab stop straight after its item, and Shift+Enter on the
  // item does the same. An item a proposal waits on carries OpenBridge's
  // command request badge, and a display the window opened after another pins
  // the faceplate of the one that lapses first, once each time it is shown
  // (W3.6). One faceplate opens at a time; pinned ones
  // stay, by the item they were opened on, for the browser session
  // (popover.ts readPins). One sample a second reads every faceplate's
  // readings (faceplate.ts).
  let { section, observations, alerts, palette, frozen, runId, from, fit = 1 }: {
    section: Extract<VignetteSection, { kind: 'topology' }>
    observations: ReadonlyArray<Observation>
    alerts: ReadonlyArray<AlertRow>
    palette: Palette
    /** The sample is frozen: everything reads as unknown, and the faceplates' controls are disabled. */
    frozen: boolean
    runId: SimulationRunId
    /** The display this drawing stands in: an element's detail opened from it names it, and Back returns here. */
    from: OpenedFrom
    /** Scaled further to its frame's width (Sections.svelte, grid.ts frameLayout). */
    fit?: number
  } = $props()

  const drawing = $derived(flowDrawing(section, observations, alerts, frozen))
  const scale = $derived(drawingScale(section) * fit)
  let presentation = $state.raw<DisplayPresentation>(UNFRAMED_PRESENTATION)
  let opening = $state<DisplayOpening | null>(null)
  let viewport = $state.raw({ width: window.innerWidth, height: window.innerHeight })
  const zoom = $derived(presentation.zoom)
  /** Where a faceplate may stand: the part of the frame the window shows, else the page. */
  const room = $derived(visibleRoom(presentation, viewport))

  /** How often the drawing asks its Pack what waits on its items. */
  const MARKS_EVERY_MS = 2_000
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

  /** Every named item as the drawing describes it (contract 3): what a press on it opens, the box it covers. */
  const texts = $derived(new Map(drawing.texts.map(text => [text.id, text])))
  /** The items drawn with a symbol of their own (a device, a tank, an exchanger, the vessel). */
  const symbols = $derived(new Set([...drawing.devices, ...drawing.vessels].map(item => item.id)))
  /** Whether an item opens anything: a refused default (no targets) stays a plain item, never a button. */
  const opens = (id: string): boolean => (texts.get(id)?.targets.length ?? 0) > 0
  const nameOf = (id: string): string => texts.get(id)?.lines[0]?.text ?? texts.get(id)?.title ?? id
  /** What a press on an item opens: its element, a group's members, a stop's far ends, each by element and name. */
  const membersOf = (id: string): ReadonlyArray<{ readonly element: string; readonly name: string }> =>
    (texts.get(id)?.targets ?? []).map(target => ({ element: target.element, name: target.label }))

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
  const elementOf = (key: string): string => key.startsWith('#') ? key.slice(1) : texts.get(key)?.targets[0]?.element ?? key
  const pinned = (key: string): boolean => overlays.some(overlay => overlay.item === key)
  const groupKey = (key: string): boolean => !key.startsWith('#') && texts.get(key)?.kind === 'group'
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
  /** This drawing's own reason to ask the window for the body's whole height: its standing faceplates. */
  const fillReason = `faceplates:${Math.random().toString(36).slice(2)}`
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
    embeddedDisplayFrame().reportFill(fillReason, faceplate.kind === 'open' || overlays.length > 0)
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
  // A card's height changed (its readings came, a proposal opened): a pinned one that now reaches past the room moves back inside it.
  const grown = (key: string, overlay: PinnedOverlay | null, height: number): void => {
    if (heights[key] === height) return
    heights = { ...heights, [key]: height }
    if (overlay !== null) show({ overlays: overlays.map(entry => (entry.item === key ? keptInRoom(entry, height, room, zoom) : entry)) })
  }
  // The room narrowed or moved (the window resized, the chat opened, the body scrolled): an overlay no longer wholly in
  // it goes beside its item again, pushed inside only where its item is not drawn.
  const roomChanged = (): void => {
    show({ overlays: replacedOverlays(overlays, overlay => ({ item: overlay.item.startsWith('#') ? null : itemBox(overlay.item), height: heights[overlay.item] ?? 160 }), room, zoom) })
  }

  // --- L3: the detail, the element's World default after this display -------------------------------------------------
  const openDetail = async (element: string, item: string | null): Promise<void> => {
    // A chat answer or a tag's dialog has no window to walk in: there the body opens the faceplate too.
    if (opening !== 'window') { openFaceplate(item ?? `#${element}`); return }
    try {
      if (!(await openElementDetail(embeddedDisplayFrame(), runId, from, section.objectId, element)) && item !== null) openFaceplate(item)
      notice = null
    } catch (error) {
      notice = `${element} cannot be opened: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  /** A press on an item's body: its one target's detail, or a chooser where it names several (a group, a stop). */
  const bodyPress = (id: string): void => {
    const targets = texts.get(id)?.targets ?? []
    if (targets.length === 1 && texts.get(id)?.kind === 'stop') {
      elementNames = { ...elementNames, [`#${targets[0]!.element}`]: targets[0]!.label }
      void openDetail(targets[0]!.element, null)
    } else if (targets.length === 1) void openDetail(targets[0]!.element, id)
    else if (targets.length > 1) openChooser(id)
  }
  const bodyKey = (id: string) => (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); if (texts.get(id)?.kind !== 'stop') openFaceplate(id); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    bodyPress(id)
  }

  /** What makes an item's body a button: only an item that opens something; a refused default stays plain. */
  const body = (id: string, title: string): Record<string, unknown> => !opens(id) ? {} : {
    role: 'button', tabindex: 0, 'aria-label': `Open ${title}`, 'aria-haspopup': membersOf(id).length > 1 ? 'dialog' : undefined,
    onclick: () => bodyPress(id), onkeydown: bodyKey(id), ...hover(id), ...focus(id),
  }

  // --- The chooser: a press on an item that names several things to open ---------------------------------------------
  const CHOOSER_WIDTH = 260
  let chooser = $state.raw<{ readonly id: string; readonly box: Box } | null>(null)
  const openChooser = (id: string): void => {
    const box = itemBox(id)
    chooser = box === null ? null : { id, box }
  }
  const closeChooser = (returnFocus: boolean): void => {
    const was = chooser
    chooser = null
    if (returnFocus && was !== null) buttons.get(was.id)?.focus()
  }
  /** One of them chosen: its detail in the window; elsewhere its faceplate where the list stood. */
  const choose = (entry: { readonly element: string; readonly name: string }): void => {
    const was = chooser
    chooser = null
    if (opening === 'window') { void openDetail(entry.element, null); return }
    elementNames = { ...elementNames, [`#${entry.element}`]: entry.name }
    openFaceplate(`#${entry.element}`, was === null ? null : { x: was.box.x, y: was.box.y })
  }
  /** The list takes focus as it opens, on its first entry. */
  const chooserEntry = (node: HTMLElement, element: string) => {
    if (chooser !== null && membersOf(chooser.id)[0]?.element === element) requestAnimationFrame(() => node.focus())
    return {}
  }

  // --- What the Pack marks on the items: offered controls, pending proposals (W3.6) ------------------------------------
  let marks = $state.raw<PackElementMarks>({ operated: [], pending: [] })
  const operated = $derived(new Set(marks.operated))
  const pendingBy = $derived(new Map(marks.pending.map(entry => [entry.element, entry])))
  /** The elements an item stands for: a group's members, else its own. */
  const elementsOf = (key: string): ReadonlyArray<string> => key.startsWith('#') ? [key.slice(1)] : membersOf(key).map(member => member.element)
  const pendingOf = (key: string): { readonly ai: boolean } | undefined => elementsOf(key).map(element => pendingBy.get(element)).find(entry => entry !== undefined)
  /** The drawn item that stands for an element: its own, or the group it is a member of. */
  const itemOf = (element: string): string | undefined => {
    const drawn = drawing.texts.filter(text => text.kind !== 'stop' && text.targets.some(target => target.element === element))
    return (drawn.find(text => text.kind === 'item') ?? drawn[0])?.id
  }
  // A display the window opened after another (an item's detail, a proposal to review) pins the faceplate of the
  // pending proposal it draws that lapses first, once each time it is shown, never over the person's own pins.
  let showing = 0
  let reviewed = -1
  const review = (): void => {
    if (presentation.back === undefined || reviewed === showing) return
    reviewed = showing
    const id = marks.pending.map(entry => itemOf(entry.element)).find(found => found !== undefined)
    const box = id === undefined ? null : itemBox(id)
    if (id === undefined || box === null || pinned(id)) return
    const place = faceplatePlacement(box, { width: FACEPLATE_WIDTH, height: heights[id] ?? 300 }, room, zoom, overlays.map(entry => ({ x: entry.x, y: entry.y, width: entry.width / zoom, height: (heights[entry.item] ?? 160) / zoom })))
    show({ overlays: togglePinned(overlays, { item: id, ...place, width: FACEPLATE_WIDTH, rows: null }), ...(faceplate.kind === 'open' && faceplate.item === id ? { faceplate: FACEPLATE_CLOSED } : {}) })
  }
  let markReader: ((runId: SimulationRunId, objectId: never) => Promise<PackElementMarks>) | null | undefined
  let marking = false
  /** Why the last read of the marks failed, until one succeeds. */
  let marksFailure = $state<string | null>(null)
  const readMarks = async (): Promise<void> => {
    if (marking || opening !== 'window' || !presentation.shown) return
    marking = true
    try {
      markReader ??= (await (await loadEmbedPack(section.packId))?.elementMarks?.())?.read as typeof markReader ?? null
      if (markReader === null || markReader === undefined) return
      marks = await markReader(runId, section.objectId as never)
      marksFailure = null
      review()
    } catch (error) {
      marksFailure = `What waits on this display cannot be read: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      marking = false
    }
  }
  /** Shows an element's item: its faceplate open beside it (raised where pinned), the item scrolled into view. */
  const selectItem = (id: string): void => {
    buttons.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (pinned(id)) show({ overlays: raisedOverlay(overlays, id) })
    else if (!(faceplate.kind === 'open' && faceplate.item === id)) openFaceplate(id)
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
    // No magnifier on a stop: it names other equipment, whose faceplates stand on the displays it opens.
    return width === undefined || !opens(text.id) || text.kind === 'stop' ? [] : [[text.id, magnifierAt(text, FLOW_LINE_PX, width, drawing)] as const]
  })))
  let hovered = $state<string | null>(null)
  let focused = $state<string | null>(null)
  const activated = (id: string): boolean => (faceplate.kind === 'open' && faceplate.item === id) || pinned(id)
  const shown = (id: string): boolean => hovered === id || focused === id || activated(id) || elementsOf(id).some(element => operated.has(element)) || pendingOf(id) !== undefined
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
        if (next.shown && !presentation.shown) showing += 1
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
      if (!(event.target instanceof Element)) return
      if (chooser !== null && event.target.closest('[data-chooser]') === null && buttons.get(chooser.id)?.contains(event.target) !== true && textBlocks.get(chooser.id)?.contains(event.target) !== true) closeChooser(false)
      if (faceplate.kind !== 'open') return
      if (event.target.closest('[data-faceplate], [data-magnifier]') !== null) return
      const item = faceplate.item
      if (buttons.get(item)?.contains(event.target) === true || textBlocks.get(item)?.contains(event.target) === true) return
      show({ faceplate: FACEPLATE_CLOSED })
    }
    const blurred = (): void => {
      chooser = null
      if (faceplate.kind === 'open') show({ faceplate: FACEPLATE_CLOSED })
    }
    // Esc closes the chooser first, before a faceplate or Back.
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || chooser === null) return
      event.preventDefault()
      event.stopPropagation()
      closeChooser(true)
    }
    window.addEventListener('keydown', escape, { capture: true })
    // What waits on the items, read every MARKS_EVERY_MS while the window shows the display.
    void readMarks()
    const marking = setInterval(() => { void readMarks() }, MARKS_EVERY_MS)
    // An alert row, a chip or a tile asks to show an element this drawing draws (selection.ts).
    const stopRequests = onElementRequest(request => {
      if (request.objectId !== section.objectId) return false
      const id = itemOf(request.elementId)
      if (id === undefined) return false
      if (request.how === 'detail') void openDetail(request.elementId, id)
      else selectItem(id)
      return true
    })
    const resized = (): void => { viewport = { width: window.innerWidth, height: window.innerHeight }; roomChanged() }
    document.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('blur', blurred)
    window.addEventListener('resize', resized)
    return () => {
      for (const stop of stops) stop()
      stopRequests()
      clearInterval(marking)
      for (const session of sessions) session.close()
      document.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('blur', blurred)
      window.removeEventListener('keydown', escape, { capture: true })
      window.removeEventListener('resize', resized)
      host.reportFill(fillReason, false)
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

{#snippet waiting(pending: { readonly ai: boolean })}
  <!-- A proposal waits on it: OpenBridge's command request glyph, an AI's pending glyph where an AI agent proposed it. -->
  {#if pending.ai}<obi-ai-pending usecsscolor></obi-ai-pending>{:else}<obi-command-request usecsscolor></obi-command-request>{/if}
{/snippet}

{#snippet card(key: string, overlay: PinnedOverlay | null)}
  {@const element = elementOf(key)}
  {@const group = groupKey(key)}
  <Faceplate {runId} objectId={section.objectId} packId={section.packId} elementId={element} name={faceplateName(key)} word={wordOf(key)} title={from.title}
    readings={group ? null : readings.get(element) ?? null} {alerts} alertElements={group ? membersOf(key).map(member => member.element) : [element]} {group} related={relatedOf(key)}
    anchor={overlay === null ? (key.startsWith('#') ? null : anchor) : null} at={overlay === null ? openedAt : null} avoid={overlay === null ? overlays.map(entry => ({ x: entry.x, y: entry.y, width: entry.width / zoom, height: (heights[entry.item] ?? 160) / zoom })) : []} {zoom} {room} {frozen} {opening} pending={pendingOf(key) !== undefined} pinned={overlay}
    onclose={closeFaceplate} onpin={place => pin(key, place)} onoverlay={(change, height) => changeOverlay(key, change, height)} ontouched={() => { if (overlay !== null) show({ overlays: raisedOverlay(overlays, key) }) }}
    onsize={height => grown(key, overlay, height)}
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
      <div class="placed box" class:hovered={hovered === item.id} class:activated={activated(item.id)} title={item.title} use:button={item.id} style:left={`${item.x}px`} style:top={`${item.y}px`} style:width={`${item.width}px`} style:height={`${item.height}px`}
        {...body(item.id, item.title)}>
        {#if item.kind === 'tank'}
          <obc-automation-tank type="generic" orientation="vertical" positioning="button" compact medium="normal" max={100} value={item.level ?? 0} static={item.unknown || item.level === null} showTrendSymbol={false} clickable={false} tag="" alert={item.tone !== null} alertFrameStatus={item.tone === null ? 'caution' : ALERT_TYPE[item.tone]} alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false} style:width="100%" style:height="100%"><span slot="readout"></span>{#if pendingOf(item.id) !== undefined}<obc-automation-badge slot="badges" mode="enhanced" title="A proposal waits on it">{@render waiting(pendingOf(item.id)!)}</obc-automation-badge>{/if}</obc-automation-tank>
        {:else if item.kind === 'exchanger'}
          <obc-heat-exchanger positioning="button" medium="graphic" static={item.unknown} clickable={false} showIcon tag="" alert={item.tone !== null} alertFrameStatus={item.tone === null ? 'caution' : ALERT_TYPE[item.tone]} alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false} style:width="100%" style:height="100%">{#if pendingOf(item.id) !== undefined}<obc-automation-badge slot="badges" mode="enhanced" title="A proposal waits on it">{@render waiting(pendingOf(item.id)!)}</obc-automation-badge>{/if}</obc-heat-exchanger>
        {:else if item.drawing !== undefined}
          <Vessel id={item.id} width={item.width} height={item.height} origin={{ x: item.x, y: item.y }} drawing={item.drawing} level={item.level} parts={item.parts ?? []} />
        {/if}
      </div>
      {@render magnifier(item.id)}
    {/each}
    {#each drawing.devices as device (device.id)}
      <div class="placed device" title={device.title} use:button={device.id} style:left={`${device.x - SYMBOL_PX / 2}px`} style:top={`${device.y - SYMBOL_PX / 2}px`}
        {...body(device.id, device.title)}>
        <div class="point"><obc-automation-button variant="regular" positioning="point" showReadoutStack={false} state={device.on ? 'open' : 'closed'} static={device.unknown} orientation={device.orientation} activated={activated(device.id)} progress={false} hasBadgeSpacer={false} alert={device.tone !== null} alertFrameStatus={device.tone === null ? 'caution' : ALERT_TYPE[device.tone]} alertFrameMode="acked-active" alertFrameThickness="small" alertFrameType="regular" showAlertCategoryIcon={false} showAlertIcon={false}>
          {#if device.glyph?.tag === 'obc-valve-analog-two-way-icon'}
            <obc-valve-analog-two-way-icon slot="icon" value={device.glyph.value} closed={device.glyph.value === 0} vertical={device.vertical}></obc-valve-analog-two-way-icon>
          {:else if device.glyph !== null}
            <svelte:element this={device.glyph.tag} slot="icon" usecsscolor></svelte:element>
          {/if}
          {#if pendingOf(device.id) !== undefined}<obc-automation-badge slot="badge-top-right" mode="enhanced" title="A proposal waits on it">{@render waiting(pendingOf(device.id)!)}</obc-automation-badge>{/if}
        </obc-automation-button></div>
      </div>
      {@render magnifier(device.id)}
    {/each}
    {#each drawing.texts as text (text.id)}
      {#if opens(text.id) && !symbols.has(text.id)}
        <!-- A named item drawn as a line, a bar or a stop (a header, a bus, a junction, a stop's far ends): its box and
             its text are its button, under the symbols drawn on it. -->
        <div class="placed area" class:hovered={hovered === text.id} class:activated={activated(text.id)} title={text.title} use:button={text.id}
          style:left={`${text.area.x}px`} style:top={`${text.area.y}px`} style:width={`${text.area.width}px`} style:height={`${text.area.height}px`} {...body(text.id, text.title)}></div>
        {@render magnifier(text.id)}
      {/if}
      <!-- An item's text is part of its body: a press on it opens the item's detail, as a press on its symbol does. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class={`text ${text.tone ?? ''}`} class:body={opens(text.id)} data-item={text.id} use:textBlock={text.id} use:nameWidth={{ id: text.id, name: text.lines[0]?.text ?? '', scale }} style:left={`${text.x}px`} style:top={`${text.y}px`} style:width={`${text.width}px`} style:--line={`${FLOW_LINE_PX}px`} title={text.title}
        onclick={opens(text.id) ? () => bodyPress(text.id) : undefined} {...(opens(text.id) ? hover(text.id) : {})}>
        {#each text.lines as line, at (at)}<span class={line.kind}>{line.text}</span>{/each}
      </div>
      {#if text.outline !== null}<div class={`outline ${text.outline}`} aria-hidden="true" style:left={`${text.area.x - 2}px`} style:top={`${text.area.y - 2}px`} style:width={`${text.area.width + 4}px`} style:height={`${text.area.height + 4}px`}></div>{/if}
    {/each}
  </div>
  </div>
  {#if notice !== null}<p class="notice" role="status">{notice}</p>{/if}
  {#if marksFailure !== null}<p class="notice" role="status">{marksFailure}</p>{/if}
  <!-- Outside the drawing: a scaled drawing's transform would otherwise hold the faceplates' fixed places. -->
  {#each overlays as overlay (overlay.item)}{@render card(overlay.item, overlay)}{/each}
  {#if faceplate.kind === 'open' && !pinned(faceplate.item)}
    {#key faceplate.item}{@render card(faceplate.item, null)}{/key}
  {/if}
  {#if chooser !== null}
    {@const entries = membersOf(chooser.id)}
    {@const place = faceplatePlacement(chooser.box, { width: CHOOSER_WIDTH, height: entries.length * 40 + 12 }, room, zoom)}
    <!-- Several things a press could open (a group's members, a stop's far ends): a short list, each opening its detail. -->
    <div class="chooser" data-chooser={chooser.id} role="dialog" aria-label={`${nameOf(chooser.id)}: open which`} style:left={`${place.x}px`} style:top={`${place.y}px`} style:width={`${CHOOSER_WIDTH}px`} style:transform={`scale(${1 / zoom})`}>
      <obc-card showTitle={false}>
        <ul>
          {#each entries as entry (entry.element)}
            <li><button type="button" use:chooserEntry={entry.element} onclick={() => choose(entry)}>{entry.name} ›</button></li>
          {/each}
        </ul>
      </obc-card>
    </div>
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
  .box:hover, .box.hovered, .area:hover, .area.hovered { background: var(--flat-hover-background-color); }
  .box.activated, .area.activated { background: var(--flat-activated-background-color); outline: 1px solid var(--border-outline-color); }
  /* A line's, a bar's or a stop's button lies under the symbols drawn on it, which keep their own presses. */
  .area { z-index: 1; border-radius: 4px; }
  .chooser { position: fixed; z-index: 11; transform-origin: 0 0; box-shadow: var(--shadow-floating); border-radius: var(--ui-components-card-border-radius-regular, 8px); }
  .chooser ul { width: 100%; margin: 0; padding: 6px 0; list-style: none; }
  .chooser button { display: block; width: 100%; height: 40px; padding: 0 12px; border: none; background: none; font: inherit; font-size: 13px; text-align: left; color: var(--element-active-color); cursor: pointer; }
  .chooser button:hover { background: var(--flat-hover-background-color); }
  .chooser button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
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
  /* An item not following a command: outlined just outside its symbol and text in OpenBridge's enhanced neutral, never an alarm's colour; dashed and neutral where its alerts are all expected after a first-out. */
  .outline { position: absolute; box-sizing: border-box; border: 2px solid var(--element-neutral-enhanced-color); border-radius: 4px; pointer-events: none; }
  .outline.expected { border-style: dashed; border-color: var(--element-neutral-color); }
  /* Frozen: where an alert stood, OpenBridge's low-integrity border in place of its frame (W8.1). */
  .outline.low-integrity { border-color: var(--alert-low-integrity-border-color); }
  .attribution { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
