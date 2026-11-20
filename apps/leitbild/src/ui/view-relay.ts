import {
  ABOUT_RELATION,
  embeddedViewHostMessageSchema,
  embeddedViewOpenMessageSchema,
  embeddedViewSubjectOpenMessageSchema,
  embeddedViewsMessageSchema,
  embeddedViewWindowMaximiseMessageSchema,
  embeddedViewWindowReadyMessageSchema,
  type EmbeddedViewHostMessage,
  type EmbeddedViewListing,
  type EmbeddedViewOpenMessage,
  type EmbeddedViewSubjectOpenMessage,
  type EmbeddedViewsMessage,
  type ModuleResourceDescriptor,
  type WorkspaceResourceReference,
} from '@leitbild/contracts'
import type { ZodError } from 'zod'

// The Host relays the one process display window's messages between the
// Agents frame, which lists the displays its answers composed and asks for one
// to be opened (or a subject's default display, as a proposal card does), and
// the World frame, whose page shows the Run's window. Views about other
// Resources open in a Host frame at their owning Module's embed route; they
// do not require or select a World Run. One such view opens in the window
// instead: a view whose subject the Workspace's catalogue links as about the
// Run the World pane shows, so it appears over what it is about. While the
// Run's plans show in place of its simulation, the World pane is not shown:
// a view about another Resource opens in a Host frame, and a view of a Run
// brings the simulation back and opens in its window. The relay is
// the only validator on that path: every message is parsed with its contract
// schema and must name this page's Workspace, and every refusal is reported
// where the operator sees it. It keeps only the latest list, whether the World
// document listens, at most one open waiting for it, and the opens that wait
// while the catalogue is read again; it never reads a view's state. What it
// posts is freshly parsed plain data, never UI state.

/** How long an open waits for the World page to listen before it is reported as failed. */
export const PENDING_VIEW_OPEN_MS = 30_000

/**
 * The World pane beside the chat: none (chat only), behind the Run's plans
 * (its document loaded, the plans shown in its place), collapsed by the split,
 * or shown.
 */
export type WorldPane = 'absent' | 'behind-plans' | 'collapsed' | 'shown'

// The contract's window messages share this prefix. Other messages from the
// two frames are not part of the window's protocol and are not judged here.
const VIEW_MESSAGE_PREFIX = 'leitbild:view'

const sameResource = (a: WorkspaceResourceReference, b: WorkspaceResourceReference): boolean =>
  a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id

const viewMessageType = (data: unknown): string | null => {
  if (typeof data !== 'object' || data === null) return null
  const type = (data as { readonly type?: unknown }).type
  return typeof type === 'string' && type.startsWith(VIEW_MESSAGE_PREFIX) ? type : null
}

/** The first schema issue and where it is, short enough for the error banner. */
export const firstIssue = (error: ZodError): string => {
  const issue = error.issues[0]
  if (issue === undefined) return error.message
  return issue.path.length === 0 ? issue.message : `${issue.path.map(String).join('.')}: ${issue.message}`
}

/** What opens the window: a listed view, or a subject's default display (Q23). */
type WindowOpen = EmbeddedViewOpenMessage | EmbeddedViewSubjectOpenMessage

