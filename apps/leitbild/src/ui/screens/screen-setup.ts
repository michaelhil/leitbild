// Screens: this browser's screen setup. A Screen is a browser window on this
// computer with a letter and a name; it is a normal Workspace page with
// `screen=<id>` in its address. What is remembered lives in localStorage on the
// Host origin, in three kinds of key with one writer each:
//
// - `leitbild:screens:setup`: the screens and what each shows per scenario.
//   Written only by the Screens panel (which is also the screen picker).
// - `leitbild:screens:target`: the Run the screens show now. Written only by
//   the "Show on screens" press and by placing a surface on a screen.
// - `leitbild:screens:bounds:<id>`: where that screen's window is and how big.
//   Written only by that window.
//
// Roll-call and Identify are stamps beside them: the panel writes a stamp, a
// screen window answers a roll-call by writing the same stamp under its id.
//
// Rules this file keeps:
// - Every stored value is parsed strictly. An unreadable value is a reported
//   state (`unreadable`), never silently replaced; storage that is missing or
//   throws is `unavailable`, and then nothing is written.
// - Nothing here names or chooses a Workspace for a page. The target names
//   one, and screen-follow.ts decides what a window may do with it.
// - A surface string is World's. The Host stores and forwards it whole and
//   never reads into it.

import { z } from 'zod'
import { workspaceSurfaceStringSchema } from '@leitbild/contracts'
import { workspaceUrl } from '../launch-destination.ts'
import { firstIssue } from '../view-relay.ts'

export const SCREEN_SETUP_KEY = 'leitbild:screens:setup'
export const SCREEN_TARGET_KEY = 'leitbild:screens:target'
export const SCREEN_BOUNDS_KEY_PREFIX = 'leitbild:screens:bounds:'
export const SCREEN_ROLL_CALL_KEY = 'leitbild:screens:roll-call'
export const SCREEN_IDENTIFY_KEY = 'leitbild:screens:identify'
export const SCREEN_ANSWER_KEY_PREFIX = 'leitbild:screens:answer:'

/** A Run that was not started from a Definition; all such Runs share one assignment. */
export const NO_DEFINITION_KEY = 'none'
export const SCREEN_NAME_MAX_LENGTH = 40

const SCREEN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export const screenIdSchema = z.string().regex(/^[A-Z]$/, 'A screen id is one capital letter')
const screenNameSchema = z.string().min(1).max(SCREEN_NAME_MAX_LENGTH)
const definitionKeySchema = z.string().min(1).max(400)

export const screenContentSchema = z.discriminatedUnion('kind', [
  /** The Run's page (the map). */
  z.object({ kind: z.literal('run') }).strict(),
  z.object({
    kind: z.literal('surface'),
    moduleId: z.literal('world'),
    surface: workspaceSurfaceStringSchema,
    title: z.string().min(1).max(120),
  }).strict(),
])
export type ScreenContent = z.infer<typeof screenContentSchema>

export const screenSetupSchema = z.object({
  screens: z.array(z.object({ id: screenIdSchema, name: screenNameSchema }).strict()).max(SCREEN_LETTERS.length),
  contentByDefinition: z.record(definitionKeySchema, z.record(screenIdSchema, screenContentSchema)),
  lastDefinition: definitionKeySchema.nullable(),
}).strict().superRefine((setup, ctx) => {
  const seen = new Set<string>()
  setup.screens.forEach((screen, index) => {
    if (seen.has(screen.id)) ctx.addIssue({ code: 'custom', path: ['screens', index, 'id'], message: `Screen ${screen.id} is listed twice` })
    seen.add(screen.id)
  })
})
export type ScreenSetup = z.infer<typeof screenSetupSchema>
export type Screen = ScreenSetup['screens'][number]

export const screenTargetSchema = z.object({
  workspaceId: z.uuid(),
  runId: z.string().min(1).max(128),
  definition: definitionKeySchema,
  /** Changes with every press, so a repeated press still reaches the screen windows. */
  stamp: z.string().min(1).max(64),
}).strict()
export type ScreenTarget = z.infer<typeof screenTargetSchema>

export const screenBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict()
export type ScreenBounds = z.infer<typeof screenBoundsSchema>

