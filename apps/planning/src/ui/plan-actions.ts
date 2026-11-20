// What the plan screen does, as functions over one port: the Host client. Each action returns the next
// state for the screen to show; the screen holds no other logic. Planning is the only Module written to:
// World is only read, through its planning-facts query.
import type { PlanningSubject } from '@leitbild/contracts'
import type { Edit } from '../plan/edit-schema.ts'
import { staleRefusalPreface, type VersusFacts } from '../api/contract.ts'
import { isRequestError, refusalAuthority, refusalNearest, refusalText, RUN, type ExplainResult, type GenerateInput, type PlanningClient } from './api.ts'
import type { BuysPage } from './ladder.ts'
import { whatIfRequest, type WhatIfVariant } from './what-if.ts'
import { finishChain, mostLimiting, whyStart, type FinishStep, type Part, type WhyStart } from './explain-text.ts'
import { createTimeFormat } from './format.ts'
import { createNames, namesInEdits, planOptions, type DatedRow, type OptionView, type PlanModel, type RunChoice } from './model.ts'
import type { Preview } from './preview.ts'
import { loadPlan, loadRows, readAll } from './read-plan.ts'
import type { Context } from './status-text.ts'

export interface Shown {
  readonly model: PlanModel
  /** The option drawn on the timeline: the one shown before if it still exists, else the recommended one. */
  readonly option: string | null
  readonly notice: string | null
}

/**
 * After a read of World: when the values describe, in simulation time. The Module's own lines name
 * locators and raw values, so the screen writes its own; wall-clock time is not shown.
 */
export const worldReadNotice = (model: PlanModel): string => {
  const facts = model.inputs.world.facts
  if (facts.length === 0) return 'World values read; this plan names no World items yet.'
  const latest = facts.reduce((last, fact) => Date.parse(fact.at) > Date.parse(last) ? fact.at : last, facts[0]!.at)
  return `World values read: ${facts.length} ${facts.length === 1 ? 'value' : 'values'}, describing simulation time ${createTimeFormat(model.inputs.settings.timeZone).when(latest)}.`
}

/**
 * Beside its own Run, a linked plan whose World values were never read reads them when it opens, so a refused
 * read is said on the plan screen: the Library opens a new plan for the Run even when its first read was refused.
 */
export const readsOnOpen = (model: PlanModel, besideRun: string | null): boolean =>
  besideRun !== null && model.inputs.settings.run?.id === besideRun && model.inputs.world.refreshedAt === null

/** An edit that names a World item or links a Run: World values are read again after it is saved. */
export const readsWorld = (edits: readonly Edit[]): boolean =>
  edits.some(edit => ('locator' in edit && typeof edit.locator === 'string') || (edit.edit === 'plan' && typeof edit.run === 'string'))

/**
 * A change the screen already knows weakens a hard rule: removing a rule, or moving a due time later.
 * The Module decides; the screen asks for the agreement up front so the person is not refused twice.
 */
export const weakensRule = (model: PlanModel, edits: readonly Edit[]): string | null => {
  for (const edit of edits) {
    if (edit.edit === 'remove' && edit.what === 'rule') return 'Removing this rule weakens it'
    if (edit.edit === 'rule' && edit.finishBy !== undefined) {
      const due = model.inputs.rules.find(rule => rule.key === edit.key)
      if (due?.kind === 'due' && Date.parse(edit.finishBy) > Date.parse(due.finishBy)) return 'Moving a due time later weakens it'
    }
  }
  return null
}

/** Says what the screen is waiting for, e.g. "Reading World values…", while an action runs. */
export type Progress = (text: string) => void

/** While another plan holds the one solver, a rung is tried again after this wait, at most this many times in all. */
export const busyWaitMs = 20_000
export const busyTries = 3

/** Waits, or stops waiting at once when the request is cancelled. */
const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise(done => {
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true })
})

