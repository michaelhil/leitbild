// What the plan screen does, as functions over one port: the Host client. Each action returns the next
// state for the screen to show; the screen holds no other logic. Planning is the only Module written to:
// World is only read, through its planning-facts query.
import type { PlanningSubject } from '@leitbild/contracts'
import type { Edit } from '../plan/edit-schema.ts'
import { isRequestError, refusalAuthority, refusalNearest, refusalText, RUN, type GenerateInput, type PlanningClient } from './api.ts'
import { finishChain, whyStart, type FinishStep, type WhyStart } from './explain-text.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type DatedRow, type PlanModel, type RunChoice } from './model.ts'
import type { Preview } from './preview.ts'
import { loadPlan, loadRows } from './read-plan.ts'
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
  if (facts.length === 0) return 'World values read; World returned none for this plan.'
  const latest = facts.reduce((last, fact) => Date.parse(fact.at) > Date.parse(last) ? fact.at : last, facts[0]!.at)
  return `World values read: ${facts.length} values, describing simulation time ${createTimeFormat(model.inputs.settings.timeZone).clock(latest)}.`
}

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

export const createPlanActions = (client: PlanningClient, planId: string) => {
  /** Every current option the Module proved impossible, with its refusal in words and hours. */
  const refusalsOf = async (model: PlanModel): Promise<PlanModel['refusals']> => {
    const refused = model.options?.items.filter(item => item.fresh && item.status.word === 'proven infeasible') ?? []
    const answers = await Promise.all(refused.map(async item => [item.key, (await client.explain(planId, { ask: 'refusal', option: item.key })).lines] as const))
    return Object.fromEntries(answers)
  }
  const load = async (keep: string | null, notice: string | null = null): Promise<Shown> => {
    const read = await loadPlan(client, planId)
    const model = { ...read, refusals: await refusalsOf(read) }
    const option = keep !== null && model.options?.items.some(item => item.key === keep) ? keep : model.options?.recommended ?? null
    if (option === null || model.rows[option] !== undefined) return { model, option, notice }
    return { model: { ...model, rows: { ...model.rows, [option]: await loadRows(client, planId, option) } }, option, notice }
  }
  /** Saved inputs changed: show them, and read World again when the change named a World item. */
  const afterWrite = async (edits: readonly Edit[], keep: string | null, notice: string): Promise<Shown> => {
    const shown = await load(keep, notice)
    if (shown.model.inputs.settings.run === null || !readsWorld(edits)) return shown
    await client.refresh(planId, shown.model.revision)
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
    preview: async (model: PlanModel, edits: readonly Edit[], label: string): Promise<Preview> => {
      const asks = weakensRule(model, edits)
      try {
        return { label, result: await client.edit(planId, model.revision, { edits: [...edits], preview: true }), refusal: null, asks }
      } catch (cause) {
        if (!isRequestError(cause) || cause.status >= 500) throw cause
        const names = createNames(model.inputs)
        return { label, result: null, refusal: { text: refusalText(cause, names.any), needsAuthority: refusalAuthority(cause) !== null, nearestAllowed: refusalNearest(cause) }, asks }
      }
    },
    apply: async (model: PlanModel, edits: readonly Edit[], authority: { name: string; reason: string } | null, keep: string | null, label: string): Promise<Shown> => {
      await client.edit(planId, model.revision, { edits: [...edits], ...(authority === null ? {} : { authority }) })
      return afterWrite(edits, keep, `Saved: ${label}.`)
    },
    /** Links a Run the person started in World, then reads its values. */
    link: async (model: PlanModel, run: string, keep: string | null): Promise<Shown> => {
      const edits: Edit[] = [{ edit: 'plan', run }]
      await client.edit(planId, model.revision, { edits })
      return afterWrite(edits, keep, 'Linked.')
    },
    refresh: async (model: PlanModel, keep: string | null): Promise<Shown> => {
      await client.refresh(planId, model.revision)
      const read = await load(keep)
      return { ...read, notice: worldReadNotice(read.model) }
    },
    /** Generate, or Cancel through `signal`: either way the plan is read again, so what is kept shows. */
    generate: async (model: PlanModel, input: GenerateInput, signal: AbortSignal, keep: string | null): Promise<Shown & { readonly error: string | null }> => {
      let notice: string | null = null
      let error: string | null = null
      let option = keep
      try {
        // The outcome banner says what Generate found, from the options read back; no prose is copied.
        const result = await client.generate(planId, model.revision, input, signal)
        option = result.recommended ?? keep
      } catch (cause) {
        if (signal.aborted) notice = 'Cancelled. The best plan found before the stop is kept only if it is better than the one you had.'
        else error = refusalText(cause, createNames(model.inputs).any)
      }
      return { ...await load(option, notice), error }
    },
    rows: async (model: PlanModel, option: string): Promise<PlanModel> =>
      model.rows[option] === undefined ? { ...model, rows: { ...model.rows, [option]: await loadRows(client, planId, option) } } : model,
    finish: async (context: Context, option: string | null): Promise<readonly FinishStep[]> =>
      finishChain(await client.explain(planId, { ask: 'finish', ...(option === null ? {} : { option }) }), context),
    whyStart: async (context: Context, option: string | null, job: string, rows: readonly DatedRow[]): Promise<{ readonly why: WhyStart | null; readonly notice: string | null }> => {
      const result = await client.explain(planId, { ask: 'why-start', job, ...(option === null ? {} : { option }) })
      const item = result.items.find(entry => entry.job === job)
      return item === undefined ? { why: null, notice: result.lines.join(' ') } : { why: whyStart(item, context, rows.find(row => row.job === job)), notice: null }
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
