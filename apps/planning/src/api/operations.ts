// The nine operations' behaviour (eight here; the World facts query is World's). The UI and the Assistant
// reach these only through Host and module-api.ts, so both take one path. Planning writes nothing in World:
// its only World call is the facts read in refresh. Generate, explain and preview run on the solver port
// (lane S); every status shown is re-checked on the checker port (lane K).
import { z } from 'zod'
import {
  inspectionViewSchema, planningFactsOutputSchema, workspaceResourceReferenceSchema,
  type AccessContext, type InspectionView, type PlanningFactsInput, type PlanningFactsOutput, type WorkspaceId, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { planningError } from '../errors.ts'
import { applyEdits, requireAuthority, type ChangeRecord, type EditOutcome, type StoredActor, type Weakening } from '../plan/edits.ts'
import { definitionRevision, startPlan } from '../definitions/start.ts'
import type { PlanDefinitionsPort } from '../definitions/index.ts'
import { outTogether, readiness, worldSubjects, type ReadinessItem } from '../plan/readiness.ts'
import { refusedStatus, unresolvedStatus, withoutProof } from '../solve/status.ts'
import {
  certificateSchema, certifiedSizeSchema, optionSetSchema, planInputsSchema,
  type CertifiedSize, type Plan, type PlanInputs, type Status, type WorldFactCopy,
} from '../plan/schema.ts'
import type { Edit } from '../plan/edit-schema.ts'
import { assertRevision, type PlanStore, type RevisionGuard } from '../plan/store.ts'
import {
  attentionKind, basisWords, buildSection, clip, datedWords, sizeRefusalWords, weakeningWords, byteLength, changeLines, changeSummary, nameOf, optionWarning, readinessText,
  statusSentence, timeWords, valueWords, type OptionState, type Section, type SectionContext,
} from '../plan/summary.ts'
import type { Grid } from '../time/units.ts'
import {
  explainResultSchema, generateResultSchema, resultLimitBytes, sectionDataSchemas, writeResultSchema,
  type baselineInputSchema, type createInputSchema, type editInputSchema, type explainInputSchema, type generateInputSchema, type readInputSchema, type StatusOut,
} from './contract.ts'

type Option = NonNullable<Plan['options']>['options'][number]
type OptionSet = NonNullable<Plan['options']>
type DatedRow = Option['rows'][number]
export type WriteResult = z.infer<typeof writeResultSchema>
export type GenerateResult = z.infer<typeof generateResultSchema>
export type ExplainResult = z.infer<typeof explainResultSchema>
export type GenerateVariant = NonNullable<z.infer<typeof generateInputSchema>['variants']>[number]

// ───────────── ports ─────────────

/** One finding of the independent checker, as keys and a code; summary.ts words it. */
export interface CheckViolation { readonly code: string; readonly about: readonly string[]; readonly words?: string }

/** What lane K's re-check (check/recheck.ts) answers for a stored option against the current plan. */
export interface RecheckView {
  /** The stored status may be shown with its proof words. */
  readonly usable: boolean
  readonly baselineAllowed: boolean
  readonly reasons: readonly string[]
  /** What to show instead when the stored status cannot be shown. */
  readonly shownAs?: 'unresolved' | 'invalid input'
  /**
   * Goals stored as "proven optimal" whose bound lane K's own verifyBound does not reach, and every later
   * one: they are shown and stored as "best found under budget", never "proven optimal".
   */
  readonly bestFoundGoals: readonly number[]
  readonly violations: ReadonlyArray<CheckViolation & { readonly input?: boolean }>
  readonly certificate?: { readonly proves: boolean; readonly ok: boolean; readonly unverified: readonly string[] }
}

/** Lane K: the plan-level checker. It re-derives every rule from the inputs and trusts nothing in the rows. */
export interface CheckerPort {
  readonly recheck: (plan: Plan, option: Option, formulation: string) => RecheckView
}

/** Lane S: compile, bounds, the Engine in its Worker pool, decode, date, float, status and rank. */
export interface SolverPort {
  readonly certifiedSize: CertifiedSize
  /** Compiler, bounds and engine versions, the grid and the zone data. A stored proof applies only on an equal one. */
  readonly formulation: (grid: Grid) => string
  /**
   * Options for the variants (default: one per method option), ranked. `stored` is the plan's current set:
   * per variant the better of stored and new is kept, so a stop never demotes a valid option.
   */
  readonly generate: (request: {
    readonly inputs: PlanInputs
    readonly inputsRevision: number
    readonly variants: readonly GenerateVariant[] | undefined
    readonly seconds: number
    readonly stored: OptionSet | null
    readonly at: string
    readonly by: StoredActor
    readonly signal: AbortSignal
    /** Who stopped it, once the signal fires: the person (their request ended) or Host (Planning stopping). */
    readonly stoppedByWho?: () => 'person' | 'host' | undefined
  }) => Promise<OptionSet>
  readonly explain: (request: {
    readonly inputs: PlanInputs
    readonly option: Option
    readonly ask: z.infer<typeof explainInputSchema>['ask']
    readonly job: string | undefined
    readonly cursor: string | undefined
  }) => Promise<ExplainResult>
  /** Repairs `option`'s own schedule on the edited inputs (only what the edit forces moves), then checks it. */
  readonly preview: (request: { readonly inputs: PlanInputs; readonly option: Option }) => Promise<{
    readonly rows: readonly DatedRow[]
    readonly violations: readonly CheckViolation[]
    /** Lane S: the slot nearest a lock where the locked job's links, calendar, window and crews hold, against the saved option. */
    readonly nearestAllowed?: { readonly job: string; readonly at: string }
    /** Lane K's findings for a locked job at its lock time, against the saved option's rows: words that match the plan on screen. */
    readonly lockFindings?: readonly CheckViolation[]
  }>
}

/** World's published facts query, called through Host as the caller. A read: Planning never writes World. */
export interface WorldFactsPort {
  /** `signal` ends the read: the refresh deadline or the caller's abort. */
  readonly read: (access: AccessContext, run: WorkspaceResourceReference, input: PlanningFactsInput, signal: AbortSignal) => Promise<PlanningFactsOutput>
}

export interface PlanningOperationsPorts {
  readonly store: PlanStore
  readonly world: WorldFactsPort
  readonly solver: SolverPort
  readonly checker: CheckerPort
  readonly definitions: PlanDefinitionsPort
  readonly now?: () => Date
  /** One deadline for a whole refresh, every page included (default 20 s, inside Host's 30 s). */
  readonly refreshDeadlineMs?: number
}

/** A plan keeps at most this many baselines (the stored schema allows 32; the 4 MB file bound needs fewer). */
export const maxBaselines = 8

// ───────────── results ─────────────

const fit = <T extends object>(result: T, lists: ReadonlyArray<string>, overflow: (dropped: number) => unknown): T => {
  const next = { ...result } as Record<string, unknown>
  let dropped = 0
  for (const name of lists) {
    while (byteLength(next) > resultLimitBytes && Array.isArray(next[name]) && (next[name] as unknown[]).length > 0) {
      next[name] = (next[name] as unknown[]).slice(0, -1)
      dropped += 1
    }
  }
  if (dropped > 0 && Array.isArray(next.changed)) {
    const marker = overflow(dropped)
    const changed = next.changed as unknown[]
    next.changed = changed.length >= 12 ? [...changed.slice(0, 11), marker] : [...changed, marker]
    while (byteLength(next) > resultLimitBytes && (next.changed as unknown[]).length > 1) next.changed = [...(next.changed as unknown[]).slice(0, -2), marker]
  }
  return next as T
}

const resultOf = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value)
  if (!parsed.success || byteLength(parsed.data) > resultLimitBytes) {
    throw planningError(500, 'invalid_planning_result', parsed.success ? 'Planning built a result over 4 KB' : 'Planning built a result that does not match its published schema')
  }
  return parsed.data
}

