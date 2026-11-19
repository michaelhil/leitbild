<script lang="ts">
  // The Screens panel ("Screens…" in the Run bar's More menu), which is also
  // the screen picker for World's "Open on another screen…" (`placing`).
  // - It is the only writer of the stored setup: add, rename and remove a
  //   screen, and what each shows for the scenario of the Run open here.
  // - Opening it calls the roll (a stamp in storage); each open screen window
  //   answers under its id, so a row can say whether its window is there.
  // - Open is one `window.open` per click, at the window's remembered
  //   rectangle; a `null` answer is a pop-up the browser blocked, said on the row.
  // - "Show on screens" and placing a surface are the only things that move
  //   the screens: they write the target (screen-setup.ts).
  // An unreadable stored value is shown with Reset and never written over.
  import { untrack } from 'svelte'
  import type { WorkspaceSurface } from '@leitbild/contracts'
  import Icon from '../Icon.svelte'
  import Modal from '../Modal.svelte'
  import {
    addScreen, assign, assignmentFor, EMPTY_SCREEN_SETUP, hasStoredAssignment, isTarget, miniature, newStamp, removeScreen, renameScreen,
    SCREEN_NAME_MAX_LENGTH, screenName, screenStorageChange, screenUrl, screenWindowFeatures, screenWindowName, showOnScreens,
    type ScreenBounds, type ScreenContent, type ScreenSetup, type ScreenStore, type ScreenTarget, type ScreensRun, type Stored, type Written,
  } from './screen-setup.ts'

  let { open = $bindable(false), placing = $bindable(null), store, run, runTitle, scenario, onchange }: {
    open: boolean
    /** The surface the World page asked to show on another screen: the panel then asks which one. */
    placing: WorkspaceSurface | null
    store: ScreenStore
    /** The Run open in this window. */
    run: ScreensRun
    runTitle: string
    /** What a person calls the Run's scenario. */
    scenario: string
    /** The stored setup or target changed here, so the page reads them again. */
    onchange: () => void
  } = $props()

  const MINIATURE = { width: 320, height: 120 } as const

  let setup = $state.raw<Stored<ScreenSetup>>({ status: 'absent' })
  let target = $state.raw<Stored<ScreenTarget>>({ status: 'absent' })
  let positions = $state.raw<ReadonlyMap<string, Stored<ScreenBounds>>>(new Map())
  /** The screens whose window answered the roll-call made when the panel opened. */
  let answered = $state.raw<ReadonlySet<string>>(new Set())
  /** What Open did for a screen since the panel opened. */
  let windows = $state.raw<ReadonlyMap<string, 'opened' | 'blocked'>>(new Map())
  let removing = $state<string | null>(null)
  let status = $state('')
  let problem = $state<string | null>(null)
  let rollCall = ''

  const view = $derived(setup.status === 'ok' ? setup.value : setup.status === 'absent' ? EMPTY_SCREEN_SETUP : null)
  const assignment = $derived(view === null ? {} : assignmentFor(view, run.definition))
  const carried = $derived(view !== null && !hasStoredAssignment(view, run.definition) && Object.keys(assignment).length > 0)
  const targetWritable = $derived(target.status === 'ok' || target.status === 'absent')
  const targetLine = $derived(target.status === 'absent' ? 'Nothing has been shown on the screens yet.'
    : target.status !== 'ok' ? '' : isTarget(target, run) ? 'The screens show this Run.' : 'The screens show another Run.')
  const placed = $derived((view?.screens ?? []).flatMap(screen => {
    const position = positions.get(screen.id)
    return position?.status === 'ok' ? [{ id: screen.id, bounds: position.value }] : []
  }))
  const rects = $derived(miniature(placed, MINIATURE))

  const read = (): void => {
    setup = store.readSetup()
    target = store.readTarget()
    positions = new Map((setup.status === 'ok' ? setup.value.screens : []).map(screen => [screen.id, store.readBounds(screen.id)]))
  }
  const said = (written: Written, done: string): boolean => {
    problem = written.ok ? null : `Not saved: ${written.reason}`
    status = written.ok ? done : ''
    return written.ok
  }
  const save = (next: ScreenSetup, done: string): boolean => {
    const saved = said(store.writeSetup(next), done)
    read()
    onchange()
    return saved
  }

  $effect(() => {
    if (!open) return
    untrack(() => {
      status = ''
      problem = null
      removing = null
      answered = new Set()
      windows = new Map()
      read()
      // A browser without screens has no window to ask, and keeps no trace of having looked.
      rollCall = newStamp()
      if (setup.status === 'ok' && setup.value.screens.length > 0) store.call('roll-call', rollCall)
    })
  })

  const onstorage = (event: StorageEvent): void => {
    if (!open) return
    const change = screenStorageChange(event.key)
    if (change === null) return
    if (change.kind === 'answer') {
      if (event.newValue === rollCall) answered = new Set(answered).add(change.screenId)
      return
    }
    if (change.kind === 'roll-call' || change.kind === 'identify') return
    read()
  }

  const add = (): void => {
    if (view === null) return
    const added = addScreen(view)
    if (added !== null) save(added.setup, `Screen ${added.id} added.`)
  }
  const rename = (screenId: string, input: HTMLInputElement, current: string): void => {
    if (view === null) return
    const named = screenName(input.value)
    if ('refused' in named) {
      problem = named.refused
      input.value = current
      return
    }
    input.value = named.name
    if (named.name !== current) save(renameScreen(view, screenId, named.name), `Screen ${screenId} is now called ${named.name}.`)
  }
  const remove = (screenId: string): void => {
    removing = null
    if (view === null) return
    if (!save(removeScreen(view, screenId), `Screen ${screenId} removed.`)) return
    store.forgetScreen(screenId)
    read()
  }
  const show = (screenId: string, choice: string): void => {
    if (view === null || choice === 'surface') return
    save(assign(view, run.definition, screenId, choice === 'run' ? { kind: 'run' } : null),
      choice === 'run' ? `Screen ${screenId} shows the map.` : `Screen ${screenId} shows nothing.`)
  }

  const showRun = (): void => {
    said(showOnScreens(store, run), `The screens now show ${runTitle}.`)
    read()
    onchange()
  }
  const identify = (): void => {
    said(store.call('identify', newStamp()), 'Every open screen window shows its letter for a few seconds.')
  }

  // Placing stores the choice for this Run's scenario and points the screens at this Run, so that screen shows it now.
  const place = (onto: string | null): void => {
    if (view === null || placing === null || !targetWritable) return
    const added = onto === null ? addScreen(view) : null
    const screenId = onto ?? added?.id
    if (screenId === undefined) return
    const content: ScreenContent = { kind: 'surface', moduleId: 'world', surface: placing.surface, title: placing.title }
    const title = placing.title
    if (!save(assign(added?.setup ?? view, run.definition, screenId, content), '')) return
    const shown = said(showOnScreens(store, run), `Screen ${screenId} now shows ${title}.${answered.has(screenId) ? '' : ' No window answered for it: press Open.'}`)
    read()
    onchange()
    if (shown) placing = null
  }

  const openWindow = (screenId: string): void => {
    const content = assignment[screenId] ?? null
    const position = positions.get(screenId)
    const opened = window.open(
      screenUrl(run.workspaceId, screenId, content === null ? null : { runId: run.runId, content }),
      screenWindowName(screenId),
      screenWindowFeatures(position?.status === 'ok' ? position.value : null),
    )
    windows = new Map(windows).set(screenId, opened === null ? 'blocked' : 'opened')
  }

  const windowText = (screenId: string): string => {
    const state = windows.get(screenId)
    if (state === 'blocked') return 'Blocked by the browser\'s pop-up setting'
    if (answered.has(screenId)) return 'Window open'
    return state === 'opened' ? 'Opened' : 'No window answered'
  }
  const positionText = (screenId: string): string => {
    const position = positions.get(screenId)
    if (position?.status === 'ok') return `${position.value.width} × ${position.value.height} at ${position.value.x}, ${position.value.y}`
    if (position?.status === 'unreadable') return `Stored position unreadable (${position.reason})`
    return 'No position reported yet'
  }
  const reset = (what: 'setup' | 'target'): void => {
    said(what === 'setup' ? store.resetSetup() : store.resetTarget(), what === 'setup' ? 'The screen setup was reset.' : 'What the screens show was reset.')
    read()
    onchange()
  }
