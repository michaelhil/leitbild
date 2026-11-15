<script lang="ts">
  import { untrack } from 'svelte'
  import { objectIdSchema, type GeoJsonPoint, type ObjectId } from '../../../core/model/index.ts'
  import type { PackMapTarget } from '../../../core/packs/protocol.ts'
  import { loadMapSymbols } from '../../../ui/map-runtime/map-symbols.ts'
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'
  import { neutralLexicon } from '../lexicon.ts'
  import type { OrderWhen, Stop, UnitOrderInput } from '../order-schema.ts'
  import type { Situation, SituationCall, UnitOptions } from '../situation/schema.ts'
  import type { MapPrompt, SurfacePanelProps } from '../../../ui/surface-panel-interaction.ts'
  import { dispatchMapCover, panelBottomClearancePx, panelEdgeGapPx, panelLayoutFor, panelTopClearancePx, sheetOpen, shownClearOfPanel } from './dispatch-layout.ts'
  import { createIconCache, runEinsatzClient, situationIconIds, type CommandOutcome } from './einsatz-client.ts'
  import {
    busyPrompt,
    cardFor,
    contactRows,
    deliverToOrder,
    dispatchWords,
    edgeTabText,
    emptySelectionText,
    movePromptText,
    overview,
    ownReceipt,
    receiptsFromSituation,
    receiptUndoable,
    targetingFor,
    withReceipts,
    type PinnedProposal,
    type Receipt,
  } from './presenters.ts'
  import { dispatchKindOf, initialSelection, reduceSelection, selectedObjectOf, selectionChangeEvent, type ClickedObject, type DispatchObjectKind, type SelectionEffect, type SelectionEvent, type SelectionState } from './selection.ts'
  import ContactsSection from './ContactsSection.svelte'
  import OverviewLists from './OverviewLists.svelte'
  import SelectionCard from './SelectionCard.svelte'

  /**
   * The Einsatz Dispatch panel: the Pack's one surface panel and its only
   * list. A thin view over the pure modules: the selection table
   * (`selection.ts`) decides what each click does, the presenters what is
   * shown, the client what is read and sent, the layout where it lies.
   *
   * It holds the Run's situation, read on open and on every data revision;
   * an armed unit's options, read on arming and on every data revision while
   * it stays armed; and the call card's proposal, pinned when the card opens
   * and read again only on Refresh. It never holds the configuration.
   *
   * Every map click on an Einsatz object reaches it: the surface shares the
   * selection (`selectedObjectId`) or, with a unit selected, hands it the
   * click as that unit's map target (`onMapTarget`). Both become one `click`
   * of the selection table, as a row tap does. While a unit is armed it
   * hands the map the targeting (halos with ETA tags) and the Move or busy
   * prompt. Esc goes one level back, as the banner's and the card's × do.
   */
  const props: SurfacePanelProps = $props()

  const client = $derived(runEinsatzClient(props.simulationRunId))
  let situation = $state.raw<Situation | null>(null)
  /** The Run time of the situation's read, in ms; its clocks run on from there. */
  let readAtRunMs = $state<number | null>(null)
  let clock = $state(0)
  let problem = $state<string | null>(null)
  let selection = $state.raw<SelectionState>(initialSelection)
  let options = $state.raw<UnitOptions | null>(null)
  let pinned = $state.raw<PinnedProposal | null>(null)
  let opened = $state.raw<ReadonlySet<string>>(new Set())
  let lastSeenCall = $state.raw<SituationCall | null>(null)
  let receipts = $state.raw<ReadonlyArray<Receipt>>([])
  let feedback = $state.raw<{ readonly text: string; readonly code: string | null } | null>(null)
  let surfaceWidth = $state(0)
  let surfaceHeight = $state(0)
  let panelSize = $state.raw({ width: 0, height: 0 })
  let sheetOpenedByOperator = $state(false)
  let iconRevision = $state(0)
  let root = $state<HTMLElement | null>(null)
  let disposed = false

  const icons = createIconCache({ load: loadMapSymbols, changed: () => { iconRevision += 1 } })
  const icon = (id: string): string | undefined => {
    void iconRevision
    return icons.svg(id)
  }
  const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

  const layout = $derived(panelLayoutFor(surfaceWidth, surfaceHeight))
  const open = $derived(layout.mode === 'docked' || sheetOpen(sheetOpenedByOperator, selectedObjectOf(selection.selection) !== null))
  const elapsedS = $derived.by(() => {
    void clock
    const now = props.currentTime()
    return readAtRunMs === null || now === undefined ? 0 : Math.max(0, (Date.parse(now) - readAtRunMs) / 1_000)
  })
  const card = $derived(situation === null ? null : cardFor(situation, selection.selection, { options, pinned, opened, lastSeenCall, elapsedS }))
  const lists = $derived(situation === null ? null : overview(situation, selection.selection, opened, elapsedS))
  const contacts = $derived.by(() => {
    if (lists === null || !lists.contacts) return []
    void clock
    const now = props.currentTime()
    return contactRows(props.objects, now === undefined ? null : Date.parse(now), selectedObjectOf(selection.selection))
  })
  /** Wall time, on the panel's clock, for the receipts' Undo window. */
  const nowMs = $derived.by(() => {
    void clock
    return Date.now()
  })
  const missingArtwork = $derived.by(() => {
    void iconRevision
    return icons.missing()
  })

  const kindOfObject = (objectId: string): DispatchObjectKind | null => {
    const object = props.objects.find(entry => entry.id === objectId)
    return object === undefined ? null : dispatchKindOf(object)
  }

  // ——— Reads ———

  let situationRead = 0
  const readSituation = async (): Promise<void> => {
    const read = ++situationRead
    try {
      const next = await client.situation()
      if (disposed || read !== situationRead) return
      const now = props.currentTime()
      readAtRunMs = now === undefined ? null : Date.parse(now)
      receipts = withReceipts(receipts, receiptsFromSituation(situation, next, Date.now()))
      situation = next
      problem = null
      icons.request([...situationIconIds(next), ...contactRows(props.objects, null, null).map(row => row.icon)])
    } catch (error) {
      if (!disposed && read === situationRead) problem = `${dispatchWords.readFailed}: ${messageOf(error)}`
    }
  }

  let optionsRead = 0
  const readOptions = async (unitId: string): Promise<void> => {
    const read = ++optionsRead
    try {
      const answer = await client.unitOptions(unitId)
      if (!disposed && read === optionsRead) options = answer
    } catch (error) {
      if (!disposed && read === optionsRead) feedback = { text: messageOf(error), code: null }
    }
  }

  let pinRead = 0
  const pin = async (callId: string): Promise<void> => {
    const read = ++pinRead
    pinned = null
    try {
      const answer = await client.recommend(callId)
      if (!disposed && read === pinRead) pinned = { callId, answer, dropped: new Set() }
    } catch (error) {
      if (!disposed && read === pinRead) feedback = { text: messageOf(error), code: null }
    }
  }

  // ——— The selection table ———

  const send = (event: SelectionEvent): void => {
    const stepped = reduceSelection(selection, event)
    selection = stepped.state
    for (const effect of stepped.effects) perform(effect)
  }

  const perform = (effect: SelectionEffect): void => {
    switch (effect.kind) {
      case 'select':
        feedback = null
        props.onSelectObject(effect.objectId === null ? null : objectIdSchema.parse(effect.objectId))
        return
      case 'options':
        void readOptions(effect.unitId)
        return
      case 'recommend':
        opened = new Set([...opened, effect.callId])
        void pin(effect.callId)
        return
      case 'submit':
        void submit(effect.unitId, effect.target, effect.when)
        return
    }
  }

  const unitLabel = (unitId: string): string => situation?.units.find(unit => unit.id === unitId)?.label ?? unitId
  const stopLabel = (stop: Stop): string => {
    const listed = options?.targets.find(target => JSON.stringify(target.target) === JSON.stringify(stop))?.label
    if (listed !== undefined) return listed
    if ('taskId' in stop) return situation?.calls.find(call => call.id === stop.taskId)?.label ?? stop.taskId
    if ('siteId' in stop) return situation?.sites.find(site => site.id === stop.siteId)?.label ?? stop.siteId
    if ('trackId' in stop) return props.objects.find(object => object.id === stop.trackId)?.label ?? stop.trackId
    return dispatchWords.mapPoint
  }

  const outcomeOf = async (run: () => Promise<CommandOutcome>): Promise<CommandOutcome> => {
    try {
      return await run()
    } catch (error) {
      return { ok: false, code: null, text: messageOf(error) }
    }
  }

  /** The armed unit's order for one stop: `now` names the task it drops, as its options say. */
  const submit = async (unitId: string, target: Stop, when: OrderWhen | null): Promise<void> => {
    const busy = when === 'now' ? busyPrompt(options, unitId) : null
    if (when === 'now' && busy === null) {
      feedback = { text: 'The unit\'s current job is not known yet; nothing was sent', code: null }
      return
    }
    const dropped = busy === null ? null : options?.busy?.label ?? null
    const input: UnitOrderInput = { units: [unitId], stops: [target], ...(when === null ? {} : { when }), ...(busy === null ? {} : { drops: busy.drops }) }
    const outcome = await outcomeOf(async () => await client.order(input))
    if (disposed) return
    send({ kind: 'result', unitId, target, outcome: outcome.ok ? { ok: true } : { ok: false, code: outcome.code, text: outcome.text }, atMs: Date.now() })
    if (outcome.ok) receipts = withReceipts(receipts, [ownReceipt({ commandId: outcome.commandId, unitIds: [unitId], unitLabel: unitLabel(unitId), targetLabel: stopLabel(target), dropped, atMs: Date.now() })])
  }

  /** A card's command: a refusal shows in the card; an accepted order leaves a receipt. */
  const command = async (run: () => Promise<CommandOutcome>, receipt: { readonly unitIds: ReadonlyArray<string>; readonly target: string } | null): Promise<void> => {
    feedback = null
    const outcome = await outcomeOf(run)
    if (disposed) return
    if (!outcome.ok) {
      feedback = { text: outcome.text, code: outcome.code }
      return
    }
    if (receipt !== null) {
      receipts = withReceipts(receipts, [ownReceipt({ commandId: outcome.commandId, unitIds: receipt.unitIds, unitLabel: receipt.unitIds.map(unitLabel).join(', '), targetLabel: receipt.target, dropped: null, atMs: Date.now() })])
    }
  }

  const order = (input: UnitOrderInput): void => {
    void command(async () => await client.order(input), { unitIds: input.units, target: input.stops.map(stopLabel).join(' → ') })
  }

  const undoReceipt = (receipt: Receipt): void => {
    for (const unitId of receipt.unitIds) void command(async () => await client.undo(unitId, receipt.commandId), null)
  }

  const toggleChip = (unitId: string): void => {
    const current = pinned
    if (current === null) return
    const dropped = new Set(current.dropped)
    if (dropped.has(unitId)) dropped.delete(unitId)
    else dropped.add(unitId)
    pinned = { ...current, dropped }
  }

  /** The map point of a stop: its own point, or the position of the object it names. */
  const pointOf = (stop: Stop): GeoJsonPoint | undefined => {
    if ('point' in stop) return stop.point
    const id = 'taskId' in stop ? stop.taskId : 'siteId' in stop ? stop.siteId : stop.trackId
    return props.objects.find(object => object.id === id)?.spatial.position?.point
  }

  /** A row tap: that object's card, and a pan only when the map shows it under the panel or not at all. */
  const openRow = (object: ClickedObject): void => {
    send({ kind: 'click', on: object, atMs: Date.now() })
    const view = props.mapView
    const point = props.objects.find(entry => entry.id === object.id)?.spatial.position?.point
    if (view === null || point === undefined || surfaceWidth <= 0 || surfaceHeight <= 0) return
    const cover = dispatchMapCover(layout, panelSize, open)
    if (shownClearOfPanel(view, { width: surfaceWidth, height: surfaceHeight }, cover, point.coordinates)) return
    props.onFocusMap({ kind: 'point', center: [point.coordinates[0], point.coordinates[1]] })
  }

  const onMapTarget = (_controllerId: ObjectId, target: PackMapTarget): void => {
    if (target.kind === 'point') {
      send({ kind: 'click', on: { kind: 'ground', point: target.point }, atMs: Date.now() })
      return
    }
    const kind = kindOfObject(target.objectId)
    // Another Pack's object is nothing the panel orders to.
    if (kind === null) return
    send({ kind: 'click', on: { id: target.objectId, kind }, atMs: Date.now() })
  }

  const fold = (): void => {
    sheetOpenedByOperator = false
    while (selectedObjectOf(selection.selection) !== null) send({ kind: 'back' })
  }

  const editable = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

  runOnMount(() => {
    const element = root
    const surface = element?.parentElement
    if (!element || !surface) throw new Error('The Dispatch panel was not mounted inside the World surface')
    const surfaceObserver = new ResizeObserver(() => {
      surfaceWidth = surface.clientWidth
      surfaceHeight = surface.clientHeight
    })
    surfaceObserver.observe(surface)
    const panelObserver = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      panelSize = { width: rect.width, height: rect.height }
    })
    panelObserver.observe(element)
    const ticker = window.setInterval(() => {
      clock += 1
      send({ kind: 'tick', atMs: Date.now() })
    }, 1_000)
    // Esc is a desktop accelerator for the banner's and the card's ×; it never takes a key typed into a field.
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || !props.keysActive || editable(event.target)) return
      if (selectedObjectOf(selection.selection) === null) return
      event.preventDefault()
      send({ kind: 'back' })
    }
    window.addEventListener('keydown', onKeydown)
    const release = props.connectInteraction({ onMapTarget })
    return () => {
      disposed = true
      window.clearInterval(ticker)
      window.removeEventListener('keydown', onKeydown)
      surfaceObserver.disconnect()
      panelObserver.disconnect()
      release()
      props.onMapPrompt(null)
      props.onMapTargeting(null)
    }
  })

  // Every data revision reads the situation again, and an armed unit's options; the first runs on open.
  $effect(() => {
    void props.dataRevision
    untrack(() => {
      void readSituation()
      const armed = selection.selection
      if (armed.kind === 'armed') void readOptions(armed.unitId)
    })
  })

  // A selection the map made, or cleared, is a click of the table; the panel's own coming back is none.
  $effect(() => {
    const objectId = props.selectedObjectId
    untrack(() => {
      const event = selectionChangeEvent(selection, objectId, kindOfObject, Date.now())
      if (event !== null) send(event)
    })
  })

  // The selected call's row as last seen, so its card says who served it once it closed.
  $effect(() => {
    const shown = selection.selection
    const current = situation
    if (shown.kind !== 'call' || current === null) return
    const row = current.calls.find(call => call.id === shown.callId)
    if (row !== undefined) untrack(() => { lastSeenCall = row })
  })

  // The armed unit's halos and tags; sent again only when they change.
  let shownTargeting: string | null = null
  $effect(() => {
    const targeting = targetingFor(selection.selection, options)
    const key = targeting === null ? null : JSON.stringify(targeting)
    if (key === shownTargeting) return
    shownTargeting = key
    untrack(() => props.onMapTargeting(targeting))
  })

  // The armed unit's Move or busy prompt, offset from its point; sent again only when it changes.
  let shownPrompt: string | null = null
  $effect(() => {
    const shown = selection.selection
    const current = situation
    let prompt: MapPrompt | null = null
    if (shown.kind === 'armed' && shown.prompt !== null && current !== null) {
      if (shown.prompt.kind === 'move') {
        prompt = { point: shown.prompt.point, options: [{ label: movePromptText(current, shown.unitId), onConfirm: () => send({ kind: 'prompt', choice: 'move' }) }] }
      } else {
        const busy = busyPrompt(options, shown.unitId)
        const point = pointOf(shown.prompt.target)
        if (busy !== null && point !== undefined) {
          prompt = {
            point,
            options: [
              { label: busy.after, onConfirm: () => send({ kind: 'prompt', choice: 'after' }) },
              { label: busy.now, tone: 'warning', onConfirm: () => send({ kind: 'prompt', choice: 'now' }) },
            ],
          }
        }
      }
    }
    const key = prompt === null ? null : JSON.stringify([prompt.point.coordinates, prompt.options.map(option => option.label)])
    if (key === shownPrompt) return
    shownPrompt = key
    untrack(() => props.onMapPrompt(prompt))
  })

  // The camera centres clear of the docked panel or the open sheet.
  $effect(() => {
    const cover = dispatchMapCover(layout, panelSize, open)
    untrack(() => props.onMapCover(cover))
  })
