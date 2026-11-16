<script lang="ts">
  import { untrack } from 'svelte'
  import { objectIdSchema, type ObjectId } from '../../../core/model/index.ts'
  import type { PackMapTarget } from '../../../core/packs/protocol.ts'
  import { loadMapSymbols } from '../../../ui/map-runtime/map-symbols.ts'
  import type { SurfacePanelProps } from '../../../ui/surface-panel-interaction.ts'
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'
  import { waypointItemId } from '../chain-path.ts'
  import { neutralLexicon } from '../lexicon.ts'
  import type { Stop, UnitOrderInput } from '../order-schema.ts'
  import type { Situation, SituationCall, UnitOptions } from '../situation/schema.ts'
  import { dispatchMapCover, panelBottomClearancePx, panelEdgeGapPx, panelLayoutFor, panelTopClearancePx, sheetOpen, shownClearOfPanel } from './dispatch-layout.ts'
  import { createIconCache, runEinsatzClient, situationIconIds, type CommandOutcome } from './einsatz-client.ts'
  import {
    cardFor,
    contactRows,
    dispatchKindOf,
    dispatchWords,
    edgeTabText,
    einsatzRecordsKey,
    emptySelectionText,
    jobText,
    overview,
    ownReceipt,
    pinProposal,
    receiptsFromSituation,
    receiptText,
    targetingFor,
    withReceipts,
    type PinnedProposal,
    type Receipt,
  } from './presenters.ts'
  import {
    activationActs,
    canTarget,
    initialSelection,
    moveQueuedStop,
    planExpectation,
    reduceSelection,
    selectedObjectOf,
    selectionChangeEvent,
    stopKey,
    type ClickedObject,
    type DispatchObjectKind,
    type SelectionEffect,
    type SelectionEvent,
    type SelectionState,
  } from './selection.ts'
  import DispatchDecision from './DispatchDecision.svelte'
  import ContactsSection from './ContactsSection.svelte'
  import OverviewLists from './OverviewLists.svelte'
  import SelectionCard from './SelectionCard.svelte'

  // Map clicks, the unit grid, and keyboard-accessible target rows share the same selection rules.
  const props: SurfacePanelProps = $props()

  const client = $derived(runEinsatzClient(props.simulationRunId))
  let situation = $state.raw<Situation | null>(null)
  /** The Run time of the situation's read, in ms; its clocks run on from there. */
  let readAtRunMs = $state<number | null>(null)
  let clock = $state(0)
  let problem = $state<string | null>(null)
  let selection = $state.raw<SelectionState>(initialSelection)
  let options = $state.raw<UnitOptions | null>(null)
  let unitPending = $state(false)
  let pinned = $state.raw<PinnedProposal | null>(null)
  let opened = $state.raw<ReadonlySet<string>>(new Set())
  let lastSeenCall = $state.raw<SituationCall | null>(null)
  let receipts = $state.raw<ReadonlyArray<Receipt>>([])
  /** The last refusal or failure the panel reports outside a target, shown in the card's slot. */
  let feedback = $state<string | null>(null)
  /** The call whose Close waits for its inline confirm. */
  let confirming = $state<string | null>(null)
  let surfaceWidth = $state(0)
  let surfaceHeight = $state(0)
  let panelSize = $state.raw({ width: 0, height: 0 })
  let sheetOpenedByOperator = $state(false)
  let iconRevision = $state(0)
  let root = $state<HTMLElement | null>(null)
  let disposed = false
  /** When the last command acted: the double-click guard. */
  let quietFromMs: number | null = null

  const icons = createIconCache({ load: loadMapSymbols, changed: () => { iconRevision += 1 } })
  const icon = (id: string): string | undefined => {
    void iconRevision
    return icons.svg(id)
  }
  const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

  const selectedUnit = $derived.by(() => {
    const selected = selection.selection
    return selected.kind === 'unit' ? situation?.units.find(unit => unit.id === selected.unitId) : undefined
  })
  const decision = $derived(selection.selection.kind === 'unit' ? selection.selection.decision : undefined)
  const layout = $derived(panelLayoutFor(surfaceWidth, surfaceHeight, selection.selection.kind === 'unit'))
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
  const missingArtwork = $derived.by(() => {
    void iconRevision
    return icons.missing()
  })

  const kindOfObject = (objectId: string): DispatchObjectKind | null => {
    const object = props.objects.find(entry => entry.id === objectId)
    return object === undefined ? null : dispatchKindOf(object)
  }

  /** A command from the card, a row or the footer: it acts unless it is the second half of a double-click. */
  const act = <Args extends ReadonlyArray<unknown>>(run: (...args: Args) => void) => (...args: Args): void => {
    const now = Date.now()
    if (!activationActs(quietFromMs, now)) return
    quietFromMs = now
    run(...args)
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
      const selected = selection.selection
      if (!disposed && read === optionsRead && selected.kind === 'unit' && selected.unitId === unitId) options = answer
    } catch (error) {
      if (!disposed && read === optionsRead) feedback = messageOf(error)
    }
  }

  let pinRead = 0
  /** Pins the call's proposal; asked again (Refresh), the old answer stays, greyed, until the new one arrives. */
  const pin = async (callId: string): Promise<void> => {
    const read = ++pinRead
    pinned = pinned !== null && pinned.callId === callId ? { ...pinned, refreshing: true } : null
    try {
      const answer = await client.recommend(callId)
      if (!disposed && read === pinRead) pinned = pinProposal(situation, callId, answer)
    } catch (error) {
      if (!disposed && read === pinRead) {
        if (pinned !== null && pinned.callId === callId) pinned = { ...pinned, refreshing: false }
        feedback = messageOf(error)
      }
    }
  }

  // ——— The selection table ———

  const send = (event: SelectionEvent): void => {
    if (unitPending && (event.kind === 'target-row' || event.kind === 'stop' || event.kind === 'decide' ||
      (event.kind === 'click' && event.on.kind !== 'unit' && selectedUnit !== undefined))) return
    const stepped = reduceSelection(selection, event, options, selectedUnit)
    selection = stepped.state
    for (const effect of stepped.effects) perform(effect)
  }

  const perform = (effect: SelectionEffect): void => {
    switch (effect.kind) {
      case 'select':
        feedback = null
        confirming = null
        options = null
        props.onSelectObject(effect.objectId === null ? null : objectIdSchema.parse(effect.objectId))
        return
      case 'options':
        void readOptions(effect.unitId)
        return
      case 'recommend':
        opened = new Set([...opened, effect.callId])
        void pin(effect.callId)
        return
      case 'submit': {
        const unitId = effect.input.units[0]!
        void editUnit(unitId, async () => await client.order(effect.input), {
          unitIds: [unitId], target: stopLabel(effect.input.stops[0]!), dropped: effect.job === null ? null : jobText(effect.job),
        })
        return
      }
      case 'remove':
        void editUnit(effect.unitId, async () => await client.removeStop(effect.unitId, effect.stopId, effect.expectedPlan))
        return
      case 'feedback':
        feedback = effect.text
        return
    }
  }

  const unitLabel = (unitId: string): string => situation?.units.find(unit => unit.id === unitId)?.label ?? unitId
  const stopLabel = (stop: Stop): string => {
    const listed = options?.targets.find(target => stopKey(target.target) === stopKey(stop))?.label
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

  /** A card's command: a refusal shows in the card's slot; an accepted order leaves a receipt. */
  const command = async (run: () => Promise<CommandOutcome>, receipt: { readonly unitIds: ReadonlyArray<string>; readonly target: string; readonly dropped?: string | null } | null): Promise<void> => {
    feedback = null
    const outcome = await outcomeOf(run)
    if (disposed) return
    if (!outcome.ok) {
      feedback = outcome.text
      return
    }
    if (receipt !== null) {
      receipts = withReceipts(receipts, [ownReceipt({ commandId: outcome.commandId, unitIds: receipt.unitIds, unitLabel: receipt.unitIds.map(unitLabel).join(', '), targetLabel: receipt.target, dropped: receipt.dropped ?? null, atMs: Date.now() })])
    }
  }

  const order = (input: UnitOrderInput): void => {
    void command(async () => await client.order(input), { unitIds: input.units, target: input.stops.map(stopLabel).join(' → ') })
  }

  const editUnit = async (unitId: string, run: () => Promise<CommandOutcome>, receipt: Parameters<typeof command>[1] = null): Promise<void> => {
    if (unitPending) return
    unitPending = true
    try {
      await command(run, receipt)
      if (!disposed) {
        await readSituation()
        const shown = selection.selection
        if (shown.kind === 'unit' && shown.unitId === unitId) await readOptions(unitId)
      }
    } finally { unitPending = false }
  }

  const moveStop = (stopId: string, direction: -1 | 1): void => {
    const unit = selectedUnit
    if (!unit || !canTarget(unit)) return
    const expectedPlan = planExpectation(unit.plan)
    const stopIds = moveQueuedStop(expectedPlan, stopId, direction)
    if (stopIds === null) return
    void editUnit(unit.id, async () => await client.reorder(unit.id, expectedPlan, stopIds))
  }

  const decisionTitle = $derived(decision === undefined ? '' : decision.kind === 'remove'
    ? decision.stops.length === 1 ? 'Remove stop?' : 'Which stop should be removed?'
    : decision.assigned ? 'Change the plan?' : 'Move here?')
  const decisionText = $derived(decision === undefined ? '' : decision.kind === 'remove'
    ? `${selectedUnit?.label ?? 'Unit'}: ${decision.stops.length === 1 ? `Stop ${decision.stops[0]!.index} · ` : ''}${decision.stops[0]?.label ?? 'selected stop'}`
    : `${selectedUnit?.label ?? 'Unit'} → ${stopLabel(decision.target)}${decision.currentLabel === null ? '' : ` · Current: ${decision.currentLabel}`}`)
  const decisionActions = $derived.by(() => {
    if (!decision) return []
    if (decision.kind === 'remove') return decision.stops.map(stop => ({
      label: decision.stops.length === 1 ? 'Remove stop' : `Remove stop ${stop.index}`,
      danger: true, run: () => send({ kind: 'decide', choice: { remove: stop.id } }),
    }))
    const replace = {
      label: decision.assigned ? 'Replace current target' : 'Move here',
      run: () => send({ kind: 'decide', choice: 'replace' }),
      disabled: !decision.replace,
      ...(!decision.replace ? { reason: decision.replaceReason ?? 'The current stop cannot be replaced.' } : {}),
    }
    return decision.assigned ? [replace, {
      label: 'Add to plan', run: () => send({ kind: 'decide', choice: 'add' }),
      disabled: !decision.add,
      ...(!decision.add ? { reason: decision.addReason ?? 'This stop cannot be added to the plan.' } : {}),
    }] : [replace]
  })

  const toggleChip = (unitId: string): void => {
    const current = pinned
    if (current === null) return
    const dropped = new Set(current.dropped)
    if (dropped.has(unitId)) dropped.delete(unitId)
    else dropped.add(unitId)
    pinned = { ...current, dropped }
  }

  /** A row tap: that object's card, and a pan only when the map shows it under the panel or not at all. */
  const openRow = (object: ClickedObject): void => {
    send({ kind: 'click', on: object, atMs: Date.now() })
    if (object.kind !== 'unit' && selectedUnit !== undefined) return
    const view = props.mapView
    const point = props.objects.find(entry => entry.id === object.id)?.spatial.position?.point
    if (view === null || point === undefined || surfaceWidth <= 0 || surfaceHeight <= 0) return
    const cover = dispatchMapCover(layout, panelSize, open)
    if (shownClearOfPanel(view, { width: surfaceWidth, height: surfaceHeight }, cover, point.coordinates)) return
    props.onFocusMap({ kind: 'point', center: [point.coordinates[0], point.coordinates[1]] })
  }

  /** A map click while one of the Pack's units is selected: the surface hands every one to the panel and never sends. */
  const onMapTarget = (selectedId: ObjectId, target: PackMapTarget): void => {
    const shown = selection.selection
    if (shown.kind !== 'unit' || shown.unitId !== selectedId) return
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
    send({ kind: 'back' })
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
    }, 1_000)
    // Esc is a desktop accelerator for the banner's and the card's ×; it never takes a key typed into a field.
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || decision !== undefined || !props.keysActive || editable(event.target)) return
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
      props.onMapTargeting(null)
    }
  })

  // Every change of an Einsatz record the screen sees reads the situation again, and the shown unit's options; the first runs on open.
  const recordsKey = $derived(einsatzRecordsKey(props.objects))
  $effect(() => {
    void recordsKey
    untrack(() => {
      void readSituation()
      const shown = selection.selection
      if (shown.kind === 'unit') void readOptions(shown.unitId)
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

  // The selected unit’s valid targets and current plan markers.
  let shownTargeting: string | null = null
  $effect(() => {
    const targeting = targetingFor(selectedUnit, options)
    const key = targeting === null ? null : JSON.stringify(targeting)
    if (key === shownTargeting) return
    shownTargeting = key
    untrack(() => props.onMapTargeting(targeting))
  })

  // Ground waypoints have no object id. They select their stable plan stop instead.
  $effect(() => {
    const item = props.selectedItemId
    if (item === null) return
    untrack(() => {
      const unit = selectedUnit
      const stop = unit?.plan.find(stop => 'point' in stop.target && waypointItemId(unit.id, stop.id) === item)
      if (stop === undefined) return
      send({ kind: 'stop', stopId: stop.id })
      props.onSelectItem(null)
    })
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
  style:height={layout.mode === 'sheet' && open ? `${layout.heightPx}px` : null}
  style:top={layout.mode === 'docked' ? `${panelTopClearancePx}px` : null}
  style:bottom={layout.mode === 'docked' ? null : '0px'}
  style:max-height={layout.mode === 'docked' ? `${Math.max(0, surfaceHeight - panelTopClearancePx - panelBottomClearancePx)}px` : null}
  style:padding-bottom={layout.mode === 'sheet' && open ? `${panelBottomClearancePx}px` : null}
  style:right={layout.mode === 'docked' ? `${panelEdgeGapPx}px` : '0px'}
  class:unit-selected={selection.selection.kind === 'unit'}
  aria-label={dispatchWords.panel}
>
  {#if !open}
    <button type="button" class="tab" onclick={act(() => { sheetOpenedByOperator = true })}>
      <strong>{situation === null ? dispatchWords.panel : edgeTabText(situation)}</strong>
      {#if receipts[0] !== undefined}<span class="receipt-line">{receiptText(receipts[0])}</span>{/if}
    </button>
  {:else}
    <header class="head">
      <h2>{dispatchWords.panel}</h2>
      {#if layout.mode === 'sheet'}<button type="button" class="fold" aria-label={dispatchWords.close} onclick={act(fold)}>⌄</button>{/if}
    </header>
    {#if problem !== null}
      <p class="problem" role="alert">{problem} <button type="button" onclick={() => { void readSituation() }}>{dispatchWords.retry}</button></p>
    {/if}
    {#if situation === null}
      {#if problem === null}<p class="loading">{dispatchWords.loading}</p>{/if}
    {:else}
      <div class="selection" aria-busy={unitPending}>
        {#if card !== null}
          <SelectionCard
            {card}
            {unitPending}
            {feedback}
            {icon}
            confirming={confirming !== null && confirming === card.id}
            back={act(() => send({ kind: 'back' }))}
            targetRow={(target: Stop) => send({ kind: 'target-row', target })}
            chooseStop={(stopId: string) => send({ kind: 'stop', stopId })}
            {moveStop}
            recall={(unitId: string) => { void editUnit(unitId, async () => await client.recall(unitId), { unitIds: [unitId], target: situation === null ? dispatchWords.panel : situation.words.return }) }}
            order={act(order)}
            toggleChip={act(toggleChip)}
            refresh={act((callId: string) => { void pin(callId) })}
            askClose={act((callId: string) => { confirming = callId })}
            cancelClose={act(() => { confirming = null })}
            closeTask={act((taskId: string) => { confirming = null; void command(async () => await client.closeTask(taskId), null) })}
            setSite={act((siteId: string, accepting: boolean) => { void command(async () => await client.setSite(siteId, accepting), null) })}
          />
        {:else}
          <p class="hint">{emptySelectionText(situation.words)}</p>
          {#if feedback !== null}<p class="problem" role="alert">{feedback}</p>{/if}
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
        <p class="receipt-line latest" role="status">{receiptText(receipts[0]!)}</p>
      {/if}
    {/if}
  {/if}
</section>

{#if decision !== undefined}
  <DispatchDecision title={decisionTitle} text={decisionText} actions={decisionActions} cancel={() => send({ kind: 'decide', choice: 'cancel' })} />
{/if}

<style>
  /* Its offsets, width and the open sheet's height come from dispatch-layout.ts. */
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
  /* The open sheet keeps its footer above the World status line (the clock chip) drawn over its bottom edge. */
  .dispatch[data-mode='sheet'] { left: 0; border-radius: 10px 10px 0 0; }
  .dispatch[data-mode='sheet'].folded { left: auto; padding: 0; border-radius: 10px 0 0 0; }
  .head { flex: none; display: flex; align-items: center; gap: 8px; }
  h2 { flex: 1; margin: 0; font-size: 12px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .selection { flex: 0 1 auto; max-height: min(46dvh, 400px); min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .unit-selected .selection { max-height: none; flex: 1 1 auto; }
  .unit-selected .lists { flex: none; }
  .lists { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; display: grid; align-content: start; gap: 4px; }
  .hint { margin: 0; padding: 10px 8px; border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); }
  .loading { margin: 0; color: var(--muted); }
  .problem { margin: 0; color: var(--critical); }
  .artwork { flex: none; margin: 0; color: var(--warning); font-size: 11px; }
  button { min-height: 44px; min-width: 44px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; font: inherit; font-size: 12px; cursor: pointer; touch-action: manipulation; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .tab { display: grid; gap: 2px; padding: 8px 14px; border: 0; border-radius: 10px 0 0 0; background: transparent; text-align: left; }
  .receipt-line { color: var(--muted); font-size: 11px; }
  .receipt-line.latest { flex: none; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .fold { font-size: 18px; line-height: 1; }
</style>
