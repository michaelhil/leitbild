// The nine operations' behaviour (eight here; the World facts query is World's). The UI and the Assistant
// reach these only through Host and module-api.ts, so both take one path. Planning writes nothing in World:
// its only World call is the facts read in refresh. Generate, explain and preview run on the solver port
// (lane S); every status shown is re-checked on the checker port (lane K).
import { z } from 'zod'
import {
  inspectionViewSchema, planningFactsOutputSchema, workspaceResourceReferenceSchema,
  type AccessContext, type InspectionView, type PlanningFactsInput, type PlanningFactsOutput, type WorkspaceId, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { isPlanningError, planningError } from '../errors.ts'
import { applyEdits, requireAuthority, type ChangeRecord, type EditOutcome, type StoredActor } from '../plan/edits.ts'
import { definitionRevision, startPlan } from '../definitions/start.ts'
import type { PlanDefinitionsPort } from '../definitions/index.ts'
import { outTogether, readiness, worldSubjects, type ReadinessItem } from '../plan/readiness.ts'
import {
  certificateSchema, certifiedSizeSchema, optionSetSchema, planInputsSchema,
  type CertifiedSize, type Plan, type PlanInputs, type Status, type WorldFactCopy,
} from '../plan/schema.ts'
import type { Edit } from '../plan/edit-schema.ts'
import { assertRevision, type PlanStore, type RevisionGuard } from '../plan/store.ts'
import {
  attentionKind, basisWords, buildSection, byteLength, changeLines, changeSummary, nameOf, optionWarning, readinessText,
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
export interface CheckViolation { readonly code: string; readonly about: readonly string[] }

/** Lane K: the plan-level checker. It re-derives every rule from the inputs and trusts nothing in the rows. */
export interface CheckerPort {
  readonly check: (inputs: PlanInputs, option: Option) => { readonly violations: readonly CheckViolation[] }
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
  }) => Promise<OptionSet>
  readonly explain: (request: {
    readonly inputs: PlanInputs
    readonly option: Option
    readonly ask: z.infer<typeof explainInputSchema>['ask']
    readonly job: string | undefined
    readonly cursor: string | undefined
  }) => Promise<ExplainResult>
  /** Re-times `option` on the edited inputs with its order and modes, then checks it. */
  readonly preview: (request: { readonly inputs: PlanInputs; readonly option: Option }) => Promise<{
    readonly rows: readonly DatedRow[]
    readonly violations: readonly CheckViolation[]
    readonly nearestAllowed?: { readonly job: string; readonly at: string }
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

  /** Proof words apply only on the current revision and formulation, after the checker re-checks the option. */
  const optionState = (plan: Plan, option: Option): OptionState => {
    const formulation = 'run' in option.status ? option.status.run.formulation : undefined
    const warnings = option.rows.length === 0 ? [] : outTogether(plan.inputs, option).map(warning => optionWarning(warning, plan.inputs))
    if (option.inputsRevision !== plan.revision) return { stale: true, reason: 'revision', warnings }
    if (formulation !== undefined && formulation !== solver.formulation(plan.inputs.settings.grid)) return { stale: true, reason: 'formulation', warnings }
    if (option.status.word === 'validated feasible' && checker.check(plan.inputs, option).violations.length > 0) return { stale: true, reason: 'recheck', warnings }
    return { stale: false, warnings }
  }
  const optionStates = (plan: Plan): ReadonlyMap<string, OptionState> =>
    new Map((plan.options?.options ?? []).map(option => [option.key, optionState(plan, option)]))

  const readinessOf = (plan: Plan, states: ReadonlyMap<string, OptionState>): readonly ReadinessItem[] =>
    readiness(plan, { staleOptions: [...states].filter(([, state]) => state.stale).map(([key]) => key), now: now() })

  const writeResult = (plan: Plan, changed: readonly string[], extra: Partial<Pick<WriteResult, 'preview'>> = {}): WriteResult => {
    const items = readinessOf(plan, optionStates(plan))
    const result: WriteResult = {
      plan: { id: plan.id, title: plan.inputs.settings.title, revision: plan.revision },
      changed: changed.slice(0, 12).map(line => line.slice(0, 200)),
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
   * Option keys are unique per generated set, so a baseline can only name an option its caller saw: an
   * option the solver kept unchanged from the stored set keeps its key, every other one gets a new key.
   */
  const keyed = (generated: OptionSet, stored: OptionSet | null): OptionSet => {
    const set = crypto.randomUUID().slice(0, 8)
    const kept = new Map((stored?.options ?? []).map(option => [option.key, JSON.stringify(option)]))
    const renamed = new Map<string, string>()
    const options = generated.options.map((option, index) => {
      if (kept.get(option.key) === JSON.stringify(option)) return option
      const key = `O${index + 1}-${set}`
      renamed.set(option.key, key)
      return { ...option, key }
    })
    const recommended = generated.recommended === undefined ? undefined : renamed.get(generated.recommended) ?? generated.recommended
    return { ...generated, options, ...(recommended === undefined ? {} : { recommended }) }
  }

  const generateOnce = async (workspaceId: WorkspaceId, planId: string, input: z.infer<typeof generateInputSchema>, expectedRevision: number | undefined, access: AccessContext, signal: AbortSignal): Promise<GenerateResult> => {
    const guard = { expectedRevision, required: true }
    const plan = await readGuarded(workspaceId, planId, guard)
    if (plan.inputs.jobs.length > certifiedSize.maxJobs) {
      throw planningError(413, 'above_certified_size', `Too large for the certified size: certified for ${certifiedSize.family} up to ${certifiedSize.maxJobs} jobs; this plan has ${plan.inputs.jobs.length}`, { maxJobs: certifiedSize.maxJobs, jobs: plan.inputs.jobs.length })
    }
    const at = now()
    const by = storedActor(access)
    const answer = optionSetSchema.safeParse(await solver.generate({
      inputs: plan.inputs, inputsRevision: plan.revision, variants: input.variants, seconds: input.seconds ?? 20, stored: plan.options, at, by, signal,
    }))
    if (!answer.success) throw planningError(500, 'invalid_planning_result', 'Generate returned options that do not match the plan schema')
    const generated = keyed(answer.data, plan.options)
    for (const option of generated.options) {
      if (option.status.word === 'validated feasible' && option.inputsRevision === plan.revision && checker.check(plan.inputs, option).violations.length > 0) {
        throw planningError(500, 'invalid_planning_result', `Generate called option ${option.label} feasible but the checker refuses it`)
      }
    }
    const saved = await store.update(workspaceId, planId, guard, current => ({
      ...current, updatedAt: at, options: generated,
      ...appendChange(current, { at, by, revision: current.revision, summary: `Generated ${generated.options.length} option${generated.options.length === 1 ? '' : 's'}`, kinds: [] }),
    }))
    const states = optionStates(saved)
    const options = generated.options.map(option => ({
      key: option.key, label: option.label.slice(0, 80), status: statusOut(option.status),
      ...(option.metrics.find(entry => entry.id === 'span') === undefined ? {} : { span: option.metrics.find(entry => entry.id === 'span')!.value }),
      ...(option.metrics.find(entry => entry.id === 'extra-cost') === undefined ? {} : { cost: option.metrics.find(entry => entry.id === 'extra-cost')!.value }),
      // The redundancy warning sits beside the status wherever the status is shown (adversary item 7).
      warnings: [...(states.get(option.key)?.warnings ?? []).slice(0, 4)],
    }))
    const recommended = generated.options.find(option => option.key === generated.recommended)
    const sentence = recommended === undefined
      ? 'No option can be recommended: none is validated feasible.'
      : `${recommended.label}: ${statusSentence(recommended.status, saved.inputs)}`
    const result: GenerateResult = {
      plan: { id: saved.id, revision: saved.revision }, options,
      ...(generated.recommended === undefined ? {} : { recommended: generated.recommended }),
      text: sentence.length <= 300 ? sentence : `${sentence.slice(0, 299)}…`,
    }
    return resultOf(generateResultSchema, fit(result, ['options'], () => undefined))
  }

  return {
    certifiedSize,

    list: async (workspaceId: WorkspaceId) => store.list(workspaceId),

    create: async (workspaceId: WorkspaceId, definition: { readonly id: string; readonly revisionId: string }, input: z.infer<typeof createInputSchema>, access: AccessContext): Promise<{ readonly result: WriteResult; readonly created: WorkspaceResourceReference }> => {
      const found = definitionRevision(ports.definitions, definition)
      const { plan, changes } = startPlan({ definition: found, workspaceId, id: crypto.randomUUID(), at: now(), by: storedActor(access), edits: input.edits ?? [] })
      const stored = await store.create(workspaceId, plan)
      return { result: writeResult(stored, [`Created '${stored.inputs.settings.title}' from '${found.title}'`, ...changeLines(changes, stored.inputs, 11)]), created: planReference(workspaceId, stored.id) }
    },

    edit: async (workspaceId: WorkspaceId, planId: string, input: z.infer<typeof editInputSchema>, expectedRevision: number | undefined, access: AccessContext): Promise<WriteResult> => {
      const at = now()
      const by = storedActor(access)
      if (input.preview === true) {
        const plan = await readGuarded(workspaceId, planId, { expectedRevision, required: false })
        let outcome: EditOutcome
        try { outcome = applyEdits(plan.inputs, input.edits, { now: at, by }) } catch (error) {
          if (!isPlanningError(error) || error.code !== 'protected_equipment') throw error
          const about = (error.details?.about as string[] | undefined) ?? []
          return writeResult(plan, ['Not saved'], { preview: { saved: false, consequence: 'Refused if saved: a job would touch protected equipment.', violations: [error.message.slice(0, 200)], weakens: about.slice(0, 6) } })
        }
        const previewed: Plan = { ...plan, inputs: outcome.inputs }
        const weakens = [...new Set(outcome.weakens.flatMap(weakening => weakening.about.slice(0, 1)))].slice(0, 6)
        const recommended = plan.options?.options.find(option => option.key === plan.options?.recommended)
        const authority = outcome.weakens.length > 0 && input.authority === undefined ? ' Saving it needs authority: who agreed and why.' : ''
        if (recommended === undefined || recommended.rows.length === 0) {
          return writeResult(previewed, changeLines(outcome.changes, outcome.inputs), { preview: { saved: false, consequence: `Not saved.${authority} No schedule to re-time yet.`.trim(), violations: [], weakens } })
        }
        const timed = await solver.preview({ inputs: outcome.inputs, option: recommended })
        const before = new Map(recommended.rows.map(row => [row.job, row]))
        const moved = timed.rows.filter(row => before.get(row.job)?.start !== row.start)
        const finish = (rows: readonly DatedRow[]) => rows.reduce((latest, row) => row.finish > latest ? row.finish : latest, '')
        const zone = outcome.inputs.settings.timeZone
        const consequence = `Not saved. ${moved.length === 0 ? 'No job moves' : `${moved.length} job${moved.length === 1 ? ' moves' : 's move'}`}; the last finish ${finish(timed.rows) === finish(recommended.rows) ? 'stays' : `moves from ${timeWords(finish(recommended.rows), zone)} to ${timeWords(finish(timed.rows), zone)}`}.${authority}`
        return writeResult(previewed, changeLines(outcome.changes, outcome.inputs), { preview: {
          saved: false, consequence: consequence.slice(0, 300),
          violations: timed.violations.slice(0, 6).map(violation => `${violation.code.replaceAll('_', ' ').replaceAll('-', ' ')}: ${violation.about.map(key => nameOf(outcome.inputs, key)).join(', ')}`.slice(0, 200)),
          weakens,
          ...(timed.nearestAllowed === undefined ? {} : { nearestAllowed: timed.nearestAllowed.at }),
        } })
      }
      let changes: readonly ChangeRecord[] = []
      const saved = await store.update(workspaceId, planId, { expectedRevision, required: true }, plan => {
        const outcome = applyEdits(plan.inputs, input.edits, { now: at, by })
        requireAuthority(outcome.weakens, input.authority)
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
        requireFresh(plan, option)
        if (plan.baselines.length >= maxBaselines) throw planningError(409, 'baseline_limit', `This plan already keeps ${plan.baselines.length} baselines, the most a plan may keep`, { maxBaselines })
        const number = Math.max(0, ...plan.baselines.map(baseline => Number(baseline.key.replace(/^B/, '')) || 0)) + 1
        return {
          ...plan, updatedAt: at,
          baselines: [...plan.baselines, { key: `B${number}`, name: input.name, ...(input.note === undefined ? {} : { note: input.note }), at, by, option: structuredClone(option), inputs: structuredClone(plan.inputs) }],
          ...appendChange(plan, { at, by, revision: plan.revision, summary: `Baseline '${input.name}' from ${option.label}`.slice(0, 240), kinds: [] }),
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
      const subjects = worldSubjects(plan.inputs)
      // One read for every subject: some facts (Einsatz arrivals) exist only for subjects read together.
      if (subjects.length > 32) throw planningError(400, 'invalid_request', `This plan names ${subjects.length} World items; a refresh reads at most 32 together`, { about: [] })
      const facts: WorldFactCopy[] = []
      let observedAt = now()
      if (subjects.length > 0) {
        const reference = runReference(workspaceId, run.id)
        let cursor: string | undefined
        do {
          if (deadline.aborted) throw late()
          let raw: PlanningFactsOutput
          try { raw = await ports.world.read(access, reference, { subjects: [...subjects], ...(cursor === undefined ? {} : { cursor }) }, deadline) } catch (error) {
            if (deadline.aborted) throw late()
            throw error
          }
          const answer = planningFactsOutputSchema.safeParse(raw)
          if (!answer.success) throw planningError(502, 'invalid_host_response', 'World answered the facts query outside its contract')
          if (answer.data.run.id !== run.id) throw planningError(502, 'invalid_host_response', 'World answered for another simulation')
          observedAt = answer.data.observedAt
          // An item larger than a page continues on the next one under the same locator: facts merge by locator.
          for (const item of answer.data.items) for (const fact of item.facts) facts.push({ ...fact, locator: item.locator })
          cursor = answer.data.more
        } while (cursor !== undefined)
      }
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
      const owners = new Map([...saved.inputs.equipment, ...saved.inputs.resources].flatMap(item => item.locator === undefined ? [] : [[item.locator, item.label] as const]))
      const factWords = (fact: WorldFactCopy) => `${owners.get(fact.locator) ?? fact.locator}: ${fact.label} ${typeof fact.value === 'number' && fact.unit !== undefined ? valueWords(fact.value, fact.unit) : String(fact.value)} (${basisWords[fact.basis]}, ${timeWords(fact.at, zone)})`
      const head = `Read ${facts.length} World value${facts.length === 1 ? '' : 's'} at ${timeWords(observedAt, zone)}: ${changedFacts.length === 0 && removed.length === 0 ? 'none changed' : `${changedFacts.length} new or changed${removed.length === 0 ? '' : `, ${removed.length} gone`}`}`
      const lines = [head, ...changedFacts.map(factWords)]
      return writeResult(saved, lines.length <= 12 ? lines : [...lines.slice(0, 11), `…and ${lines.length - 11} more values: read the sources section`])
    },

    /** Stops every running Generate through its signal (the solver keeps its best option) and waits for them. */
    shutdown: async (): Promise<void> => {
      stopping.abort(new Error('Planning is stopping'))
      await Promise.allSettled([...generating.values()])
    },

    delete: async (workspaceId: WorkspaceId, planId: string, expectedRevision: number | undefined): Promise<{ readonly deleted: true }> => {
      await store.delete(workspaceId, planId, { expectedRevision, required: false })
      return { deleted: true }
    },

  }
}

export type PlanningOperations = ReturnType<typeof createPlanningOperations>