// ───────────── helpers ─────────────

export const storedActor = (access: AccessContext): StoredActor => {
  const kind = access.actor.kind === 'ai' ? 'agent' : access.actor.kind === 'system' ? 'service' : 'human'
  return {
    kind,
    ...(access.actor.id === undefined ? {} : { id: access.actor.id.slice(0, 128) }),
    ...(access.actor.displayName === undefined ? {} : { name: access.actor.displayName.slice(0, 128) }),
  }
}

export const planReference = (workspaceId: WorkspaceId, planId: string): WorkspaceResourceReference =>
  workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'planning', type: 'planning.plan', id: planId })

const runReference = (workspaceId: WorkspaceId, runId: string): WorkspaceResourceReference =>
  workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId })

const appendChange = (plan: Plan, change: Omit<Plan['changes'][number], 'seq'>): Pick<Plan, 'changes' | 'droppedChanges'> => {
  const seq = (plan.changes.at(-1)?.seq ?? plan.droppedChanges) + 1
  const changes = [...plan.changes, { ...change, seq }]
  const overflow = Math.max(0, changes.length - 500)
  return { changes: changes.slice(overflow), droppedChanges: plan.droppedChanges + overflow }
}

const editKinds = (edits: readonly Edit[]): Plan['changes'][number]['kinds'] => [...new Set(edits.map(edit => edit.edit))].slice(0, 16)

/**
 * Lane K's bound check: from the first goal it does not confirm on, no goal reads "proven optimal". The
 * solver's bound is dropped with the word, as in lane S's withoutProof: it is not trusted on its own.
 */
export const unconfirmedAsBestFound = (status: Status, goals: readonly number[]): Status => {
  if (status.word !== 'validated feasible' || goals.length === 0) return status
  const from = Math.min(...goals)
  return { ...status, goals: status.goals.map(goal => goal.goal >= from && goal.word === 'proven optimal' ? { word: 'best found under budget' as const, goal: goal.goal, value: goal.value, unit: goal.unit } : goal) }
}

/** Job keys saved in any baseline of the plan. */
const baselinedJobs = (plan: Plan): ReadonlySet<string> => new Set(plan.baselines.flatMap(baseline => baseline.inputs.jobs.map(job => job.key)))

/** The structured status the Assistant reads: the stored words, goals in order, and a cause only for a proof. */
export const statusOut = (status: Status): StatusOut => {
  if (status.word === 'validated feasible') {
    return { word: status.word, goals: status.goals.map(goal => ({ word: goal.word, value: goal.value, unit: goal.unit, ...(goal.bound === undefined ? {} : { bound: goal.bound.value, gap: goal.value - goal.bound.value }) })) }
  }
  if (status.word !== 'proven infeasible') return { word: status.word, goals: [] }
  const cause = certificateSchema.parse(status.cause)
  switch (cause.kind) {
    case 'chain': return { word: status.word, goals: [], cause: { kind: 'chain', requiredHours: cause.workHours, availableHours: cause.availableHours, about: cause.jobs.slice(0, 4) } }
    case 'energy': return { word: status.word, goals: [], cause: { kind: 'energy', requiredHours: cause.requiredHours, availableHours: cause.availableHours, about: cause.resources.slice(0, 4) } }
    case 'availability': return { word: status.word, goals: [], cause: { kind: 'availability', about: [cause.rule, ...cause.items].slice(0, 4) } }
    case 'temporal': return { word: status.word, goals: [], cause: { kind: 'temporal', about: cause.steps.map(step => step.job).slice(0, 4) } }
  }
}

const sliceCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 0) throw planningError(400, 'invalid_request', 'The cursor is not one this plan gave', { expected: { cursor: 'the "more" value of the previous page' } })
  return offset
}

// ───────────── the operations ─────────────

export const createPlanningOperations = (ports: PlanningOperationsPorts) => {
  const { store, solver, checker } = ports
  const now = (): string => (ports.now?.() ?? new Date()).toISOString()
  const certifiedSize = certifiedSizeSchema.parse(solver.certifiedSize)
  const refreshDeadlineMs = ports.refreshDeadlineMs ?? 20_000
  // One Generate per plan at a time; stopping the Module stops every running Generate through its signal.
  const generating = new Map<string, Promise<unknown>>()
  const stopping = new AbortController()

  /**
   * Every shown status is lane K's re-check of the stored one: proof words only on the current revision
   * and formulation, a feasible plan the checker accepts today, and a certificate that `proves`. Otherwise
   * the shown status loses its proof (lane S's withoutProof), or becomes what the checker found.
   */
  const inputProblems = (recheck: RecheckView) => {
    const problems = recheck.violations.filter(violation => violation.input !== false).slice(0, 16).map(violation => ({ about: [...violation.about.slice(0, 4)], code: violation.code }))
    return problems.length > 0 ? problems : [{ about: [], code: 'invalid_input' }]
  }
  const optionState = (plan: Plan, option: Option): OptionState => {
    const formulation = solver.formulation(plan.inputs.settings.grid)
    const recheck = checker.recheck(plan, option, formulation)
    const stored = option.status
    const shown: Status = recheck.usable ? unconfirmedAsBestFound(stored, recheck.bestFoundGoals)
      : recheck.shownAs === 'invalid input' ? refusedStatus('invalid input', inputProblems(recheck))
        : recheck.shownAs === 'unresolved' && 'run' in stored ? unresolvedStatus(stored.run)
          : stored.word === 'validated feasible' && recheck.reasons.includes('violations') ? unresolvedStatus(stored.run)
            : withoutProof(stored)
    // The function-key rule; lane S's redundancyWarning fires on one train's series chain until it adopts it.
    const warning = shown.word === 'validated feasible' ? outTogether(plan.inputs, option.rows) : undefined
    const warnings = warning === undefined ? [] : [optionWarning(warning, plan.inputs)]
    const reason = recheck.usable ? undefined
      : recheck.reasons.includes('inputs-changed') ? 'revision' as const : recheck.reasons.includes('formulation-changed') ? 'formulation' as const : 'recheck' as const
    return { stale: !recheck.usable, ...(reason === undefined ? {} : { reason }), warnings, shown, baselineAllowed: recheck.baselineAllowed }
  }
  const optionStates = (plan: Plan): ReadonlyMap<string, OptionState> =>
    new Map((plan.options?.options ?? []).map(option => [option.key, optionState(plan, option)]))

  const readinessOf = (plan: Plan, states: ReadonlyMap<string, OptionState>): readonly ReadinessItem[] =>
    readiness(plan, { staleOptions: [...states].filter(([, state]) => state.stale).map(([key]) => key), now: now() })

  const writeResult = (plan: Plan, changed: readonly string[], extra: Partial<Pick<WriteResult, 'preview'>> = {}): WriteResult => {
    const items = readinessOf(plan, optionStates(plan))
    const result: WriteResult = {
      plan: { id: plan.id, title: plan.inputs.settings.title, revision: plan.revision },
      target: { kind: 'resource', ref: planReference(plan.workspaceId, plan.id) },
      changed: changed.slice(0, 12).map(line => clip(line, 200)),
      attention: items.filter(item => !item.blocks).slice(0, 6).map(item => ({ kind: attentionKind(item), text: readinessText(item, plan.inputs), about: [...item.about.slice(0, 4)] })),
      problems: items.filter(item => item.blocks).slice(0, 8).map(item => ({ about: [...item.about.slice(0, 4)], code: item.code, text: readinessText(item, plan.inputs) })),
      ...extra,
    }
    return resultOf(writeResultSchema, fit(result, ['problems', 'attention', 'changed'], dropped => `…and ${dropped} more lines: read the plan`))
  }

  const readGuarded = async (workspaceId: WorkspaceId, planId: string, guard: RevisionGuard): Promise<Plan> => {
    const plan = await store.read(workspaceId, planId)
    assertRevision(plan, guard)
    return plan
  }

  const findOption = (plan: Plan, key: string | undefined): Option => {
    const wanted = key ?? plan.options?.recommended
    if (wanted === undefined) throw planningError(409, 'option_stale', 'There is no option yet; generate first')
    const option = plan.options?.options.find(entry => entry.key === wanted)
    if (option === undefined) throw planningError(400, 'unknown_reference', `No option ${wanted} in this plan`, { about: [wanted] })
    return option
  }

  const requireFresh = (plan: Plan, option: Option): OptionState => {
    const state = optionState(plan, option)
    if (state.stale) throw planningError(409, 'option_stale', `Option ${option.label} no longer matches the plan (${state.reason === 'formulation' ? 'the solver changed' : state.reason === 'recheck' ? 'it fails the re-check' : 'the plan changed'}); generate again`, { about: [option.key], currentRevision: plan.revision })
    return state
  }

  /**
   * Option keys are unique per generated set, so a baseline can only name an option its caller saw. A key
   * is the solver's variant key and a set suffix (`swap.3f9a2c1d`); the solver sees its own variant keys, so
   * it can keep the better of stored and new per variant (D12). An option it kept keeps its key.
   */
  const variantKey = (key: string): string => key.replace(/\.[0-9a-f]{8}$/, '')
  const unkeyed = (stored: OptionSet | null): OptionSet | null => stored === null ? null : {
    ...stored, options: stored.options.map(option => ({ ...option, key: variantKey(option.key) })),
    ...(stored.recommended === undefined ? {} : { recommended: variantKey(stored.recommended) }),
  }
  const keyed = (generated: OptionSet, stored: OptionSet | null): OptionSet => {
    const set = crypto.randomUUID().slice(0, 8)
    const kept = new Map((stored?.options ?? []).map(option => [variantKey(option.key), { key: option.key, text: JSON.stringify({ ...option, key: variantKey(option.key) }) }]))
    const renamed = new Map<string, string>()
    const options = generated.options.map(option => {
      const old = kept.get(option.key)
      const key = old !== undefined && old.text === JSON.stringify(option) ? old.key : `${option.key.slice(0, 55)}.${set}`
      renamed.set(option.key, key)
      return { ...option, key }
    })
    const recommended = generated.recommended === undefined ? undefined : renamed.get(generated.recommended)
    return { ...generated, options, ...(recommended === undefined ? {} : { recommended }) }
  }

  /**
   * Reads every World value the plan names from its linked Run: at most 32 subjects per request, per Pack,
   * every page followed, all within `deadline`. Einsatz projects arrival facts only for units and tasks read
   * together, so an Einsatz plan with more than 32 Einsatz items is refused, never truncated.
   */
  const readWorld = async (workspaceId: WorkspaceId, runId: string, inputs: PlanInputs, access: AccessContext, deadline: AbortSignal, late: () => Error): Promise<{ readonly facts: WorldFactCopy[]; readonly observedAt: string }> => {
    const subjects = worldSubjects(inputs)
    const byPack = new Map<string, string[]>()
    for (const locator of subjects) {
      const pack = locator.slice(0, locator.indexOf('/'))
      byPack.set(pack, [...(byPack.get(pack) ?? []), locator])
    }
    const einsatz = byPack.get('einsatz')?.length ?? 0
    if (einsatz > 32) throw planningError(400, 'world_read_limit', `This plan names ${einsatz} Einsatz items; their arrival times are read together, at most 32 at once. Remove the items the plan does not need.`, { about: [] })
    const batches = [...byPack.values()].flatMap(locators => Array.from({ length: Math.ceil(locators.length / 32) }, (_, index) => locators.slice(index * 32, index * 32 + 32)))
    const facts: WorldFactCopy[] = []
    let oldestRead: string | undefined
    const reference = runReference(workspaceId, runId)
    for (const batch of batches) {
      let cursor: string | undefined
      do {
        if (deadline.aborted) throw late()
        let raw: PlanningFactsOutput
        try { raw = await ports.world.read(access, reference, { subjects: batch, ...(cursor === undefined ? {} : { cursor }) }, deadline) } catch (error) {
          if (deadline.aborted) throw late()
          throw error
        }
        const answer = planningFactsOutputSchema.safeParse(raw)
        if (!answer.success) throw planningError(502, 'invalid_host_response', 'World answered the facts query outside its contract')
        if (answer.data.run.id !== runId) throw planningError(502, 'invalid_host_response', 'World answered for another simulation')
        // The oldest read time of the batches: every value is at least this fresh.
        if (oldestRead === undefined || Date.parse(answer.data.observedAt) < Date.parse(oldestRead)) oldestRead = answer.data.observedAt
        // An item larger than a page continues on the next one under the same locator: facts merge by locator.
        for (const item of answer.data.items) for (const fact of item.facts) facts.push({ ...fact, locator: item.locator })
        cursor = answer.data.more
      } while (cursor !== undefined)
    }
    return { facts, observedAt: oldestRead ?? now() }
  }

  /**
   * An Assistant never supplies authority: an edit that loosens a hard rule is a person's to make, in the
   * plan screen. The actor kind is the caller's own statement, not authentication (a stated platform limit).
   */
  const refuseAgentAuthority = (weakens: readonly Weakening[], access: AccessContext): void => {
    if (weakens.length === 0 || access.actor.kind !== 'ai') return
    throw planningError(409, 'needs_person', 'A person must make this change in the plan screen: ask them.', {
      about: [...new Set(weakens.flatMap(weakening => weakening.about.slice(0, 1)))].slice(0, 4),
    })
  }

  /** What a re-timed option breaks, by rule key and its limit: "R2 (72 h)", "D1 (due Thu 12:00)", "the window". */
  const retimingBreaks = (violations: readonly CheckViolation[], inputs: PlanInputs): string => {
    const zone = inputs.settings.timeZone
    const named = violations.map(violation => {
      const key = violation.code === 'protected-equipment' ? violation.about[1] : violation.about[0]
      const rule = inputs.rules.find(entry => entry.key === key)
      if (rule?.kind === 'span-limit') return `${rule.key} (${valueWords(rule.limit.value, rule.limit.unit)})`
      if (rule?.kind === 'due') return `${rule.key} (due ${timeWords(rule.finishBy, zone)})`
      if (rule?.kind === 'keep-in-service') return `${rule.key} (at least ${rule.atLeast} in service)`
      if (rule?.kind === 'protected') return `${rule.key} (protected)`
      const name = (at: number) => `'${nameOf(inputs, violation.about[at] ?? '')}'`
      switch (violation.code) {
        case 'beyond-window': case 'outside-window': return 'the window'
        case 'link': return `the link ${name(0)} before ${name(1)}`
        case 'lock': return `the fixed start of ${name(0)}`
        case 'over-capacity': return `the capacity of ${name(0)}`
        case 'use-outside-calendar': case 'start-off-calendar': return `the shifts of ${name(0)}`
        case 'release': return `the release time of ${name(0)}`
        case 'before-data-date': return 'the plan\'s now'
        default: return violation.code.replaceAll('-', ' ')
      }
    })
    const distinct = [...new Set(named)]
    return distinct.length <= 2 ? distinct.join(' and ') : `${distinct.slice(0, 2).join(', ')} and ${distinct.length - 2} more`
  }

  /** The option's longest group span (h, from the span-over goal) and its extra cost (from the extra-cost goal). */
  const spanAndCost = (inputs: PlanInputs, option: Option): { readonly span?: number; readonly cost?: number } => {
    const k = (metric: string) => inputs.goals.findIndex(goal => goal.metric === metric)
    const spanGoal = k('span-over'), costGoal = k('extra-cost')
    const spans = option.metrics.filter(metric => spanGoal >= 0 && (metric.id === `goal:${spanGoal}` || metric.id.startsWith(`goal:${spanGoal}:`)))
    const cost = costGoal < 0 ? undefined : option.metrics.find(metric => metric.id === `goal:${costGoal}`)?.value
    return { ...(spans.length === 0 ? {} : { span: Math.max(...spans.map(metric => metric.value)) }), ...(cost === undefined ? {} : { cost }) }
  }
  /** The purchases the schedule uses; an option's stored purchases are the set it was allowed. */
  const purchasesUsed = (option: Option): readonly string[] => [...new Set(option.rows.flatMap(row => row.uses.flatMap(use => use.purchase === undefined ? [] : [use.purchase])))]

  const generateOnce = async (workspaceId: WorkspaceId, planId: string, input: z.infer<typeof generateInputSchema>, expectedRevision: number | undefined, access: AccessContext, signal: AbortSignal): Promise<GenerateResult> => {
    const guard = { expectedRevision, required: true }
    const plan = await readGuarded(workspaceId, planId, guard)
    if (plan.inputs.jobs.length > certifiedSize.maxJobs) {
      throw planningError(413, 'above_certified_size', sizeRefusalWords(certifiedSize, plan.inputs.jobs.length), { maxJobs: certifiedSize.maxJobs, jobs: plan.inputs.jobs.length })
    }
    const at = now()
    const by = storedActor(access)
    const answer = optionSetSchema.safeParse(await solver.generate({
      inputs: plan.inputs, inputsRevision: plan.revision, variants: input.variants, seconds: input.seconds ?? 20, stored: unkeyed(plan.options), at, by, signal,
      stoppedByWho: () => stopping.signal.aborted ? 'host' : signal.aborted ? 'person' : undefined,
    }))
    if (!answer.success) throw planningError(500, 'invalid_planning_result', 'Generate returned options that do not match the plan schema')
    // Lane K re-checks every feasible option before it is stored: one it refuses is a defect, and a goal
    // whose bound it does not confirm is stored as best found, so no later read can show it proven.
    const formulation = solver.formulation(plan.inputs.settings.grid)
    const keyedSet = keyed(answer.data, plan.options)
    const generated = { ...keyedSet, options: keyedSet.options.map(option => {
      if (option.status.word !== 'validated feasible' || option.inputsRevision !== plan.revision) return option
      const recheck = checker.recheck(plan, option, formulation)
      if (!recheck.usable) throw planningError(500, 'invalid_planning_result', `Generate called option ${option.label} feasible but the checker refuses it`)
      return { ...option, status: unconfirmedAsBestFound(option.status, recheck.bestFoundGoals) }
    }) }
    const saved = await store.update(workspaceId, planId, guard, current => ({
      ...current, updatedAt: at, options: generated,
      ...appendChange(current, { at, by, revision: current.revision, summary: `Generated ${generated.options.length} option${generated.options.length === 1 ? '' : 's'}`, kinds: [] }),
    }))
    const states = optionStates(saved)
    const options = generated.options.map(option => {
      const { span, cost } = spanAndCost(saved.inputs, option)
      return {
        key: option.key, label: option.label.slice(0, 80), status: statusOut(states.get(option.key)?.shown ?? option.status),
        ...(span === undefined ? {} : { span }), ...(cost === undefined ? {} : { cost }),
        // The redundancy warning sits beside the status wherever the status is shown (adversary item 7).
        warnings: [...(states.get(option.key)?.warnings ?? []).slice(0, 4)],
      }
    })
    const recommended = generated.options.find(option => option.key === generated.recommended)
    const used = recommended === undefined ? [] : purchasesUsed(recommended)
    const sentence = recommended === undefined
      ? 'No option can be recommended: none is validated feasible.'
      : `${recommended.label}: ${statusSentence(states.get(recommended.key)?.shown ?? recommended.status, saved.inputs)}${used.length === 0 ? '' : ` Buys: ${used.map(key => nameOf(saved.inputs, key)).join(', ')}.`}`
    const result: GenerateResult = {
      plan: { id: saved.id, revision: saved.revision }, options,
      ...(generated.recommended === undefined ? {} : { recommended: generated.recommended }),
      text: clip(sentence, 300),
    }
    return resultOf(generateResultSchema, fit(result, ['options'], () => undefined))
  }

  return {
    certifiedSize,

    list: async (workspaceId: WorkspaceId) => store.list(workspaceId),

    create: async (workspaceId: WorkspaceId, definition: { readonly id: string; readonly revisionId: string }, input: z.infer<typeof createInputSchema>, access: AccessContext): Promise<{ readonly result: WriteResult; readonly created: WorkspaceResourceReference }> => {
      const found = definitionRevision(ports.definitions, definition)
      const { plan, changes } = startPlan({ definition: found, workspaceId, id: crypto.randomUUID(), at: now(), by: storedActor(access), edits: input.edits ?? [], ...(input.grid === undefined ? {} : { grid: input.grid }) })
      const stored = await store.create(workspaceId, plan)
      return { result: writeResult(stored, [`Created '${stored.inputs.settings.title}' from '${found.title}'`, ...changeLines(changes, stored.inputs, 11)]), created: planReference(workspaceId, stored.id) }
    },

    edit: async (workspaceId: WorkspaceId, planId: string, input: z.infer<typeof editInputSchema>, expectedRevision: number | undefined, access: AccessContext): Promise<WriteResult> => {
      const at = now()
      const by = storedActor(access)
      if (input.preview === true) {
        const plan = await readGuarded(workspaceId, planId, { expectedRevision, required: false })
        // An edit that is invalid in itself is refused in a preview exactly as on save (walk 2, R2-4): the
        // same 4xx, never only preview violations. Problems and violations of a valid edit do not refuse it.
        const outcome: EditOutcome = applyEdits(plan.inputs, input.edits, { now: at, by, baselined: baselinedJobs(plan) })
        const previewed: Plan = { ...plan, inputs: outcome.inputs }
        const weakens = [...new Set(outcome.weakens.flatMap(weakening => weakening.about.slice(0, 1)))].slice(0, 6)
        const recommended = plan.options?.options.find(option => option.key === plan.options?.recommended)
        const authority = outcome.weakens.length > 0 && input.authority === undefined ? ` Saving it needs a named person's agreement: ${outcome.weakens.slice(0, 2).map(weakening => weakeningWords(weakening, plan.inputs)).join(' ')}` : ''
        if (recommended === undefined || recommended.rows.length === 0) {
          return writeResult(previewed, changeLines(outcome.changes, outcome.inputs), { preview: { saved: false, consequence: `Not saved.${authority} No schedule to re-time yet.`.trim(), violations: [], weakens } })
        }
        const timed = await solver.preview({ inputs: outcome.inputs, option: recommended })
        const before = new Map(recommended.rows.map(row => [row.job, row]))
        const moved = timed.rows.filter(row => before.get(row.job)?.start !== row.start || before.get(row.job)?.finish !== row.finish)
        const finish = (rows: readonly DatedRow[]) => rows.reduce((latest, row) => row.finish > latest ? row.finish : latest, '')
        const zone = outcome.inputs.settings.timeZone
        // A lock's gap is measured against the saved option (walk 2, R2-5): lane K's findings for the locked
        // job with every other job where the plan on screen has it, in place of the re-timed findings about it.
        const locked = timed.nearestAllowed?.job ?? timed.lockFindings?.[0]?.about.find(key => input.edits.some(edit => edit.edit === 'job' && edit.key === key && edit.lock !== undefined))
        const findings = timed.lockFindings === undefined || timed.lockFindings.length === 0 ? timed.violations
          : [...timed.lockFindings, ...timed.violations.filter(violation => locked === undefined || !violation.about.includes(locked))]
        const nearest = timed.nearestAllowed === undefined ? '' : ` The nearest allowed start for ${nameOf(outcome.inputs, timed.nearestAllowed.job)} is ${timeWords(timed.nearestAllowed.at, zone)}.`
        // A valid change is saved even when this option cannot keep a rule: every option made before it goes
        // out of date, and Generate makes new ones (walk 2, R2-4).
        const consequence = findings.length > 0 ? `Not saved yet. This option would break ${retimingBreaks(findings, outcome.inputs)}; generate new options after saving.${nearest}${authority}`
          : `Not saved yet. ${moved.length === 0 ? 'No job moves' : `${moved.length} job${moved.length === 1 ? ' moves' : 's move'}`}; the last finish ${finish(timed.rows) === finish(recommended.rows) ? 'stays' : `moves from ${timeWords(finish(recommended.rows), zone)} to ${timeWords(finish(timed.rows), zone)}`}.${authority}`
        return writeResult(previewed, changeLines(outcome.changes, outcome.inputs), { preview: {
          saved: false, consequence: clip(consequence, 300),
          violations: findings.slice(0, 6).map(violation => clip(violation.words ?? `${violation.code.replaceAll('_', ' ').replaceAll('-', ' ')}: ${violation.about.map(key => nameOf(outcome.inputs, key)).join(', ')}`, 200)),
          weakens,
          ...(timed.nearestAllowed === undefined ? {} : { nearestAllowed: timed.nearestAllowed.at }),
          moved: moved.slice(0, 6).map(row => ({ job: row.job, start: row.start, finish: row.finish, because: input.edits.map((_, edit) => edit) })),
        } })
      }
      // A plan-scoped edit never reads World: an added World item or a linked Run is saved with its values
      // unread, and the Workspace-scoped planning.sources.refresh reads them (the screen calls it next).
      const guard = { expectedRevision, required: true }
      const before = await readGuarded(workspaceId, planId, guard)
      const draft = applyEdits(before.inputs, input.edits, { now: at, by, baselined: baselinedJobs(before) })
      refuseAgentAuthority(draft.weakens, access)
      requireAuthority(draft.weakens, input.authority, before.inputs)
      let changes: readonly ChangeRecord[] = []
      const saved = await store.update(workspaceId, planId, guard, plan => {
        const outcome = applyEdits(plan.inputs, input.edits, { now: at, by, baselined: baselinedJobs(plan) })
        refuseAgentAuthority(outcome.weakens, access)
        requireAuthority(outcome.weakens, input.authority, plan.inputs)
        changes = outcome.changes
        if (outcome.changes.length === 0) return plan
        const revision = plan.revision + 1
        return {
          ...plan, revision, updatedAt: at, inputs: outcome.inputs,
          ...appendChange(plan, {
            at, by, revision, summary: changeSummary(outcome.changes, outcome.inputs), kinds: editKinds(input.edits),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            ...(input.authority === undefined ? {} : { authority: input.authority }),
          }),
        }
      })
      return writeResult(saved, changes.length === 0 ? ['No change: the plan already says this'] : changeLines(changes, saved.inputs))
    },

    generate: async (workspaceId: WorkspaceId, planId: string, input: z.infer<typeof generateInputSchema>, expectedRevision: number | undefined, access: AccessContext, signal: AbortSignal): Promise<GenerateResult> => {
      const running = `${workspaceId}/${planId}`
      if (stopping.signal.aborted) throw planningError(503, 'planning_busy', 'Planning is stopping; try again in a moment')
      if (generating.has(running)) throw planningError(409, 'generate_running', 'Generate is already working on this plan; wait for it to finish, then read the options')
      const work = generateOnce(workspaceId, planId, input, expectedRevision, access, AbortSignal.any([signal, stopping.signal]))
      generating.set(running, work)
      try { return await work } finally { generating.delete(running) }
    },

    explain: async (workspaceId: WorkspaceId, planId: string, input: z.infer<typeof explainInputSchema>): Promise<ExplainResult> => {
      const plan = await store.read(workspaceId, planId)
      const option = findOption(plan, input.option)
      requireFresh(plan, option)
      if (input.job !== undefined && !plan.inputs.jobs.some(job => job.key === input.job)) throw planningError(400, 'unknown_reference', `No job ${input.job} in this plan`, { about: [input.job] })
      if (input.ask === 'refusal' && option.status.word === 'validated feasible') throw planningError(409, 'option_not_feasible', `Option ${option.label} was not refused; ask why a job starts then or what sets the finish`, { about: [option.key] })
      return resultOf(explainResultSchema, await solver.explain({ inputs: plan.inputs, option, ask: input.ask, job: input.job, cursor: input.cursor }))
    },

    read: async (workspaceId: WorkspaceId, planId: string, input: z.infer<typeof readInputSchema>): Promise<InspectionView> => {
      const plan = await store.read(workspaceId, planId)
      const states = optionStates(plan)
      const context: SectionContext = { plan, readiness: readinessOf(plan, states), options: states, certifiedSize }
      const section = input.section ?? 'summary'
      const option = section === 'schedule' ? findOption(plan, input.option) : undefined
      const offset = sliceCursor(input.cursor)
      const frame = { target: { kind: 'resource' as const, resource: planReference(workspaceId, plan.id) }, title: plan.inputs.settings.title, observedAt: now() }
      const budget = resultLimitBytes - byteLength({ ...frame, sections: [{ id: section, title: 'Calendars, crews, tools and purchases', data: null }] })
      let sections: Section[]
      try { sections = buildSection(section, context, offset, budget, option) } catch (error) {
        if (error instanceof RangeError) throw planningError(400, 'invalid_request', error.message, { expected: { cursor: 'the "more" value of the previous page of the same section' } })
        throw error
      }
      for (const entry of sections) {
        if (!sectionDataSchemas[section].safeParse(entry.data).success) throw planningError(500, 'invalid_planning_result', `Planning built a ${section} section that does not match its schema`)
      }
      return resultOf(inspectionViewSchema, { ...frame, sections: sections.map(entry => ({ ...entry, data: JSON.parse(JSON.stringify(entry.data)) })) })
    },

    baseline: async (workspaceId: WorkspaceId, planId: string, input: z.infer<typeof baselineInputSchema>, expectedRevision: number | undefined, access: AccessContext): Promise<WriteResult> => {
      const at = now()
      const by = storedActor(access)
      const saved = await store.update(workspaceId, planId, { expectedRevision, required: true }, plan => {
        const option = findOption(plan, input.option)
        if (option.status.word !== 'validated feasible') throw planningError(409, 'option_not_feasible', `Option ${option.label} is ${option.status.word}; only a validated feasible option can become the baseline`, { about: [option.key] })
        if (!requireFresh(plan, option).baselineAllowed) throw planningError(409, 'option_stale', `Option ${option.label} no longer re-checks as feasible; generate again`, { about: [option.key] })
        if (plan.baselines.length >= maxBaselines) throw planningError(409, 'baseline_limit', `This plan already keeps ${plan.baselines.length} baselines, the most a plan may keep`, { maxBaselines })
        const number = Math.max(0, ...plan.baselines.map(baseline => Number(baseline.key.replace(/^B/, '')) || 0)) + 1
        return {
          ...plan, updatedAt: at,
          baselines: [...plan.baselines, { key: `B${number}`, name: input.name, ...(input.note === undefined ? {} : { note: input.note }), at, by, option: structuredClone(option), inputs: structuredClone(plan.inputs) }],
          ...appendChange(plan, { at, by, revision: plan.revision, summary: clip(`Baseline '${input.name}' from ${option.label}`, 240), kinds: [] }),
        }
      })
      const baseline = saved.baselines.at(-1)!
      return writeResult(saved, [`Made ${baseline.option.label} the baseline '${baseline.name}'`])
    },

    refresh: async (workspaceId: WorkspaceId, planId: string, expectedRevision: number | undefined, access: AccessContext, signal: AbortSignal): Promise<WriteResult> => {
      const guard = { expectedRevision, required: true }
      // One deadline for the whole refresh, every page included, and the caller's abort: past it nothing is saved.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(refreshDeadlineMs)])
      const late = () => planningError(503, 'world_unavailable', `World did not answer within ${refreshDeadlineMs / 1000} s; nothing was saved. Try again.`)
      const plan = await readGuarded(workspaceId, planId, guard)
      const run = plan.inputs.settings.run
      const zone = plan.inputs.settings.timeZone
      if (run === null) return writeResult(plan, ['Nothing read: no simulation is linked to this plan'])
      const { facts, observedAt } = await readWorld(workspaceId, run.id, plan.inputs, access, deadline, late)
      const key = (fact: WorldFactCopy) => `${fact.locator}\u0000${fact.id}`
      const previous = new Map(plan.inputs.world.facts.map(fact => [key(fact), fact]))
      const valueChanged = (fact: WorldFactCopy) => {
        const old = previous.get(key(fact))
        return old === undefined || old.value !== fact.value || old.unit !== fact.unit || old.basis !== fact.basis
      }
      const changedFacts = facts.filter(valueChanged)
      const removed = plan.inputs.world.facts.filter(fact => !facts.some(next => key(next) === key(fact)))
      const raises = changedFacts.length > 0 || removed.length > 0
      const at = now()
      const by = storedActor(access)
      const saved = await store.update(workspaceId, planId, guard, current => {
        if (deadline.aborted) throw late()
        const inputs = planInputsSchema.parse({ ...current.inputs, world: { refreshedAt: observedAt, facts } })
        const revision = raises ? current.revision + 1 : current.revision
        return {
          ...current, revision, updatedAt: at, inputs,
          ...appendChange(current, { at, by, revision, summary: raises ? `Read World values: ${changedFacts.length} new or changed, ${removed.length} gone` : 'Read World values: none changed', kinds: ['refresh'] }),
        }
      })
      const owners = new Map([...saved.inputs.equipment, ...saved.inputs.resources, ...saved.inputs.jobs.map(job => ({ locator: job.locator, label: job.title }))].flatMap(item => item.locator === undefined ? [] : [[item.locator, item.label] as const]))
      // Lines name World items by the plan's own labels, never by locator.
      const factWords = (fact: WorldFactCopy) => `${owners.has(fact.locator) ? `${owners.get(fact.locator)}: ` : ''}${fact.label} ${typeof fact.value === 'number' && fact.unit !== undefined ? valueWords(fact.value, fact.unit) : String(fact.value)} (${basisWords[fact.basis]}, ${datedWords(fact.at, zone)})`
      // observedAt is World's wall time of the read; the values describe their own simulation time, said with its date.
      const simulated = facts.reduce<string | undefined>((latest, fact) => latest === undefined || Date.parse(fact.at) > Date.parse(latest) ? fact.at : latest, undefined)
      const head = `Read ${facts.length} World value${facts.length === 1 ? '' : 's'}${simulated === undefined ? '' : ` describing ${datedWords(simulated, zone)} (simulation time)`}: ${changedFacts.length === 0 && removed.length === 0 ? 'none changed' : `${changedFacts.length} new or changed${removed.length === 0 ? '' : `, ${removed.length} gone`}`}`
      // The linked simulation's time outside the plan window is said once, with what to do (walk 2, R2-6). A
      // window ahead of the simulation is planning ahead when the plan's now is the simulation's (Train A);
      // a window the simulation has passed, or one far from a plan whose now is not the simulation's, is not.
      const window = saved.inputs.settings.window
      const simulatedMs = simulated === undefined ? undefined : Date.parse(simulated)
      const planNow = Date.parse(saved.inputs.settings.dataDate ?? at)
      const outside = window !== null && simulated !== undefined && simulatedMs !== undefined
        && (simulatedMs >= Date.parse(window.end) || (simulatedMs < Date.parse(window.start) && simulatedMs < planNow - 86_400_000))
        ? [`The simulation's time, ${datedWords(simulated, zone)}, is outside the plan window (${datedWords(window.start, zone)} to ${datedWords(window.end, zone)}): align the window to it.`] : []
      const lines = [head, ...outside, ...changedFacts.map(factWords)]
      return writeResult(saved, lines.length <= 12 ? lines : [...lines.slice(0, 11), `…and ${lines.length - 11} more values: read the sources section`])
    },

    /** Stops every running Generate through its signal (the solver keeps its best option) and waits for them. */
    shutdown: async (): Promise<void> => {
      stopping.abort(new Error('Planning is stopping'))
      await Promise.allSettled([...generating.values()])
    },

    delete: async (workspaceId: WorkspaceId, planId: string, expectedRevision: number | undefined, access: AccessContext): Promise<{ readonly deleted: true }> => {
      // A person's delete card sends no revision (L2); an Assistant deletes only the revision it has read.
      if (access.actor.kind === 'ai' && expectedRevision === undefined) {
        throw planningError(409, 'read_plan_first', 'Read the plan first: an Assistant deletes a plan only at the revision it has read; pass it as the expected revision.')
      }
      await store.delete(workspaceId, planId, { expectedRevision, required: false })
      return { deleted: true }
    },

  }
}

export type PlanningOperations = ReturnType<typeof createPlanningOperations>
