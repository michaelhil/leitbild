<script lang="ts">
  import type { Component } from 'svelte'
  import { objectIdSchema, type SimulationRunId } from '../../../core/model/index.ts'
  import type { PackElementActionsProps } from '../../../core/packs/protocol.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import { severityStyle, severityTable } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { loadEmbedPack } from '../pack-embed-loader.ts'
  import type { DisplayOpening } from '../view-host.ts'
  import AlertsSection from './AlertsSection.svelte'
  import { worstChip } from './alerts.ts'
  import { FACEPLATE_ALERTS, FACEPLATE_READINGS, faceplateRows, ownAlerts, shortOfRoom, shownReadings, type FaceplateReadings } from './faceplate.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { elementOffer, faceplateHeight, faceplatePlacement, FACEPLATE_ROW, FACEPLATE_WIDTH, type Box, type OverlayChange, type PinnedOverlay } from './popover.ts'
  import { toneOf } from './readout.ts'
  import ValueRows from './ValueRows.svelte'

  // An element's faceplate (L2, plan v5 §3, W3.2): a card in OpenBridge's card
  // look, no arrow, beside its item and never over it. Its header names the
  // element with its state word and its worst own alert, opens its detail
  // ("Open detail ›", or the way to the display window from a chat answer or
  // a tag's dialog) and pins it; under it, in the display window only, its
  // Pack's proposal and controls (a monitoring overlay folds them); then at
  // most six of its readings, its lead values each sample (while the display
  // is FROZEN the last ones, in OpenBridge's low-integrity style); at most three of
  // its own alerts; and the devices it bundles or, for a group symbol, its
  // members, each opening its detail or, by its magnifier, its faceplate in
  // this one's place. Focus moves in and stays in while it is open; Esc
  // (unless a section claims it, a selected command first) closes it and
  // gives the focus back to its item. Pinned (popover.ts), the header is its
  // handle: dragged, or moved by the arrow keys 8 px (Shift 24 px); the corner
  // resizes it, 280 to 520 px wide and by whole rows of readings, or
  // Shift+Alt and the arrows; Esc with focus in it unpins it.
  let { runId, objectId, packId, elementId, name, word, title, readings, alerts, alertElements, group, related, anchor, at, avoid, zoom, room, frozen, opening, pending, pinned = null, onclose, onpin, onoverlay, ontouched, onsize, ondetail, onfaceplate }: {
    runId: SimulationRunId
    objectId: string
    packId: string
    elementId: string
    /** The element's short name and its state word as the drawing writes them; null where it has none. FROZEN, the
     *  drawing writes "?" for a state it no longer knows: the header then says no word, its readings keep theirs. */
    name: string
    word: string | null
    /** The display's title: readings are labelled under it. */
    title: string
    readings: FaceplateReadings | null
    /** The display's alert rows this sample: its own are those on its element, or a group's members. */
    alerts: ReadonlyArray<AlertRow>
    alertElements: ReadonlyArray<string>
    /** A group symbol's faceplate: its members, no readings or controls of one of them. */
    group: boolean
    /** A group symbol's members, or the devices the element bundles: each opens its detail or its faceplate. */
    related: { readonly heading: 'Members' | 'Devices'; readonly entries: ReadonlyArray<{ readonly element: string; readonly name: string }> } | null
    /** The item (its button and text) it stands beside, in page px; null for an element the drawing does not draw. */
    anchor: Box | null
    /** Without an item: where it stands (where the faceplate that opened it stood). */
    at: { readonly x: number; readonly y: number } | null
    /** The pinned faceplates it keeps clear of where it can, in page px. */
    avoid: ReadonlyArray<Box>
    zoom: number
    /** The part of the page a person sees: it stands inside it. */
    room: Box
    frozen: boolean
    opening: DisplayOpening | null
    /** A proposal waits on the element: nothing folds and its readings need not give way. */
    pending: boolean
    /** Pinned: where it stands; null while it is the faceplate a press opened. */
    pinned?: PinnedOverlay | null
    onclose: (returnFocus: boolean) => void
    /** Pins it where it stands (page px), or closes its overlay. */
    onpin: (place: { readonly x: number; readonly y: number }) => void
    /** A drag, a key step or a resize of the overlay, with its drawn height. */
    onoverlay: (change: OverlayChange, height: number) => void
    /** It was pressed: it comes to the top of the overlays. */
    ontouched: () => void
    /** Its drawn height changed (its own px): the drawing keeps new faceplates and a narrowed room clear of it. */
    onsize: (height: number) => void
    /** Opens an element's detail (this one's, or a member's or device's). */
    ondetail: (element: string) => void
    /** Opens a member's or device's faceplate in this one's place. */
    onfaceplate: (element: string, name: string) => void
  } = $props()

  const offer = $derived(elementOffer(opening))
  /** The header's state word: none while FROZEN, where the drawing's word is no longer known. */
  const stateWord = $derived(frozen ? null : word)
  let Actions = $state.raw<Component<PackElementActionsProps> | null>(null)
  let card: HTMLElement | undefined = $state()
  let height = $state(160)
  let failure = $state<string | null>(null)

  const own = $derived(ownAlerts(alerts, objectId, alertElements))
  const worst = $derived(worstChip(readings === null ? [] : readings.observations.filter(observation => readings!.values.some(value => value.ref === observation.ref)), own))
  // Its readings: whole rows from the top, as many as keep it at its height at rest or as a person resized it.
  let readingsBox: HTMLElement | undefined = $state()
  /** Its controls fold to keep its readings (shortOfRoom), decided once, at rest, when its controls and readings have
   *  first drawn: a command a person selects grows them afterwards and must not fold them away. */
  let short = $state(false)
  let actionsBox: HTMLElement | undefined = $state()
  let decided = false
  let rest = $state(0)
  const fit = $derived(shownReadings(readings?.values.length ?? 0, { rest, row: FACEPLATE_ROW, pending, rows: pinned?.rows ?? null }))
  /** Its readings as the column's lead rows read, sparklines included (D-C); frozen, the last it had, low-integrity. */
  const rows = $derived(readings === null ? [] : faceplateRows(readings, fit.shown, { title, elementId, frozen }))
  const width = $derived(pinned?.width ?? FACEPLATE_WIDTH)
  const place = $derived(pinned !== null ? { x: pinned.x, y: pinned.y } : anchor !== null ? faceplatePlacement(anchor, { width, height }, room, zoom, avoid)
    : faceplatePlacement({ ...(at ?? { x: room.x, y: room.y }), width: 0, height: 0 }, { width, height }, room, zoom, avoid))
  const tallest = $derived(faceplateHeight(room, zoom))

  runOnMount(() => {
    let closed = false
    // The Pack's actions load only where a display window presents the display: nowhere else is the element operated.
    if (offer === 'actions' && !group) {
      loadEmbedPack(packId).then(contribution => contribution?.elementActions?.()).then(
        module => { if (!closed && module !== undefined) Actions = module.default },
        (error: unknown) => { failure = `Its controls cannot be loaded: ${error instanceof Error ? error.message : String(error)}` },
      )
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A section that claims Esc (a selected command) has it first; a pinned overlay only when focus is in it.
      if (event.target instanceof Element && event.target.closest('[data-claims-escape]') !== null) return
      if (pinned !== null && !(card?.contains(event.target as Node) ?? false)) return
      event.preventDefault()
      event.stopPropagation()
      if (pinned !== null) onpin({ x: pinned.x, y: pinned.y })
      else onclose(true)
    }
    window.addEventListener('keydown', key, { capture: true })
    const sized = new ResizeObserver(() => {
      if (card === undefined) return
      height = card.offsetHeight
      rest = card.offsetHeight - (readingsBox?.offsetHeight ?? 0)
      // Short of room at rest beside its controls as they first stand: they fold behind one line, for as long as it is open.
      if (!decided && Actions !== null && readings !== null && (actionsBox?.offsetHeight ?? 0) > 0) {
        decided = true
        short = shortOfRoom(readings.values.length, { rest, row: FACEPLATE_ROW, pending, rows: pinned?.rows ?? null })
      }
      onsize(height)
    })
    // Focus moves in on its header once OpenBridge's card has drawn its slot: a Tab goes on to its first control.
    if (card !== undefined) {
      sized.observe(card)
      // Without scrolling: the page around the display keeps where it stands (a focus would scroll it to the card).
      if (pinned === null) { card.focus({ preventScroll: true }); requestAnimationFrame(() => { if (card?.contains(document.activeElement) === true) header?.focus({ preventScroll: true }) }) }
    }
    if (readingsBox !== undefined) sized.observe(readingsBox)
    return () => {
      closed = true
      window.removeEventListener('keydown', key, { capture: true })
      sized.disconnect()
    }
  })

  // Focus stays inside an open faceplate (W3.7): a Tab past its last stop comes back to its header, a Shift+Tab past
  // its header to its last stop of its own, never to the page around the display.
  let header: HTMLElement | undefined = $state()
  let contentBox: HTMLElement | undefined = $state()
  const wrapForward = (): void => { header?.focus() }
  const wrapBack = (): void => {
    const stops = [...(contentBox?.querySelectorAll<HTMLElement>('button:not([disabled]), summary, input:not([disabled]), select, textarea, a[href], [tabindex="0"]') ?? [])]
    ;(stops.at(-1) ?? header)?.focus()
  }

  // A drag follows the pointer captured on the header or the corner until it is released (mouse, pen and touch alike).
  const follow = (event: PointerEvent, moved: (travel: { readonly dx: number; readonly dy: number }, end: boolean) => void): void => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('obc-icon-button, obc-button, button') !== null) return
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const [startX, startY] = [event.clientX, event.clientY]
    const travel = (next: PointerEvent) => ({ dx: next.clientX - startX, dy: next.clientY - startY })
    const step = (next: PointerEvent): void => moved(travel(next), false)
    const up = (next: PointerEvent): void => {
      moved(travel(next), true)
      target.removeEventListener('pointermove', step)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', step)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
  const available = (): number => Math.max(1, Math.min(FACEPLATE_READINGS, readings?.values.length ?? 1))
  const headerDown = (event: PointerEvent): void => { if (pinned !== null) follow(event, (travel, end) => onoverlay({ kind: 'move', travel, end }, height)) }
  const cornerDown = (event: PointerEvent): void => {
    event.stopPropagation()
    const rows = available()
    follow(event, (travel, end) => onoverlay({ kind: 'resize', travel, end, available: rows }, height))
  }
  const ARROWS: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const headerKey = (event: KeyboardEvent): void => {
    const arrow = ARROWS[event.key]
    if (pinned === null || arrow === undefined || event.target !== event.currentTarget) return
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey && event.altKey) onoverlay({ kind: 'resize', travel: { dx: (20 * arrow[0]) / zoom, dy: (arrow[1] * FACEPLATE_ROW) / zoom }, end: true, available: available() }, height)
    else onoverlay({ kind: 'move', travel: { dx: arrow[0] * (event.shiftKey ? 24 : 8), dy: arrow[1] * (event.shiftKey ? 24 : 8) }, end: true }, height)
  }
  // A header with no room for all its words says less, never cuts its name or its state: the words that open the
  // detail give way first ('short'), and only where it still has no room does it wrap ('wrap'). Measured as drawn,
  // again whenever its width or its words change.
  let headerFit = $state<'full' | 'short' | 'wrap'>('full')
  const detailWord = $derived(offer === 'actions' ? (headerFit === 'full' ? 'Open detail ›' : 'Detail ›') : headerFit === 'full' ? 'Open in the display window ›' : 'In window ›')
  const fitted = (node: HTMLElement, words: string) => {
    let frame = 0
    let last = ''
    const check = (): void => {
      frame = requestAnimationFrame(() => {
        if (node.scrollWidth <= node.clientWidth + 1 || headerFit === 'wrap') return
        headerFit = headerFit === 'full' ? 'short' : 'wrap'
        check()
      })
    }
    const update = (next: string): void => {
      if (next === last) return
      last = next
      cancelAnimationFrame(frame)
      headerFit = 'full'
      check()
    }
    update(words)
    return { update, destroy: () => cancelAnimationFrame(frame) }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div bind:this={card} class="faceplate" class:pinned={pinned !== null} role="dialog" aria-label={`${name}: ${pinned !== null ? 'pinned faceplate' : 'faceplate'}`} tabindex="-1" data-faceplate={elementId}
  style:left={`${place.x}px`} style:top={`${place.y}px`} style:width={`${width}px`} style:max-height={`${tallest}px`} style:transform={`scale(${1 / zoom})`} style:--row={`${VIGNETTE_ROW_PX}px`}
  onpointerdown={() => ontouched()}>
  <!-- Focus guards: reached only by Tab past either end, each sends focus back inside. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  {#if pinned === null}<span class="sentinel" tabindex="0" aria-hidden="true" onfocus={wrapBack}></span>{/if}
  <obc-card showTitle={false}>
    <div class="body">
      <!-- Pinned, the header is the overlay's handle: focusable, moved by the arrow keys. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
      <header bind:this={header} class:wrap={headerFit === 'wrap'} use:fitted={`${width}|${name}|${stateWord ?? ''}|${worst?.kind ?? ''}|${offer}`} tabindex="0" title={pinned !== null ? 'Drag to move (arrow keys: 8 px, Shift: 24 px); Shift+Alt+arrows resize' : undefined} onpointerdown={headerDown} onkeydown={headerKey}>
        {#if pinned !== null}<span class="handle" aria-hidden="true"><obi-drag-horizontal usecsscolor></obi-drag-horizontal></span>{/if}
        <span class="name">{name}</span>
        {#if stateWord !== null}<span class="word">{stateWord}</span>{/if}
        {#if worst?.kind === 'priority'}
          <span class={`chip ${toneOf(worst.priority)}`}>{severityTable[worst.priority].word}</span>
        {:else if worst?.kind === 'undeclared'}
          <span class="chip neutral">{severityStyle(null, worst.severity)!.word}</span>
        {/if}
        {#if offer !== 'nothing'}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <obc-button class="detail" variant="flat" onclick={() => ondetail(elementId)}>{detailWord}</obc-button>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <obc-icon-button class="pin" variant="flat" activated={pinned !== null} ariaLabel={pinned !== null ? `Unpin ${name}` : `Pin ${name} on the display`} title={pinned !== null ? 'Unpin: close the overlay' : 'Pin on the display'} onclick={() => onpin(place)}>{#if pinned !== null}<obi-pin-selected-google usecsscolor></obi-pin-selected-google>{:else}<obi-pin-google usecsscolor></obi-pin-google>{/if}</obc-icon-button>
      </header>
      <div class="content" bind:this={contentBox}>
        {#if offer === 'actions' && Actions !== null}
          <div class="actions" bind:this={actionsBox}><Actions {runId} objectId={objectIdSchema.parse(objectId)} {elementId} {frozen} pinned={pinned !== null} {short} /></div>
        {/if}
        {#if failure !== null}<p class="status" role="status">{failure}</p>{/if}
        {#if group}
          <!-- A group symbol's members are listed below; none of them speaks for the group. -->
        {:else if readings === null}
          <p class="status">Reading {name}…</p>
        {:else}
          <!-- Its readings, one row each, as the column's lead rows: its 10-min sparkline at the row's right (D-C). -->
          <div class="readings" bind:this={readingsBox}>
            <ValueRows {rows} now={readings.now} />
            {#if fit.more > 0}
              {#if offer === 'nothing'}<p class="more">+{fit.more} more in its detail</p>
              {:else}<button type="button" class="more" onclick={() => ondetail(elementId)}>+{fit.more} more in its detail ›</button>{/if}
            {/if}
          </div>
        {/if}
        {#if own.length > 0}
          <!-- Its own alerts in the alerts view's rows; the header's chip says the worst, so the view's own head stands down. -->
          <div class="alerts" class:frozen style:height={`${Math.min(FACEPLATE_ALERTS, own.length) * VIGNETTE_ROW_PX}px`}>
            <AlertsSection rows={alerts} section={{ objectIds: [objectId], elements: [...alertElements] }} room={1 + Math.min(FACEPLATE_ALERTS, own.length)} />
          </div>
        {/if}
        {#if related !== null && related.entries.length > 0}
          <ul class="related" aria-label={related.heading}>
            {#each related.entries as entry (entry.element)}
              <!-- In the window each opens its detail, where it is drawn with its own magnifier; elsewhere its faceplate here. -->
              <li><button type="button" class="open" title={offer === 'actions' ? `Open ${entry.name}'s detail` : `${entry.name}'s faceplate`} onclick={() => (offer === 'actions' ? ondetail(entry.element) : onfaceplate(entry.element, entry.name))}>{entry.name} ›</button></li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </obc-card>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  {#if pinned === null}<span class="sentinel" tabindex="0" aria-hidden="true" onfocus={wrapForward}></span>{/if}
  {#if pinned !== null}
    <span class="corner" role="presentation" title="Drag to resize (Shift+Alt+arrows)" onpointerdown={cornerDown}><obi-resize-corner usecsscolor></obi-resize-corner></span>
  {/if}
</div>

<style>
  /* OpenBridge's card on its floating elevation, no arrow; it reads at 100 % whatever the display's zoom. */
  .faceplate { position: fixed; z-index: 10; display: flex; transform-origin: 0 0; outline: none; border-radius: var(--ui-components-card-border-radius-regular, 8px); box-shadow: var(--shadow-floating); color: var(--element-active-color); font-size: 13px; }
  .faceplate.pinned { z-index: 9; }
  .sentinel { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .faceplate:focus-visible { outline: 2px solid var(--border-focus-color); }
  obc-card { display: flex; flex: 1 1 auto; min-height: 0; }
  .body { display: flex; flex-direction: column; width: 100%; min-height: 0; max-height: inherit; }
  /* Its name, state word and chip never shrink; where a narrowed card has no room for them all, the header wraps. */
  header { display: flex; flex-wrap: nowrap; align-items: center; column-gap: 6px; flex: none; min-height: 40px; padding: 0 0 0 8px; border-bottom: 1px solid var(--border-divider-color); white-space: nowrap; overflow: hidden; }
  header.wrap { flex-wrap: wrap; overflow: visible; }
  .pinned header { cursor: move; touch-action: none; padding-left: 0; }
  header:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .handle { display: inline-flex; flex: none; width: 24px; height: 40px; align-items: center; justify-content: center; color: var(--element-neutral-color); }
  .handle obi-drag-horizontal { width: 20px; height: 20px; }
  .name { flex: none; font-weight: 700; }
  .word { flex: none; font-weight: 600; font-size: 12px; }
  .chip { flex: none; padding: 0 5px; border: 1px solid; border-radius: 3px; font-size: 12px; font-weight: 700; letter-spacing: 0.03em; }
  .chip.neutral { color: var(--element-active-color); border-color: var(--border-outline-color); }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); }
  .detail { flex: none; margin-left: auto; }
  .pin { flex: none; }
  .content { display: flex; flex-direction: column; gap: 2px; min-height: 0; padding: 2px 8px 6px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
  .content > * { flex: none; }
  .status { margin: 0; line-height: var(--row); color: var(--element-neutral-color); }
  .alerts { overflow: hidden; }
  .alerts :global(h2) { display: none; }
  /* A frozen display's alerts: OpenBridge's low-integrity colours around what they last showed, as the display's own (Sections). */
  .alerts.frozen { background: var(--alert-low-integrity-background-color); box-shadow: 0 0 0 2px var(--alert-low-integrity-background-color), 0 0 0 3px var(--alert-low-integrity-border-color); }
  .more { display: block; height: var(--row); margin: 0; padding: 0; border: none; background: none; font: inherit; font-size: 12px; line-height: var(--row); text-align: left; color: var(--element-neutral-color); }
  button.more { cursor: pointer; color: var(--element-active-color); }
  button.more:hover { text-decoration: underline; }
  /* On a touch screen its press target reaches 40 px, an unseen margin round its one row (W8.3). */
  @media (pointer: coarse) { button.more { position: relative; } button.more::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 40px; transform: translateY(-50%); } }
  .related { display: flex; flex-wrap: wrap; gap: 0 12px; margin: 0; padding: 0; list-style: none; }
  .related li { display: inline-flex; align-items: center; }
  .related button { height: 40px; padding: 0 4px; border: none; background: none; font: inherit; color: var(--element-active-color); cursor: pointer; }
  .related .open:hover { text-decoration: underline; }
  .related button:focus-visible { outline: 2px solid var(--border-focus-color); }
  /* The corner's press target is 40 px; its glyph 16 px in the corner. */
  .pinned .content { padding-bottom: 28px; }
  .corner { position: absolute; right: 0; bottom: 0; display: flex; align-items: flex-end; justify-content: flex-end; width: 40px; height: 40px; padding: 2px; cursor: nwse-resize; touch-action: none; color: var(--element-neutral-color); }
  .corner obi-resize-corner { width: 16px; height: 16px; }
</style>