export const createViewRelay = (config: {
  /** The Workspace this page shows; a view of any other Workspace is refused. */
  readonly workspaceId: () => string
  readonly worldPane: () => WorldPane
  /** The Run the World pane shows, collapsed or not; null without that pane. */
  readonly shownRun: () => WorkspaceResourceReference | null
  /** The Workspace's Resources as the Host last read them. The relay reads only each one's links. */
  readonly resources: () => ReadonlyArray<Pick<ModuleResourceDescriptor, 'ref' | 'links'>>
  /**
   * Reads the Workspace's Resources again, so that `resources` answers with
   * what the Workspace lists now; it rejects when they could not be read. The
   * relay asks once for a view whose subject is not listed (an agent may just
   * have created it), and never fetches anything itself.
   */
  readonly refreshResources: () => Promise<void>
  /**
   * Why the Run may not be opened beside the chat, or null when it may: the
   * Workspace must list it (after reading the catalog again on a miss, since
   * an agent may just have started it) and the shown room's scope contain it.
   */
  readonly runRefusal: (run: WorkspaceResourceReference) => Promise<string | null>
  readonly postToWorld: (message: EmbeddedViewsMessage | WindowOpen) => void
  readonly postToAgents: (message: EmbeddedViewHostMessage) => void
  /** Brings a collapsed World pane back beside the chat, or the Run's simulation back in place of its plans. */
  readonly showWorld: () => void
  /** The window asks for the whole Workspace area (true) or for the split back (false). */
  readonly maximiseWorld: (maximised: boolean) => void
  /** Opens the Run in a World pane beside the chat, as switching Runs does. */
  readonly openRun: (runId: string) => void
  /** Frames an owner-published view without selecting a Run; null closes that frame. State stays opaque. */
  readonly openOwnedView: (view: EmbeddedViewListing | null) => void
  readonly reportError: (message: string) => void
  /** Calls `expire` after `ms` unless the returned cancel runs first. */
  readonly startTimer: (ms: number, expire: () => void) => () => void
}) => {
  // The latest list of the current Agents document, oldest first.
  let views: ReadonlyArray<EmbeddedViewListing> = []
  // Whether the current World document said it listens.
  let worldListening = false
  // The one open that waits for a World document to listen; a later open replaces it.
  let pending: { readonly open: WindowOpen; readonly cancel: () => void } | null = null
  // Counts opens, so a Run check still running for an earlier one does nothing.
  let openSequence = 0
  // While the catalogue is read again: the opens that wait for it, in arrival order. Null when no read is running.
  let held: { readonly opens: Array<() => void>; readonly cancel: () => void } | null = null

  const viewsMessage = (): EmbeddedViewsMessage => embeddedViewsMessageSchema.parse({ type: 'leitbild:views', views })
  const openMessage = (view: EmbeddedViewListing): EmbeddedViewOpenMessage =>
    embeddedViewOpenMessageSchema.parse({ type: 'leitbild:view-open', view })

  const foreign = (view: EmbeddedViewListing): boolean => view.envelope.subject.workspaceId !== config.workspaceId()

  const dropPending = (): void => {
    pending?.cancel()
    pending = null
  }

  const dropHeld = (): void => {
    held?.cancel()
    held = null
  }

  const closeOpens = (): void => {
    openSequence += 1
    dropPending()
    dropHeld()
    config.openOwnedView(null)
  }

  // One read of the catalogue for the open that needs it. Opens that arrive
  // meanwhile wait behind it and are handled in arrival order once it settles,
  // so none is lost, none acts before an earlier one, and none starts a second
  // read. A read that fails, or does not answer within the open's wait budget,
  // is reported, and the waiting opens are then judged by the catalogue as held.
  const readCatalogueAgainThen = (first: () => void): void => {
    const opens = [first]
    const settle = (problem: string | null): void => {
      if (held?.opens !== opens) return
      dropHeld()
      if (problem !== null) config.reportError(`Display opened in its own frame, not in the Run's window: ${problem}`)
      for (const act of opens) act()
    }
    held = { opens, cancel: config.startTimer(PENDING_VIEW_OPEN_MS, () => settle(`the Workspace's resources were not read again within ${PENDING_VIEW_OPEN_MS / 1_000} s`)) }
    void readCatalogueAgain(settle)
  }

  const readCatalogueAgain = async (settle: (problem: string | null) => void): Promise<void> => {
    try {
      await config.refreshResources()
    } catch (error) {
      return settle(`the Workspace's resources could not be read again: ${error instanceof Error ? error.message : String(error)}`)
    }
    settle(null)
  }

  // A view whose subject is not a Run. It opens in the window of the Run the
  // World pane shows where the catalogue links its subject as about that Run,
  // and in a Host frame otherwise. A subject the catalogue does not list may
  // have been created since the Host last read it, so the catalogue is read
  // again, once, before the rule is applied. A subject still unlisted after
  // that read, or after a failed one, opens in the Host frame: that is where
  // every view that is not about the shown Run opens, with the view shown, not
  // a fallback that hides a failure. Behind the Run's plans the World pane
  // shows no Run, so such a view opens in a Host frame over the plans.
  const openOwned = (view: EmbeddedViewListing, readAgain: boolean): void => {
    const pane = config.worldPane()
    const run = pane === 'shown' || pane === 'collapsed' ? config.shownRun() : null
    const listed = run === null ? undefined : config.resources().find(resource => sameResource(resource.ref, view.envelope.subject))
    if (run !== null && listed === undefined && readAgain) return readCatalogueAgainThen(() => openOwned(view, false))
    if (run !== null && listed?.links.some(link => link.rel === ABOUT_RELATION && sameResource(link.ref, run))) return open(openMessage(view), run)
    closeOpens()
    config.openOwnedView(view)
  }

  const openView = (view: EmbeddedViewListing, readAgain: boolean): void => {
    if (view.envelope.subject.moduleId !== 'world' || view.envelope.subject.type !== 'world.simulation-run') return openOwned(view, readAgain)
    open(openMessage(view), view.envelope.subject)
  }

  const keepPending = (open: WindowOpen): void => {
    dropPending()
    const cancel = config.startTimer(PENDING_VIEW_OPEN_MS, () => {
      pending = null
      config.reportError(`Display could not be opened: the World page did not answer within ${PENDING_VIEW_OPEN_MS / 1_000} s`)
    })
    pending = { open, cancel }
  }

  const forgetViews = (): void => {
    if (views.length === 0) return
    views = []
    if (worldListening) config.postToWorld(viewsMessage())
  }

  const receiveViews = (data: unknown): void => {
    const parsed = embeddedViewsMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display list refused: ${firstIssue(parsed.error)}`)
    // A display about another Workspace is left out on its own, and said; the rest of the list still goes to World.
    const kept = parsed.data.views.filter(view => !foreign(view))
    const left = parsed.data.views.length - kept.length
    if (left > 0) config.reportError(`Display list: ${left === 1 ? 'a display belongs' : `${left} displays belong`} to another Workspace and ${left === 1 ? 'was' : 'were'} left out`)
    views = kept
    if (worldListening) config.postToWorld(viewsMessage())
  }

  const receiveOpen = (data: unknown): void => {
    const parsed = embeddedViewOpenMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display could not be opened: ${firstIssue(parsed.error)}`)
    const view = parsed.data.view
    if (foreign(view)) return config.reportError('Display could not be opened: it belongs to another Workspace')
    // Behind a running read the open waits its turn, and is then judged by the catalogue that read brought.
    if (held !== null) return void held.opens.push(() => openView(view, false))
    openView(view, true)
  }

  // A subject's default display (a proposal's element) is relayed exactly as an open: the same Workspace and Run checks, the same refusals.
  const receiveSubjectOpen = (data: unknown): void => {
    const parsed = embeddedViewSubjectOpenMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display could not be opened: ${firstIssue(parsed.error)}`)
    if (parsed.data.resource.workspaceId !== config.workspaceId()) return config.reportError('Display could not be opened: it belongs to another Workspace')
    const message = parsed.data
    if (held !== null) return void held.opens.push(() => open(message, message.resource))
    open(message, message.resource)
  }

  const open = (message: WindowOpen, run: WorkspaceResourceReference): void => {
    const sequence = ++openSequence
    config.openOwnedView(null)
    if (config.worldPane() === 'absent') return void openBesideChat(message, run, sequence)
    deliver(message)
  }

  const deliver = (message: WindowOpen): void => {
    // A shown World pane keeps its Run: the window shows a display of another Run as it is.
    // Behind the Run's plans its document is loaded: the simulation comes back, with no reload.
    const pane = config.worldPane()
    if (pane === 'collapsed' || pane === 'behind-plans') config.showWorld()
    if (!worldListening) return keepPending(message)
    dropPending()
    config.postToWorld(message)
  }

  // Chat only: open the display's Run beside the chat, then show the display
  // once its World page listens. A Run that may not be opened there is refused
  // visibly, never opened in a way that closes the chat.
  const openBesideChat = async (message: WindowOpen, run: WorkspaceResourceReference, sequence: number): Promise<void> => {
    let refusal: string | null
    try {
      refusal = await config.runRefusal(run)
    } catch (error) {
      refusal = `Display could not be opened: ${error instanceof Error ? error.message : String(error)}`
    }
    if (sequence !== openSequence) return
    if (refusal !== null) return config.reportError(refusal)
    // A World pane opened meanwhile shows the display as any open would.
    if (config.worldPane() !== 'absent') return deliver(message)
    keepPending(message)
    config.openRun(run.id)
  }

  const receiveReady = (data: unknown): void => {
    const parsed = embeddedViewWindowReadyMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display window message refused: ${firstIssue(parsed.error)}`)
    worldListening = true
    config.postToWorld(viewsMessage())
    if (pending === null) return
    const { open: waiting } = pending
    dropPending()
    config.postToWorld(waiting)
  }

  const receiveMaximise = (data: unknown): void => {
    const parsed = embeddedViewWindowMaximiseMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display window message refused: ${firstIssue(parsed.error)}`)
    config.maximiseWorld(parsed.data.maximised)
  }

  return {
    /** A message whose source is the Agents frame's window. */
    fromAgents: (data: unknown): void => {
      const type = viewMessageType(data)
      if (type === null) return
      if (type === 'leitbild:views') return receiveViews(data)
      if (type === 'leitbild:view-open') return receiveOpen(data)
      if (type === 'leitbild:view-subject-open') return receiveSubjectOpen(data)
      config.reportError(`Display message refused: the Agents page does not send ${type}`)
    },
    /** A message whose source is the World frame's window. */
    fromWorld: (data: unknown): void => {
      const type = viewMessageType(data)
      if (type === null) return
      if (type === 'leitbild:view-window-ready') return receiveReady(data)
      if (type === 'leitbild:view-window-maximise') return receiveMaximise(data)
      config.reportError(`Display message refused: the World page does not send ${type}`)
    },
    /**
     * A new Agents document finished loading: its list starts empty, and it
     * learns that a Host relays what it lists and opens.
     */
    agentsFrameLoaded: (): void => {
      closeOpens()
      forgetViews()
      config.postToAgents(embeddedViewHostMessageSchema.parse({ type: 'leitbild:view-host' }))
    },
    /** The Agents frame shows another Room or closed: its displays leave the window's list. */
    agentsFrameUnloaded: (): void => {
      closeOpens()
      forgetViews()
    },
    /**
     * The World frame shows another Run or closed. Its next document listens
     * only once it says so, and its window starts unmaximised. A pending open
     * stays for that document or expires.
     */
    worldFrameUnloaded: (): void => {
      worldListening = false
      config.maximiseWorld(false)
    },
    dispose: closeOpens,
  }
}

export type ViewRelay = ReturnType<typeof createViewRelay>