export const EMPTY_SCREEN_SETUP: ScreenSetup = { screens: [], contentByDefinition: {}, lastDefinition: null }

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type ScreenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type Stored<T> =
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly value: T }
  /** The key holds something this version cannot read. It stays as it is until the person resets it. */
  | { readonly status: 'unreadable'; readonly reason: string }
  /** The browser offers no storage here (private mode, blocked site data). */
  | { readonly status: 'unavailable'; readonly reason: string }

export type Written = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface ScreenStore {
  readSetup(): Stored<ScreenSetup>
  writeSetup(setup: ScreenSetup): Written
  resetSetup(): Written
  readTarget(): Stored<ScreenTarget>
  writeTarget(target: ScreenTarget): Written
  resetTarget(): Written
  readBounds(screenId: string): Stored<ScreenBounds>
  writeBounds(screenId: string, bounds: ScreenBounds): Written
  /** A removed screen leaves no position or roll-call answer behind for the next screen with its letter. */
  forgetScreen(screenId: string): Written
  /** The panel asks every screen window to answer (`roll-call`) or to show its letter (`identify`). */
  call(kind: 'roll-call' | 'identify', stamp: string): Written
  /** A screen window answers the roll-call that carried this stamp. */
  answer(screenId: string, stamp: string): Written
}

const NO_STORAGE = 'this browser offers no storage to this page'
const reasonOf = (cause: unknown): string => cause instanceof Error && cause.message !== '' ? cause.message : String(cause)

export const createScreenStore = (storage: ScreenStorage | null): ScreenStore => {
  const read = <T>(key: string, schema: z.ZodType<T>): Stored<T> => {
    if (storage === null) return { status: 'unavailable', reason: NO_STORAGE }
    let raw: string | null
    try { raw = storage.getItem(key) } catch (cause) { return { status: 'unavailable', reason: reasonOf(cause) } }
    if (raw === null) return { status: 'absent' }
    let value: unknown
    try { value = JSON.parse(raw) } catch { return { status: 'unreadable', reason: 'it is not JSON' } }
    const parsed = schema.safeParse(value)
    return parsed.success ? { status: 'ok', value: parsed.data } : { status: 'unreadable', reason: firstIssue(parsed.error) }
  }
  const attempt = (action: (storage: ScreenStorage) => void): Written => {
    if (storage === null) return { ok: false, reason: NO_STORAGE }
    try { action(storage) } catch (cause) { return { ok: false, reason: reasonOf(cause) } }
    return { ok: true }
  }
  const write = <T>(key: string, schema: z.ZodType<T>, value: T): Written => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return { ok: false, reason: firstIssue(parsed.error) }
    return attempt(target => target.setItem(key, JSON.stringify(parsed.data)))
  }
  return {
    readSetup: () => read(SCREEN_SETUP_KEY, screenSetupSchema),
    writeSetup: setup => write(SCREEN_SETUP_KEY, screenSetupSchema, setup),
    resetSetup: () => attempt(target => target.removeItem(SCREEN_SETUP_KEY)),
    readTarget: () => read(SCREEN_TARGET_KEY, screenTargetSchema),
    writeTarget: target => write(SCREEN_TARGET_KEY, screenTargetSchema, target),
    resetTarget: () => attempt(target => target.removeItem(SCREEN_TARGET_KEY)),
    readBounds: screenId => read(`${SCREEN_BOUNDS_KEY_PREFIX}${screenId}`, screenBoundsSchema),
    writeBounds: (screenId, bounds) => write(`${SCREEN_BOUNDS_KEY_PREFIX}${screenId}`, screenBoundsSchema, bounds),
    forgetScreen: screenId => attempt(target => {
      target.removeItem(`${SCREEN_BOUNDS_KEY_PREFIX}${screenId}`)
      target.removeItem(`${SCREEN_ANSWER_KEY_PREFIX}${screenId}`)
    }),
    call: (kind, stamp) => attempt(target => target.setItem(kind === 'roll-call' ? SCREEN_ROLL_CALL_KEY : SCREEN_IDENTIFY_KEY, stamp)),
    answer: (screenId, stamp) => attempt(target => target.setItem(`${SCREEN_ANSWER_KEY_PREFIX}${screenId}`, stamp)),
  }
}