</script>

<section
  class="dispatch"
  data-mode={layout.mode}
  class:folded={!open}
  bind:this={root}
  style:width={layout.mode === 'docked' ? `${layout.widthPx}px` : null}
  style:max-height={layout.mode === 'sheet' ? `${layout.maxHeightPx}px` : null}
  style:top={layout.mode === 'docked' ? `${panelTopClearancePx}px` : null}
  style:bottom={layout.mode === 'docked' ? `${panelBottomClearancePx}px` : '0px'}
  style:right={layout.mode === 'docked' ? `${panelEdgeGapPx}px` : '0px'}
  aria-label={dispatchWords.panel}
>
  {#if !open}
    <button type="button" class="tab" onclick={() => { sheetOpenedByOperator = true }}>
      <strong>{situation === null ? dispatchWords.panel : edgeTabText(situation)}</strong>
      {#if receipts[0] !== undefined}<span class="receipt-line">{receipts[0].text}</span>{/if}
    </button>
  {:else}
    <header class="head">
      <h2>{dispatchWords.panel}</h2>
      {#if layout.mode === 'sheet'}<button type="button" class="fold" aria-label={dispatchWords.close} onclick={fold}>⌄</button>{/if}
    </header>
    {#if problem !== null}
      <p class="problem" role="alert">{problem} <button type="button" onclick={() => { void readSituation() }}>{dispatchWords.retry}</button></p>
    {/if}
    {#if situation === null}
      {#if problem === null}<p class="loading">{dispatchWords.loading}</p>{/if}
    {:else}
      <div class="selection">
        {#if card !== null}
          <SelectionCard
            {card}
            {feedback}
            {icon}
            back={() => send({ kind: 'back' })}
            arm={(unitId, when) => send({ kind: 'arm', unitId, when })}
            targetRow={target => send({ kind: 'target-row', target, atMs: Date.now() })}
            promptChoice={choice => send({ kind: 'prompt', choice })}
            recall={unitId => { void command(async () => await client.recall(unitId), { unitIds: [unitId], target: situation === null ? dispatchWords.panel : situation.words.return }) }}
            undo={(unitId, commandId) => { void command(async () => await client.undo(unitId, commandId), null) }}
            removeStop={(unitId, stopId) => { void command(async () => await client.removeStop(unitId, stopId), null) }}
            deliverTo={(unitId, siteId) => { const unit = situation?.units.find(entry => entry.id === unitId); if (unit !== undefined) order(deliverToOrder(unit, siteId)) }}
            {order}
            {toggleChip}
            refresh={callId => { void pin(callId) }}
            closeTask={taskId => { void command(async () => await client.closeTask(taskId), null) }}
            setSite={(siteId, accepting) => { void command(async () => await client.setSite(siteId, accepting), null) }}
          />
        {:else}
          <p class="hint">{emptySelectionText(situation.words)}</p>
          {#if feedback !== null}<p class="problem" role="alert">{feedback.text}</p>{/if}
        {/if}
      </div>
      {#if lists !== null}
        <div class="lists">
          <OverviewLists view={lists} {icon} open={openRow} />
          {#if lists.contacts && !lists.folded}
            <ContactsSection heading={neutralLexicon.tracks} empty={neutralLexicon.noTracks} rows={contacts} {icon} open={openRow} />
          {/if}
        </div>
      {/if}
      {#if missingArtwork !== null}<p class="artwork">{missingArtwork}</p>{/if}
      {#if receipts.length > 0}
        <ol class="receipts" aria-label={dispatchWords.undo}>
          {#each receipts as receipt (receipt.commandId)}
            <li>
              <span class="receipt-text">{receipt.text}</span>
              {#if receiptUndoable(receipt, nowMs)}<button type="button" onclick={() => undoReceipt(receipt)}>{receipt.undo}</button>{/if}
            </li>
          {/each}
        </ol>
      {/if}
    {/if}
  {/if}
</section>

<style>
  /* Its offsets and width come from dispatch-layout.ts. */
  .dispatch {
    position: absolute;
    z-index: 15;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--panel) 97%, transparent);
    box-shadow: 0 10px 30px rgba(16, 24, 40, .22);
    color: var(--text);
    font-size: 13px;
    line-height: 16px;
    pointer-events: auto;
  }
  .dispatch[data-mode='sheet'] { left: 0; border-radius: 10px 10px 0 0; }
  .dispatch[data-mode='sheet'].folded { left: auto; padding: 0; border-radius: 10px 0 0 0; }
  .head { flex: none; display: flex; align-items: center; gap: 8px; }
  h2 { flex: 1; margin: 0; font-size: 12px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .selection { flex: none; max-height: 55%; overflow: auto; overscroll-behavior: contain; }
  .lists { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; display: grid; align-content: start; gap: 4px; }
  .hint { margin: 0; padding: 10px 8px; border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); }
  .loading { margin: 0; color: var(--muted); }
  .problem { margin: 0; color: var(--critical); }
  .artwork { flex: none; margin: 0; color: var(--warning); font-size: 11px; }
  .receipts { flex: none; display: grid; gap: 4px; margin: 0; padding: 6px 0 0; border-top: 1px solid var(--border); list-style: none; }
  .receipts li { display: flex; align-items: center; gap: 6px; }
  .receipt-text { flex: 1; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
  button { min-height: 44px; min-width: 44px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; font: inherit; font-size: 12px; cursor: pointer; touch-action: manipulation; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .receipts button { border-color: var(--accent); color: var(--accent); font-weight: 650; }
  .tab { display: grid; gap: 2px; padding: 8px 14px; border: 0; border-radius: 10px 0 0 0; background: transparent; text-align: left; }
  .receipt-line { color: var(--muted); font-size: 11px; }
  .fold { font-size: 18px; line-height: 1; }
</style>