</script>

<svelte:window {onstorage} />

<Modal bind:open title="Screens" eyebrow="This browser" width="760px" onclose={() => { placing = null }}>
  <div class="screens-panel">
    {#if setup.status === 'unavailable'}
      <p class="screens-problem" role="alert">Screens need this browser's storage, and this page cannot use it ({setup.reason}). Nothing is set up and nothing was changed.</p>
    {:else}
      <p class="screens-intro">A screen is a browser window on this computer with a letter and a name. The setup is remembered in this browser only, for every Workspace.</p>
      {#if setup.status === 'unreadable'}
        <div class="screens-problem" role="alert">
          <p>The stored screen setup cannot be read ({setup.reason}). It was left as it is.</p>
          <button class="lb-btn lb-btn-sm" type="button" onclick={() => reset('setup')}>Reset screen setup</button>
        </div>
      {/if}
      {#if target.status === 'unreadable'}
        <div class="screens-problem" role="alert">
          <p>The stored record of what the screens show cannot be read ({target.reason}). It was left as it is.</p>
          <button class="lb-btn lb-btn-sm" type="button" onclick={() => reset('target')}>Reset what the screens show</button>
        </div>
      {/if}
      {#if view !== null}
        {#if placing !== null}
          <div class="screens-placing">
            <p>Show <strong>{placing.title}</strong> on which screen?</p>
            <button class="lb-btn lb-btn-sm" type="button" disabled={!targetWritable || view.screens.length >= 26} onclick={() => place(null)}><Icon name="plus" size={16} />New screen</button>
            <button class="lb-btn lb-btn-sm lb-btn-quiet" type="button" onclick={() => { placing = null }}>Cancel</button>
          </div>
        {/if}
        {#if rects.length > 0}
          <figure class="screens-miniature">
            <svg viewBox={`0 0 ${MINIATURE.width} ${MINIATURE.height}`} role="img" aria-label={`Where the screen windows were last: ${placed.map(({ id }) => `${id} ${positionText(id)}`).join('; ')}`}>
              {#each rects as rect (rect.id)}
                <rect x={rect.x + 1} y={rect.y + 1} width={Math.max(rect.width - 2, 1)} height={Math.max(rect.height - 2, 1)} rx="3" />
                <text x={rect.x + rect.width / 2} y={rect.y + rect.height / 2} dominant-baseline="central" text-anchor="middle">{rect.id}</text>
              {/each}
            </svg>
            <figcaption>Where each screen window was when it last reported, and how big.</figcaption>
          </figure>
        {/if}
        <h3 class="screens-heading">What each screen shows for {scenario}</h3>
        {#if carried}<p class="screens-note">Nothing is stored for this scenario yet, so it starts from the last one set up. Only the map and the Run dashboard carry over.</p>{/if}
        {#if view.screens.length === 0}
          <p class="screens-note">No screens yet. Add one, then open its window and drag it to the display it belongs on.</p>
        {:else}
          <ul class="screens-rows" aria-label={`Screens (${view.screens.length})`}>
            {#each view.screens as screen (screen.id)}
              {@const content = assignment[screen.id] ?? null}
              <li>
                <span class="screens-letter" aria-hidden="true">{screen.id}</span>
                <div class="screens-fields">
                  <input class="lb-input" type="text" aria-label={`Name of screen ${screen.id}`} value={screen.name} maxlength={SCREEN_NAME_MAX_LENGTH} autocomplete="off"
                    onchange={event => rename(screen.id, event.currentTarget, screen.name)} />
                  <select class="lb-input" aria-label={`What screen ${screen.id} shows`} value={content === null ? 'nothing' : content.kind}
                    onchange={event => show(screen.id, event.currentTarget.value)}>
                    <option value="nothing">Nothing</option>
                    <option value="run">Map</option>
                    {#if content?.kind === 'surface'}<option value="surface">{content.title}</option>{/if}
                  </select>
                  <span class="screens-meta"><span class:blocked={windows.get(screen.id) === 'blocked'} class:present={answered.has(screen.id)}>{windowText(screen.id)}</span><span>{positionText(screen.id)}</span></span>
                </div>
                {#if removing === screen.id}
                  <div class="screens-confirm" role="group" aria-label={`Remove screen ${screen.id}`}>
                    <span>Remove screen {screen.id} and what it shows in every scenario?</span>
                    <button class="lb-btn lb-btn-sm lb-btn-danger" type="button" onclick={() => remove(screen.id)}>Remove</button>
                    <button class="lb-btn lb-btn-sm" type="button" onclick={() => { removing = null }}>Keep</button>
                  </div>
                {:else}
                  <div class="screens-actions">
                    {#if placing !== null}<button class="lb-btn lb-btn-sm lb-btn-primary" type="button" disabled={!targetWritable} aria-label={`Show ${placing.title} on screen ${screen.id}`} onclick={() => place(screen.id)}>Show here</button>{/if}
                    <button class="lb-btn lb-btn-sm" type="button" aria-label={`Open the window of screen ${screen.id}`} onclick={() => openWindow(screen.id)}>Open</button>
                    <button class="lb-icon-btn" type="button" aria-label={`Remove screen ${screen.id}`} title={`Remove screen ${screen.id}`} onclick={() => { removing = screen.id }}><Icon name="trash" size={18} /></button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <div><button class="lb-btn lb-btn-sm" type="button" disabled={view.screens.length >= 26} title={view.screens.length >= 26 ? 'All 26 letters are in use' : undefined} onclick={add}><Icon name="plus" size={16} />Add screen</button></div>
      {/if}
      {#if problem}<p class="screens-problem" role="alert">{problem}</p>{/if}
    {/if}
  </div>
  {#snippet footer()}
    <span class="screens-status" role="status">{status || targetLine}</span>
    <button class="lb-btn" type="button" disabled={view === null || view.screens.length === 0} onclick={identify}>Identify</button>
    <button class="lb-btn lb-btn-primary" type="button" disabled={view === null || view.screens.length === 0 || !targetWritable} onclick={showRun}><Icon name="screen" size={16} />Show on screens</button>
  {/snippet}
</Modal>