/** The page's store. Reading `localStorage` itself can throw, so it is guarded too. */
export const browserScreenStore = (): ScreenStore => {
  let storage: ScreenStorage | null
  try { storage = globalThis.localStorage ?? null } catch { storage = null }
  return createScreenStore(storage)
}

export type ScreenStorageChange =
  | { readonly kind: 'setup' | 'target' | 'roll-call' | 'identify' }
  | { readonly kind: 'bounds' | 'answer'; readonly screenId: string }
  /** The whole storage was cleared (`key` is null). */
  | { readonly kind: 'cleared' }

/** What a `storage` event's key means to Screens, or null when it is someone else's key. */
export const screenStorageChange = (key: string | null): ScreenStorageChange | null => {
  if (key === null) return { kind: 'cleared' }
  if (key === SCREEN_SETUP_KEY) return { kind: 'setup' }
  if (key === SCREEN_TARGET_KEY) return { kind: 'target' }
  if (key === SCREEN_ROLL_CALL_KEY) return { kind: 'roll-call' }
  if (key === SCREEN_IDENTIFY_KEY) return { kind: 'identify' }
  for (const [prefix, kind] of [[SCREEN_BOUNDS_KEY_PREFIX, 'bounds'], [SCREEN_ANSWER_KEY_PREFIX, 'answer']] as const) {
    if (!key.startsWith(prefix)) continue
    const screenId = screenIdSchema.safeParse(key.slice(prefix.length))
    return screenId.success ? { kind, screenId: screenId.data } : null
  }
  return null
}