export const createPlanActions = (client: PlanningClient, planId: string, progress: Progress = () => {}) => {
  /**
   * Every option of the plan's own the Module proved impossible, with its refusal in words and hours, as stored:
   * one made before the latest change keeps the words it had (re-walk N4, live check 19 Nov), never re-worded
   * from its bare cause. Its row already says it is out of date, so the Module's preface saying so is dropped.
   */
  const refusalsOf = async (model: PlanModel): Promise<PlanModel['refusals']> => {
    // A what-if's refusal is its causes by method on its card (walk V1, adversary B3): only the plan's own options are asked.
    const refused = planOptions(model).filter(item => item.status.word === 'proven infeasible')
    const answers = await Promise.all(refused.map(async item => {
      const lines = (await client.explain(planId, { ask: 'refusal', option: item.key })).lines
      return [item.key, !item.fresh && lines[0] === staleRefusalPreface ? lines.slice(1) : lines] as const
    }))
    return Object.fromEntries(answers)
  }
  const load = async (keep: string | null, notice: string | null = null): Promise<Shown> => {
    const read = await loadPlan(client, planId)
    const model = { ...read, refusals: await refusalsOf(read) }
    const option = keep !== null && model.options?.items.some(item => item.key === keep) ? keep : model.options?.recommended ?? null
    if (option === null || model.rows[option] !== undefined) return { model, option, notice }
    return { model: { ...model, rows: { ...model.rows, [option]: await loadRows(client, planId, option) } }, option, notice }
  }
  /**
   * After a saved edit. A plan edit never reads World (a plan-only Room must not see World data), so an
   * edit that names a World item or links a Run saves it unread; the screen then reads its values at
   * once with the Workspace-scoped refresh, at the edit's new revision, so "not read yet" is never left.
   */
  const afterWrite = async (edits: readonly Edit[], linked: boolean, revision: number, keep: string | null, notice: string): Promise<Shown> => {
    if (!linked || !readsWorld(edits)) return load(keep, notice)
    progress('Reading World values…')
    await client.refresh(planId, revision)
    const read = await load(keep)
    return { ...read, notice: `${notice} ${worldReadNotice(read.model)}` }
  }

  return {
    load,
    runs: async (scenario: string | undefined): Promise<readonly RunChoice[]> =>
      (await client.catalog()).resources.filter(resource => resource.ref.type === RUN).map(resource => ({
        id: resource.ref.id, title: resource.title,
        status: String(resource.summary.find(item => item.key === 'status')?.value ?? ''),
        matches: scenario !== undefined && resource.sourceDefinition?.id === scenario,
      })),
    /** Shows an edit's consequence without saving. A refusal in words is a preview too; a server fault is not. */
    /** Shows an edit's consequence on `option`, the one on the timeline (walk V4); the Module's default is the recommended one. */
    preview: async (model: PlanModel, edits: readonly Edit[], label: string, option: string | null = null): Promise<Preview> => {
      const asks = weakensRule(model, edits)
      try {
        return { label, result: await client.edit(planId, model.revision, { edits: [...edits], preview: true, ...(option === null ? {} : { option }) }), refusal: null, asks }
      } catch (cause) {
        if (!isRequestError(cause) || cause.status >= 500) throw cause
        const names = createNames(model.inputs, namesInEdits(edits))
        return { label, result: null, refusal: { text: refusalText(cause, names.any), needsAuthority: refusalAuthority(cause) !== null, nearestAllowed: refusalNearest(cause) }, asks }
      }
    },
    apply: async (model: PlanModel, edits: readonly Edit[], authority: { name: string; reason: string } | null, keep: string | null, label: string): Promise<Shown> => {
      const saved = await client.edit(planId, model.revision, { edits: [...edits], ...(authority === null ? {} : { authority }) })
      return afterWrite(edits, model.inputs.settings.run !== null, saved.plan.revision, keep, `Saved: ${label}.`)
    },
    /** Links a Run the person started in World, then reads its values. */
    link: async (model: PlanModel, run: string, keep: string | null): Promise<Shown> => {
      const edits: Edit[] = [{ edit: 'plan', run }]
      const saved = await client.edit(planId, model.revision, { edits })
      return afterWrite(edits, true, saved.plan.revision, keep, 'Linked.')
    },
    refresh: async (model: PlanModel, keep: string | null): Promise<Shown> => {
      progress('Reading World values…')
      await client.refresh(planId, model.revision)
      const read = await load(keep)
      return { ...read, notice: worldReadNotice(read.model) }
    },
    /** Generate, or Cancel through `signal`: either way the plan is read again, so what is kept shows. */
    generate: async (model: PlanModel, input: GenerateInput, signal: AbortSignal, keep: string | null): Promise<Shown & { readonly error: string | null; readonly cause: unknown }> => {
      let notice: string | null = null
      let error: string | null = null
      let failed: unknown = null
      let option = keep
      try {
        // The outcome banner says what Generate found, from the options read back; no prose is copied.
        const result = await client.generate(planId, model.revision, input, signal)
        option = result.recommended ?? keep
      } catch (cause) {
        if (signal.aborted) notice = 'Cancelled. The best plan found before the stop is kept only if it is better than the one you had.'
        else { error = refusalText(cause, createNames(model.inputs).any); failed = cause }
      }
      return { ...await load(option, notice), error, cause: failed }
    },
    rows: async (model: PlanModel, option: string): Promise<PlanModel> =>
      model.rows[option] === undefined ? { ...model, rows: { ...model.rows, [option]: await loadRows(client, planId, option) } } : model,
    /** What sets the finish: the chain, and the one line on what limits it most. */
    finish: async (context: Context, option: string | null): Promise<{ readonly steps: readonly FinishStep[]; readonly limiting: { readonly parts: readonly Part[] } | null }> => {
      const result = await client.explain(planId, { ask: 'finish', ...(option === null ? {} : { option }) })
      return { steps: finishChain(result, context), limiting: mostLimiting(result, context) }
    },
    whyStart: async (context: Context, option: string | null, job: string, rows: readonly DatedRow[]): Promise<{ readonly why: WhyStart | null; readonly notice: string | null }> => {
      const result = await client.explain(planId, { ask: 'why-start', job, ...(option === null ? {} : { option }) })
      const item = result.items.find(entry => entry.job === job)
      return item === undefined ? { why: null, notice: result.lines.join(' ') } : { why: whyStart(item, context, rows.find(row => row.job === job)), notice: null }
    },
    /** "What overtime buys": the rungs and the rows between them, every page. */
    buys: async (): Promise<readonly BuysPage[]> => readAll(client, planId, 'buys'),
    /**
     * Works out the rungs still to solve, lowest first, one Generate each, kept beside the options already
     * there, so each rung starts from the one below. While another plan holds the solver, it waits and tries
     * again, and says so; it stops at the first other refusal, which it returns.
     */
    solveRungs: async (model: PlanModel, rungs: ReadonlyArray<{ readonly name: string; readonly request: GenerateInput }>, signal: AbortSignal, keep: string | null, wait: (ms: number) => Promise<void> = ms => pause(ms, signal)): Promise<Shown & { readonly error: unknown }> => {
      let error: unknown = null
      outer: for (const [index, rung] of rungs.entries()) {
        for (let attempt = 1; ; attempt += 1) {
          progress(`Working out what overtime buys: ${rung.name} (${index + 1} of ${rungs.length})…`)
          try {
            await client.generate(planId, model.revision, rung.request, signal)
            break
          } catch (cause) {
            if (signal.aborted) { error = cause; break outer }
            if (isRequestError(cause) && cause.code === 'solver_busy' && attempt < busyTries) {
              progress(`Planning is generating another plan; trying “${rung.name}” again in a moment.`)
              await wait(busyWaitMs)
              continue
            }
            error = cause
            break outer
          }
        }
      }
      const notice = signal.aborted ? 'Cancelled. The rungs worked out before the stop are kept.' : null
      return { ...await load(keep, notice), error: signal.aborted ? null : error }
    },
    /** One what-if, kept beside the options already there; returns the plan read again and the what-if's key. */
    whatIf: async (model: PlanModel, variant: WhatIfVariant, signal: AbortSignal, keep: string | null): Promise<Shown & { readonly asked: string | null }> => {
      const result = await client.generate(planId, model.revision, whatIfRequest(variant), signal)
      const label = (variant.label ?? '').slice(0, 80)
      const asked = result.options.find(option => option.label === label)?.key ?? null
      return { ...await load(keep), asked }
    },
    /**
     * Why the recommended option is recommended, as the Module's facts: against the next in rank, or against
     * the option named.
     */
    whyRecommended: async (against: string | null): Promise<ExplainResult> => client.explain(planId, { ask: 'recommended', ...(against === null ? {} : { option: against }) }),
    /**
     * "Why not possible": a refusal's full chain, the path, later start and energy proof the compact item does
     * not carry, as explain refusal words it from storage, for a fresh option or one made before the latest change.
     */
    whyNotPossible: async (option: string): Promise<readonly string[]> => (await client.explain(planId, { ask: 'refusal', option })).lines,
    /** What differs between an option and an option of the set made before the latest change. */
    versus: async (option: string, previous: string, cursor: string | null = null): Promise<ExplainResult> => client.explain(planId, { ask: 'versus', option, versus: { previous }, ...(cursor === null ? {} : { cursor }) }),
    /**
     * Every moved job after the first page, read page by page until there is no `more` (re-walk N3): one click
     * shows them all.
     */
    allMoved: async (option: string, previous: string, cursor: string): Promise<VersusFacts['moved']> => {
      const moved: Array<VersusFacts['moved'][number]> = []
      let next: string | undefined = cursor
      for (let pages = 0; next !== undefined && pages < 50; pages += 1) {
        const result: ExplainResult = await client.explain(planId, { ask: 'versus', option, versus: { previous }, cursor: next })
        moved.push(...result.versus?.moved ?? [])
        next = result.more
      }
      if (next !== undefined) throw new Error('Planning kept answering with more moved jobs; the rest were not read.')
      return moved
    },
    /** The set made before the latest change, every page: what compare weighs against. */
    previous: async (): Promise<{ readonly at: string | null; readonly recommended: string | null; readonly items: readonly OptionView[] }> => {
      const pages = await readAll(client, planId, 'previous')
      return { at: pages[0]?.at ?? null, recommended: pages[0]?.recommended ?? null, items: pages.flatMap(page => page.items) }
    },
    baseline: async (model: PlanModel, option: string, name: string, note: string): Promise<Shown> => {
      await client.baseline(planId, model.revision, { option, name, ...(note === '' ? {} : { note }) })
      return load(option, `Baseline “${name}” saved.`)
    },
    /** Finds World items by name in the linked Run, with all their values read together. */
    search: async (model: PlanModel, text: string): Promise<readonly PlanningSubject[]> => {
      const run = model.inputs.settings.run?.id
      if (run === undefined) throw new Error('Link a simulation first.')
      const found = (await client.facts(run, { text, limit: 10 })).items
      if (found.length === 0) return found
      const values = await client.facts(run, { subjects: found.map(item => item.locator) })
      return found.map(item => values.items.find(read => read.locator === item.locator) ?? item)
    },
    detail: async (model: PlanModel, locator: string): Promise<PlanningSubject> => {
      const run = model.inputs.settings.run?.id
      if (run === undefined) throw new Error('Link a simulation first.')
      const found = (await client.facts(run, { subjects: [locator] })).items.find(item => item.locator === locator)
      if (found === undefined) throw new Error('World no longer has this item.')
      return found
    },
  }
}
export type PlanActions = ReturnType<typeof createPlanActions>
