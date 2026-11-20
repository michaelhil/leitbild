// The Library beside a Run: the plans linked to it, the Definitions this Run allows, what Planning can read
// in it, and starting a plan for it with the operations the plan screen uses to link a Run.
import { ABOUT_RELATION, type ModuleDefinitionDescriptor, type ModuleResourceDescriptor } from '@leitbild/contracts'
import type { Edit } from '../plan/edit-schema.ts'
import { PLAN, refusalText, RUN, type PlanningClient } from './api.ts'
import { goalsEdit, planEdits, type PlanForm } from './edit-forms.ts'
import { summaryDataSchema } from '../api/contract.ts'
import type { Progress } from './plan-actions.ts'

/** The Run a plan is about, from the `about` link Planning publishes on a linked plan; null for an unlinked plan. */
export const linkedRunOf = (plan: ModuleResourceDescriptor): string | null =>
  plan.links.find(link => link.rel === ABOUT_RELATION && link.ref.moduleId === 'world' && link.ref.type === RUN)?.ref.id ?? null

/** The plans for this Run, then the plans linked to no Run. Plans linked to another Run belong with it. */
export const plansBesideRun = (resources: readonly ModuleResourceDescriptor[], run: string) => {
  const plans = resources.filter(resource => resource.ref.type === PLAN)
  return { forRun: plans.filter(plan => linkedRunOf(plan) === run), unlinked: plans.filter(plan => linkedRunOf(plan) === null) }
}

/** This Run as the Host's catalogue lists it, or null when it is not listed. */
export const runResourceOf = (resources: readonly ModuleResourceDescriptor[], run: string): ModuleResourceDescriptor | null =>
  resources.find(resource => resource.ref.type === RUN && resource.ref.id === run) ?? null

/** The blank plan: a Definition that names no Scenario. */
export const blankDefinitionId = 'blank'

/**
 * The Definitions this Run allows: the blank plan, and those of the Run's Scenario. A plan Definition that names
 * a Scenario has that Scenario's id as its own id (beside-run.test.ts holds every bundled Definition to it), so
 * it is matched against the Scenario the Run was started from, as RunChoice `matches` does for a plan.
 */
export const definitionsForRun = (definitions: readonly ModuleDefinitionDescriptor[], run: ModuleResourceDescriptor): readonly ModuleDefinitionDescriptor[] =>
  definitions.filter(definition => definition.ref.id === blankDefinitionId || (run.sourceDefinition !== undefined && definition.ref.id === run.sourceDefinition.id))

/** Planning publishes a primary action only for a Definition planning.plan.create starts on its own; a guided one opens per Run. */
export const startsHere = (definition: ModuleDefinitionDescriptor): boolean => definition.primaryCapabilityId !== undefined

/** What Planning can read in this Run, from World's planning index: items by kind, or why it cannot read it. */
export type RunOffer =
  | { readonly state: 'reading' }
  | { readonly state: 'read'; readonly kinds: ReadonlyArray<{ readonly kind: string; readonly count: number }> }
  | { readonly state: 'not-read'; readonly text: string }

const ownFigures = 'A plan can still use the planner\'s own figures.'
const sentence = (text: string): string => text.trim().replace(/\.?$/, '.')

export const runOfferText = (offer: RunOffer): string => {
  if (offer.state === 'reading') return 'Looking at what Planning can read in this simulation…'
  if (offer.state === 'not-read') return `${sentence(offer.text)} ${ownFigures}`
  const total = offer.kinds.reduce((sum, entry) => sum + entry.count, 0)
  if (total === 0) return `This simulation has nothing Planning can read. ${ownFigures}`
  const kinds = offer.kinds.map(entry => `${entry.kind.replaceAll('-', ' ')}: ${entry.count}`).join(', ')
  return `Planning can read ${total} ${total === 1 ? 'item' : 'items'} in this simulation (${kinds}). A plan can also use the planner's own figures.`
}

/** A search page holds at most 20 items; World's index is read page by page, this many pages at most. */
const indexPages = 50

export const createLibraryActions = (client: PlanningClient, progress: Progress = () => {}) => {
  /**
   * Reads the new plan's World values with the refresh the plan screen uses after linking. A refused read leaves
   * the plan linked with its values not read: it opens all the same, and the plan screen beside its Run reads
   * them again when it opens and shows the refusal there.
   */
  const readValues = async (plan: string, revision: number): Promise<void> => {
    progress('Reading World values…')
    try { await client.refresh(plan, revision) } catch { /* The plan screen reads again on open and says why (readsOnOpen). */ }
  }
  return {
    /**
     * A Definition planning.plan.create starts on its own. Beside a Run it is created with a plan edit naming
     * the Run, then its World values are read; the plan's id is returned to open.
     */
    start: async (definition: ModuleDefinitionDescriptor, run: string | null): Promise<string> => {
      if (run === null) return (await client.create(definition)).result.plan.id
      progress('Starting the plan…')
      const edits: Edit[] = [{ edit: 'plan', run }]
      const created = (await client.create(definition, edits)).result.plan
      await readValues(created.id, created.revision)
      return created.id
    },
    /**
     * A plan from empty: name, window, zone and grid at create, then the goals in the plan's own currency.
     * Beside a Run the create also names the Run, and the World values are read last.
     */
    startBlank: async (blank: ModuleDefinitionDescriptor, form: PlanForm, run: string | null): Promise<string> => {
      const first = planEdits(form)
      if (!first.ok) throw new Error(first.problems.join(' '))
      const created = (await client.create(blank, [first.edits[0]!, ...run === null ? [] : [{ edit: 'plan' as const, run }]], form.grid)).result.plan
      const summary = summaryDataSchema.parse((await client.read(created.id, { section: 'summary' })).sections.find(section => section.id === 'summary')?.data)
      const goals = goalsEdit(form.goals, summary.settings.currency)
      if (!goals.ok) throw new Error(goals.problems.join(' '))
      const saved = await client.edit(created.id, created.revision, { edits: [...goals.edits] })
      if (run !== null) await readValues(created.id, saved.plan.revision)
      return created.id
    },
    /** The guided plan of this Run's Scenario: Planning opens it for this Run, creating it once, with its World values. */
    openGuided: async (definition: ModuleDefinitionDescriptor, run: string): Promise<string> => {
      progress('Opening this Run\'s plan…')
      return (await client.createDemo(definition, run)).result.plan.id
    },
    /** World's planning index of this Run, every page, counted by kind; a refusal in its own words. */
    runOffer: async (run: string): Promise<RunOffer> => {
      try {
        const kinds = new Map<string, string>()
        let cursor: string | undefined
        for (let pages = 0; pages < indexPages; pages += 1) {
          const page = await client.facts(run, { limit: 20, ...(cursor === undefined ? {} : { cursor }) })
          // An item may continue on the next page under the same locator: it is counted once.
          for (const item of page.items) kinds.set(item.locator, item.kind)
          cursor = page.more
          if (cursor === undefined) {
            const counts = new Map<string, number>()
            for (const kind of kinds.values()) counts.set(kind, (counts.get(kind) ?? 0) + 1)
            return { state: 'read', kinds: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)) }
          }
        }
        return { state: 'not-read', text: 'World kept answering with more items, so they were not all counted' }
      } catch (cause) { return { state: 'not-read', text: refusalText(cause) } }
    },
  }
}
export type LibraryActions = ReturnType<typeof createLibraryActions>