let stampCount = 0
/** A value no earlier press in this browser had: the time, a count within this page, and chance across pages. */
export const newStamp = (): string => `${Date.now().toString(36)}-${(stampCount++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// ---------------------------------------------------------------------------
// The setup: screens
// ---------------------------------------------------------------------------

/** The next free letter, or null when all 26 are taken. */
export const nextScreenId = (setup: ScreenSetup): string | null =>
  [...SCREEN_LETTERS].find(letter => !setup.screens.some(screen => screen.id === letter)) ?? null

/** The name a new screen starts with. */
const defaultScreenName = (screenId: string): string => `Screen ${screenId}`

export const addScreen = (setup: ScreenSetup): { readonly setup: ScreenSetup; readonly id: string } | null => {
  const id = nextScreenId(setup)
  if (id === null) return null
  return { id, setup: { ...setup, screens: [...setup.screens, { id, name: defaultScreenName(id) }] } }
}

/** A screen in one line: "Screen B · Left wall", or "Screen B" alone while it has no name of its own. */
export const screenLabel = (screenId: string, name: string | null): string =>
  name === null || name === defaultScreenName(screenId) ? defaultScreenName(screenId) : `${defaultScreenName(screenId)} · ${name}`

/** The name as it would be stored, or why it cannot be one. */
export const screenName = (text: string): { readonly name: string } | { readonly refused: string } => {
  const name = text.trim().replace(/\s+/g, ' ')
  if (name === '') return { refused: 'A screen needs a name.' }
  if (name.length > SCREEN_NAME_MAX_LENGTH) return { refused: `A screen name has at most ${SCREEN_NAME_MAX_LENGTH} characters.` }
  return { name }
}

export const renameScreen = (setup: ScreenSetup, screenId: string, name: string): ScreenSetup =>
  ({ ...setup, screens: setup.screens.map(screen => screen.id === screenId ? { ...screen, name } : screen) })

/** Removes the screen and what it shows in every scenario. */
export const removeScreen = (setup: ScreenSetup, screenId: string): ScreenSetup => ({
  ...setup,
  screens: setup.screens.filter(screen => screen.id !== screenId),
  contentByDefinition: Object.fromEntries(Object.entries(setup.contentByDefinition).map(([definition, assignment]) =>
    [definition, Object.fromEntries(Object.entries(assignment).filter(([id]) => id !== screenId))])),
})

// ---------------------------------------------------------------------------
// The setup: what each screen shows per scenario
// ---------------------------------------------------------------------------

// A scenario with no stored assignment starts from the last one used, but
// only with what exists in every scenario: the Run's page, and World's one
// surface that names no object. The string is compared whole, never read into.
const SURFACE_IN_EVERY_SCENARIO = 'display:dashboard'
const carriesOver = (content: ScreenContent): boolean => content.kind === 'run' || content.surface === SURFACE_IN_EVERY_SCENARIO

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined

/** Whether this scenario has an assignment of its own (possibly an empty one). */
export const hasStoredAssignment = (setup: ScreenSetup, definition: string): boolean => own(setup.contentByDefinition, definition) !== undefined

/** What the screens show for a scenario: its stored assignment, else what carries over from the last one used. */
export const assignmentFor = (setup: ScreenSetup, definition: string): Readonly<Record<string, ScreenContent>> => {
  const stored = own(setup.contentByDefinition, definition)
  if (stored !== undefined) return stored
  const last = setup.lastDefinition === null ? undefined : own(setup.contentByDefinition, setup.lastDefinition)
  return last === undefined ? {} : Object.fromEntries(Object.entries(last).filter(([, content]) => carriesOver(content)))
}

/** What one screen shows for a scenario, or null when nothing is assigned or the setup has no such screen. */
export const contentFor = (setup: ScreenSetup, definition: string, screenId: string): ScreenContent | null =>
  setup.screens.some(screen => screen.id === screenId) ? own(assignmentFor(setup, definition), screenId) ?? null : null

/**
 * Stores what a screen shows for a scenario (null: nothing). The scenario
 * then has an assignment of its own, starting from what the panel showed for
 * it, and becomes the last one used.
 */
export const assign = (setup: ScreenSetup, definition: string, screenId: string, content: ScreenContent | null): ScreenSetup => {
  const assignment = Object.fromEntries(Object.entries(assignmentFor(setup, definition)).filter(([id]) => id !== screenId))
  return {
    ...setup,
    contentByDefinition: { ...setup.contentByDefinition, [definition]: content === null ? assignment : { ...assignment, [screenId]: content } },
    lastDefinition: definition,
  }
}

// ---------------------------------------------------------------------------
// The Run and its scenario
// ---------------------------------------------------------------------------

interface DefinitionIdentity { readonly moduleId: string; readonly type: string; readonly id: string }

/** The scenario a Run belongs to: its source Definition without the revision, so an edited scenario keeps its screens. */
export const definitionKeyOf = (run: { readonly sourceDefinition?: DefinitionIdentity | undefined }): string =>
  run.sourceDefinition === undefined ? NO_DEFINITION_KEY : `${run.sourceDefinition.moduleId}:${run.sourceDefinition.type}:${run.sourceDefinition.id}`

/** What a person calls the scenario behind a definition key. */
export const scenarioTitle = (definition: string, definitions: ReadonlyArray<{ readonly ref: DefinitionIdentity; readonly title: string }>): string => {
  if (definition === NO_DEFINITION_KEY) return 'Runs without a scenario'
  return definitions.find(candidate => definitionKeyOf({ sourceDefinition: candidate.ref }) === definition)?.title ?? 'this scenario'
}

/** The Run open in a window, as Screens needs it. */
export interface ScreensRun {
  readonly workspaceId: string
  readonly runId: string
  readonly definition: string
}

/** The "Show on screens" press: the screens now show this Run. */
export const showOnScreens = (store: ScreenStore, run: ScreensRun, stamp: () => string = newStamp): Written =>
  store.writeTarget({ workspaceId: run.workspaceId, runId: run.runId, definition: run.definition, stamp: stamp() })

export const isTarget = (target: Stored<ScreenTarget>, run: ScreensRun): boolean =>
  target.status === 'ok' && target.value.workspaceId === run.workspaceId && target.value.runId === run.runId

/** The Run bar offers "Show on screens" only when this browser has a screen and the screens do not show this Run. */
export const offersShowOnScreens = (setup: Stored<ScreenSetup>, target: Stored<ScreenTarget>, run: ScreensRun): boolean =>
  setup.status === 'ok' && setup.value.screens.length > 0 && target.status !== 'unavailable' && target.status !== 'unreadable' && !isTarget(target, run)

// ---------------------------------------------------------------------------
// Screen windows
// ---------------------------------------------------------------------------

/** The `screen` parameter of a Workspace address: a screen id, none, or a value that is not one. */
export const screenOfAddress = (value: string | null): { readonly id: string | null; readonly refused: string | null } => {
  if (value === null) return { id: null, refused: null }
  const parsed = screenIdSchema.safeParse(value)
  return parsed.success
    ? { id: parsed.data, refused: null }
    : { id: null, refused: 'This address names a screen that is not one (a screen is one capital letter), so the window is shown as a normal one.' }
}

/** The canonical address of a screen window: its Workspace in the path, what it shows in the query. */
export const screenUrl = (workspaceId: string, screenId: string, shown: { readonly runId: string; readonly content: ScreenContent } | null): string =>
  workspaceUrl(workspaceId, shown === null ? { screen: screenId } : {
    world: shown.runId,
    surface: shown.content.kind === 'surface' ? shown.content.surface : null,
    screen: screenId,
  })

/** One name per screen, so a second Open reuses the window this page opened. */
export const screenWindowName = (screenId: string): string => `leitbild-screen-${screenId}`

/** Never `noopener`: a `null` from `window.open` is how a blocked pop-up is told apart. */
export const screenWindowFeatures = (bounds: ScreenBounds | null): string =>
  bounds === null ? 'popup' : `popup,left=${bounds.x},top=${bounds.y},width=${bounds.width},height=${bounds.height}`

/**
 * Opens a screen's window: one `window.open` per call, at the remembered
 * rectangle. The `width`/`height` features size the page area, not the window,
 * so the opened window is then sized to the remembered outer size; otherwise
 * it would grow by the browser's own frame on every reopen. A browser that
 * will not resize the window leaves it as it opened, which is not a failure.
 * A `null` window is a pop-up the browser blocked.
 */
export const openScreenWindow = (
  open: (url: string, name: string, features: string) => Pick<Window, 'resizeTo'> | null,
  screen: { readonly id: string; readonly url: string; readonly bounds: ScreenBounds | null },
): 'opened' | 'blocked' => {
  const opened = open(screen.url, screenWindowName(screen.id), screenWindowFeatures(screen.bounds))
  if (opened === null) return 'blocked'
  if (screen.bounds !== null) {
    try { opened.resizeTo(screen.bounds.width, screen.bounds.height) } catch { /* left as it opened */ }
  }
  return 'opened'
}

type WindowRectangle = Pick<Window, 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'>

/** Where a window is and how big, as it reports about itself. */
export const windowBounds = (source: WindowRectangle): ScreenBounds => ({
  x: Math.round(source.screenX),
  y: Math.round(source.screenY),
  width: Math.round(source.outerWidth),
  height: Math.round(source.outerHeight),
})

/**
 * A screen window's own report of where it is. `report` runs on load, resize
 * and when the page is left. A window that is not shown yet (opened behind
 * another, still being placed) has no size, so there is nothing true to
 * write; the report is then owed, and `shown` (the page became visible or
 * took focus) makes it once. No timer.
 */
export const createBoundsReporter = (store: Pick<ScreenStore, 'writeBounds'>, screenId: string, source: WindowRectangle) => {
  let owed = false
  const report = (): void => {
    const bounds = windowBounds(source)
    owed = bounds.width <= 0 || bounds.height <= 0
    if (!owed) store.writeBounds(screenId, bounds)
  }
  return {
    report,
    shown: (): void => { if (owed) report() },
  }
}

export interface MiniatureRect {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The windows' rectangles scaled together into a box and centred there: which screen is where, what size. */
export const miniature = (
  placed: ReadonlyArray<{ readonly id: string; readonly bounds: ScreenBounds }>,
  box: { readonly width: number; readonly height: number },
): ReadonlyArray<MiniatureRect> => {
  if (placed.length === 0) return []
  const left = Math.min(...placed.map(({ bounds }) => bounds.x))
  const top = Math.min(...placed.map(({ bounds }) => bounds.y))
  const right = Math.max(...placed.map(({ bounds }) => bounds.x + bounds.width))
  const bottom = Math.max(...placed.map(({ bounds }) => bounds.y + bounds.height))
  const scale = Math.min(box.width / (right - left), box.height / (bottom - top))
  const offsetX = (box.width - (right - left) * scale) / 2
  const offsetY = (box.height - (bottom - top) * scale) / 2
  return placed.map(({ id, bounds }) => ({
    id,
    x: offsetX + (bounds.x - left) * scale,
    y: offsetY + (bounds.y - top) * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  }))
}
