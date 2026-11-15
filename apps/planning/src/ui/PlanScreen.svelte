<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { PlanningSubject } from '@leitbild/contracts'
  import type { Edit } from '../plan/edit-schema.ts'
  import { isNotBuilt, isRequestError, refusalText, type GenerateInput, type PlanningClient } from './api.ts'
  import { attentionCards, type CardAction } from './attention.ts'
  import AttentionColumn from './AttentionColumn.svelte'
  import ComparePanel from './ComparePanel.svelte'
  import CrewForm from './CrewForm.svelte'
  import EditPreview from './EditPreview.svelte'
  import EquipmentPicker from './EquipmentPicker.svelte'
  import ErrorNotice from './ErrorNotice.svelte'
  import Glance from './Glance.svelte'
  import { glance } from './orientation.ts'
  import FinishPanel from './FinishPanel.svelte'
  import Ladder from './Ladder.svelte'
  import { ladderView, rungRequest, type BuysPage } from './ladder.ts'
  import OptionsGlance from './OptionsGlance.svelte'
  import { optionsGlance, type ChoosePanel } from './options-glance.ts'
  import { outcomeBanner, refusalProof } from './outcome.ts'
  import type { FinishStep, NameKind, Part, WhyStart } from './explain-text.ts'
  import { createTimeFormat } from './format.ts'
  import { planSizeLine } from './size-text.ts'
  import JobForm from './JobForm.svelte'
  import JobPanel from './JobPanel.svelte'
  import { createNames, isWhatIf, otherWarnings, planOptions, sizeCautionOf, whatIfOptions, type Goal, type OptionView, type PlanModel, type PlanView, type RunChoice } from './model.ts'
  import OptionsTable from './OptionsTable.svelte'
  import PlanHeader from './PlanHeader.svelte'
  import type { Preview } from './preview.ts'
  import RulesPanel from './RulesPanel.svelte'
  import { alignWindowEdit, simulationNow } from './edit-forms.ts'
  import { createPlanActions, type Shown } from './plan-actions.ts'
  import { createPreviewGate } from './preview-gate.ts'
  import { crewHourPurchases, requestText } from './request.ts'
  import { revealPanel } from './reveal.ts'
  import { shiftList } from './shift-list.ts'
  import ShiftList from './ShiftList.svelte'
  import StatusBlock from './StatusBlock.svelte'
  import { statusView, type Context } from './status-text.ts'
  import Timeline from './Timeline.svelte'
  import { layoutTimeline } from './timeline-layout.ts'
  import WhatIfCard from './WhatIfCard.svelte'
  import WhatIfPanel from './WhatIfPanel.svelte'
  import { whatIfAskedNotice, whatIfCard, whatIfChoices, whatIfsClearedNotice, type WhatIfKind, type WhatIfVariant } from './what-if.ts'
  import WhyRecommended from './WhyRecommended.svelte'
  import type { RecommendedFacts, VersusFacts } from '../api/contract.ts'
  import { compareView, moreMoved, policyLines, previousFor, previousRows, recommendedAnswer, versusAnswer, whyView, type Answer, type CompareView, type WhyView } from './why-text.ts'
  import WorkList from './WorkList.svelte'

  /**
   * With no option to recommend, the first current option that has no schedule is the one whose status and
   * proof show in the detail column, so the reason is on the screen without a click. It has no rows to read.
   */
  const firstRefused = (plan: PlanModel | null): string | null =>
    (plan === null ? [] : planOptions(plan)).find(option => option.fresh && option.status.word !== 'validated feasible')?.key ?? null

  let { client, planId, initial = null, initialRuns = [], initialView = 'schedule', onChanged, onOpenWorkspace, onOpenLibrary }: {
    client: PlanningClient
    planId: string
    initial?: PlanModel | null
    initialRuns?: readonly RunChoice[]
    initialView?: PlanView
    onChanged: () => void
    onOpenWorkspace: () => void
    onOpenLibrary: () => void
  } = $props()

  // The initial props seed the screen once (a test renders a plan it already has); later reads replace them.
  // svelte-ignore state_referenced_locally
  let model = $state<PlanModel | null>(initial)
  // svelte-ignore state_referenced_locally
  let runs = $state<readonly RunChoice[]>(initialRuns)
  // svelte-ignore state_referenced_locally
  let view = $state<PlanView>(initialView)
  let selectedJob = $state<string | null>(null)
  // svelte-ignore state_referenced_locally
  let selectedOption = $state<string | null>(initial?.options?.recommended ?? firstRefused(initial))
  let busy = $state(false)
  let generating = $state<AbortController | null>(null)
  let error = $state<string | null>(null)
  /** What failed, kept for the detail behind "Details for support" when the screen could not read an answer. */
  let errorCause = $state<unknown>(null)
  const fail = (cause: unknown): void => { error = refusalText(cause, context?.names.any); errorCause = cause }
  let notice = $state<string | null>(null)
  let finish = $state<readonly FinishStep[] | null>(null)
  let limiting = $state<{ readonly parts: readonly Part[] } | null>(null)
  /** The newest answer is on top of the detail column: the finish chain when it was asked after a job or a preview opened. */
  let finishOnTop = $state(false)
  let why = $state<WhyStart | null>(null)
  let preview = $state<Preview | null>(null)
  let pending = $state<readonly Edit[]>([])
  /** Counts applied changes; the forms are keyed on it so each starts empty after an Apply. */
  let applied = $state(0)
  let panel = $state<HTMLElement | undefined>(undefined)
  /** The question about the options open beside the timeline: what overtime buys, a what-if, why recommended, or what differs. */
  let choosing = $state<ChoosePanel | null>(null)
  let buys = $state<{ readonly state: 'loading' | 'ready' | 'not-built' | 'refused'; readonly pages: readonly BuysPage[]; readonly text: string | null }>({ state: 'loading', pages: [], text: null })
  let solving = $state(false)
  /** The method whose ladder is shown; null for the first with rungs. */
  let ladderMethod = $state<string | null>(null)
  let asking = $state(false)
  let whatIfKind = $state<WhatIfKind | null>(null)
  /** Why the last what-if got no answer, in planner words. */
  let whatIfMissing = $state<string | null>(null)
  /** The what-if asked last: its card comes first. */
  let askedLast = $state<string | null>(null)
  let whyAnswer = $state<Answer<RecommendedFacts>>({ state: 'loading' })
  /** The option why recommended weighs against: '' for the next in rank. */
  let whyAgainst = $state('')
  let compareAnswer = $state<Answer<VersusFacts>>({ state: 'loading' })
  /** The set made before the latest change, from the previous read section, and the option of it compared with. */
  let previousSet = $state<{ readonly at: string | null; readonly recommended: string | null; readonly items: readonly OptionView[] } | null>(null)
  let compareAgainst = $state<string | null>(null)
  /** The earlier set has no option of the shown option's variant: the planner chooses one (walk V3). */
  let compareUnpaired = $state(false)
  /** The moved jobs after the first ones, once read, and the cursor that reads them (walk V10). */
  let compareCursor = $state<string | null>(null)
  let compareMore = $state<CompareView['moved'] | null>(null)
  const readMoreMoved = (): void => {
    const option = compareFor, against = compareAgainst, cursor = compareCursor
    if (option === null || against === null || cursor === null || context === null) return
    void attempt(async () => {
      const result = await actions.versus(option, against, cursor)
      if (result.versus === undefined) return
      compareMore = [...compareMore ?? [], ...moreMoved(result.versus, context)]
      compareCursor = result.more ?? null
    })
  }
  let compareFor = $state<string | null>(null)
  /** The goals before the first goal change saved in this session, for "Undo goal changes made since you opened this plan". */
  let earlierGoals = $state<readonly Goal[] | null>(null)
  /**
   * At 1280 px and wider the screen has a detail column on the right: the shown option's status sits there
   * beside the timeline. Below that the columns stack and it stays above the timeline.
   */
  let wide = $state(false)

  /**
   * After a preview, a selected job or an explanation appears, bring it into view and focus its heading.
   * `card` names the one that opened when the detail column holds more than one.
   */
  const reveal = (card?: string): void => {
    // After the panel has rendered and laid out, so its heading has its final place on the page.
    void tick().then(() => requestAnimationFrame(() => {
      const opened = card === undefined ? panel : panel?.querySelector<HTMLElement>(card) ?? panel
      if (opened !== undefined) revealPanel(opened, window.matchMedia('(prefers-reduced-motion: reduce)').matches, wide ? 'nearest' : 'start')
    }))
  }
  /**
   * Selects what an explanation names: a job opens in the panel; a crew, calendar, purchase, rule or item
   * opens its view and is brought into view there, focused.
   */
  const pick = (kind: NameKind, key: string): void => {
    if (kind === 'job') { view = 'schedule'; selectJob(key); return }
    view = kind === 'rule' ? 'rules' : kind === 'equipment' ? 'equipment' : 'crews'
    void tick().then(() => requestAnimationFrame(() => {
      const target = document.getElementById(`item-${kind}-${key}`)
      if (target === null) return
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }))
  }
  const selectJob = (job: string): void => {
    selectedJob = job
    why = null
    finishOnTop = false
    reveal('.job-panel')
  }

  const context = $derived<Context | null>(model === null ? null : { inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
  const rows = $derived(model !== null && selectedOption !== null ? model.rows[selectedOption] ?? [] : [])
  const layout = $derived(model !== null && context !== null ? layoutTimeline(model.inputs, rows, context.format) : null)
  const cards = $derived(model !== null && context !== null ? attentionCards(model, context) : [])
  const banner = $derived(model !== null && context !== null ? outcomeBanner(model, context, wide ? 'on the right' : 'below') : null)
  const shifts = $derived(model !== null && context !== null ? shiftList(model.inputs, rows, context.format) : [])
  const shown = $derived(model?.options?.items.find(option => option.key === selectedOption) ?? null)
  const linkedRun = $derived(model?.inputs.settings.run ? runs.find(run => run.id === model?.inputs.settings.run?.id)?.title ?? null : null)
  // Plainly whether this plan is inside the certified size (maint's walk 3, R2-9-01), in one line.
  const size = $derived(model?.certifiedSize ? { line: planSizeLine(model.certifiedSize, model.inputs), evidence: model.certifiedSize.evidence } : null)
  /** Whether the detail column has anything in it; when it has not, the work takes its width. */
  const detailOpen = $derived(choosing !== null || preview !== null || selectedJob !== null || finish !== null || (wide && view === 'schedule' && shown !== null))
  const compared = $derived(model !== null && context !== null ? optionsGlance(model, context) : null)
  const proof = $derived(model !== null && context !== null && shown?.status.word === 'proven infeasible' ? refusalProof(model.refusals[shown.key], context) : null)
  const ladder = $derived(model !== null && context !== null && buys.state === 'ready' ? ladderView(buys.pages, model, context, ladderMethod) : null)
  // The what-ifs' cards, the one asked last first; each refused one with its proof.
  const whatIfs = $derived(model !== null && context !== null
    ? [...whatIfOptions(model)].sort((left, right) => Number(right.key === askedLast) - Number(left.key === askedLast)).map(option => whatIfCard(option, model!, context))
    : [])
  const whatIfProofs = $derived(model !== null && context !== null
    ? Object.fromEntries(whatIfOptions(model).map(option => [option.key, option.status.word === 'proven infeasible' ? refusalProof(model!.refusals[option.key], context) : null]))
    : {})
  const recommendedOption = $derived(planOptions(model ?? { options: null }).find(option => option.key === model?.options?.recommended && option.fresh) ?? null)
  const shownIsWhatIf = $derived(shown !== null && isWhatIf(shown))
  const compareOption = $derived(model?.options?.items.find(option => option.key === compareFor) ?? null)
  // Why recommended and what differs, written from the Module's facts, never from its lines.
  const whyShown = $derived.by((): Answer<WhyView> => {
    const answer = whyAnswer
    if (answer.state !== 'answered') return answer
    return model === null || context === null ? { state: 'loading' } : { state: 'answered', facts: whyView(answer.facts, model, context, whyAgainst !== '') }
  })
  const whyChoices = $derived(recommendedOption === null || model === null ? [] : [
    { value: '', label: 'The next in rank' },
    ...planOptions(model).filter(option => option.fresh && option.status.word === 'validated feasible' && option.key !== recommendedOption.key).map(option => ({ value: option.key, label: option.label })),
  ])
  const compareShown = $derived.by((): Answer<CompareView> => {
    const answer = compareAnswer
    if (answer.state !== 'answered') return answer
    if (compareOption === null || context === null) return { state: 'loading' }
    const earlier = previousSet?.items.find(item => item.key === answer.facts.previous) ?? { label: 'an option of the earlier set' }
    return { state: 'answered', facts: compareView(answer.facts, compareOption, earlier, context) }
  })
  /** The questions under the options table, each offered only where this plan can ask it. */
  const choices = $derived(context === null ? [] : [
    ...crewHourPurchases(context.inputs).length > 0 ? [{ panel: 'ladder' as const, word: 'What overtime buys' }] : [],
    ...whatIfChoices(context).kinds.length > 0 ? [{ panel: 'whatif' as const, word: whatIfs.length > 0 ? `What-ifs (${whatIfs.length})` : 'Ask a what-if' }] : [],
    ...recommendedOption !== null && recommendedOption.status.word === 'validated feasible' ? [{ panel: 'why' as const, word: 'Why recommended?' }] : [],
    ...shown !== null ? [{ panel: 'compare' as const, word: 'Compare with the earlier options' }] : [],
  ])

  const views: ReadonlyArray<{ key: PlanView; word: string }> = [
    { key: 'schedule', word: 'Schedule' }, { key: 'add', word: 'Add jobs and links' }, { key: 'equipment', word: 'Equipment and World' },
    { key: 'crews', word: 'Crews and shifts' }, { key: 'rules', word: 'Rules and goals' }, { key: 'options', word: 'Options' },
  ]

  const actions = $derived(createPlanActions(client, planId, text => { notice = text }))
  const show = (shown: Shown): void => {
    model = shown.model
    selectedOption = shown.option ?? firstRefused(shown.model)
    if (shown.notice !== null) notice = shown.notice
    finish = null
    why = null
    // An open question is asked again of the plan as it now is, so its answer never speaks of the one before.
    if (choosing !== null) ask(choosing)
  }

  /** Asks the Module the open question; a part of Planning not built yet is said as "not available yet". */
  const ask = (question: ChoosePanel): void => {
    const missing = <T,>(cause: unknown): Answer<T> => isNotBuilt(cause) ? { state: 'not-built' }
      : isRequestError(cause) && cause.code === 'no_previous_options' ? { state: 'none' }
        : { state: 'refused', text: refusalText(cause, context?.names.any) }
    if (question === 'ladder') {
      buys = { state: 'loading', pages: [], text: null }
      actions.buys().then(pages => { buys = { state: 'ready', pages, text: null } }, cause => {
        buys = isNotBuilt(cause) ? { state: 'not-built', pages: [], text: null } : { state: 'refused', pages: [], text: refusalText(cause, context?.names.any) }
      })
    } else if (question === 'why') {
      whyAnswer = { state: 'loading' }
      if (model?.options?.recommended == null) whyAnswer = { state: 'refused', text: 'No option is recommended yet. Generate first.' }
      else actions.whyRecommended(whyAgainst === '' ? null : whyAgainst).then(result => { whyAnswer = recommendedAnswer(result) }, cause => { whyAnswer = missing(cause) })
    } else if (question === 'compare') {
      const option = selectedOption
      compareFor = option
      compareAnswer = { state: 'loading' }
      if (option === null) { compareAnswer = { state: 'refused', text: 'Show an option on the timeline first.' }; return }
      // The earlier set comes first: it says whether there is one, and which of its options to compare with.
      actions.previous().then(async page => {
        previousSet = page
        const against = previousFor(model?.options?.items.find(item => item.key === option) ?? null, page, compareAgainst)
        compareAgainst = against
        compareUnpaired = page.at !== null && page.items.length > 0 && against === null
        if (page.at === null || against === null) { compareAnswer = { state: 'none' }; return }
        const result = await actions.versus(option, against)
        compareCursor = result.more ?? null
        compareMore = null
        compareAnswer = versusAnswer(result)
      }).catch(cause => { compareAnswer = missing(cause) })
    }
  }
  /** Opens a question beside the timeline, on top of the detail column; a second click on its button closes it. */
  const openChoice = (question: ChoosePanel, toggle = false): void => {
    if (toggle && choosing === question) { choosing = null; return }
    choosing = question
    // One explanation at a time beside the timeline: the finish chain gives way.
    finish = null
    limiting = null
    if (question === 'whatif') whatIfMissing = null
    ask(question)
    reveal('.choose-panel')
  }
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    busy = true
    error = null
    errorCause = null
    try { await work() } catch (cause) {
      fail(cause)
      if (isRequestError(cause) && cause.code === 'plan_revision_conflict') await actions.load(selectedOption).then(show, () => undefined)
    } finally { busy = false }
  }
  /** Runs an action on the plan as shown now; nothing runs before the plan is read. */
  const withModel = (work: (current: PlanModel) => Promise<void>): void => {
    const current = model
    if (current !== null) void attempt(() => work(current))
  }

  onMount(() => {
    const detailColumn = window.matchMedia('(min-width: 1280px)')
    const follow = (): void => { wide = detailColumn.matches }
    follow()
    detailColumn.addEventListener('change', follow)
    void attempt(async () => {
      if (model === null) show(await actions.load(null))
      runs = await actions.runs(model?.inputs.settings.scenario?.id)
    })
    return () => detailColumn.removeEventListener('change', follow)
  })

  const gate = createPreviewGate()
  const previewEdits = (edits: readonly Edit[], label: string): void => {
    if (!gate.request({ edits, label })) {
      notice = `Generating… “${label}” is previewed when Generate ends.`
      return
    }
    runPreview(edits, label)
  }
  const runPreview = (edits: readonly Edit[], label: string): void => withModel(async current => {
    pending = edits
    preview = await actions.preview(current, edits, label)
    finishOnTop = false
    reveal('.preview')
  })
  const apply = (authority: { name: string; reason: string } | null): void => withModel(async current => {
    const shown = await actions.apply(current, pending, authority, selectedOption, preview?.label ?? 'the change')
    // The goals as they were before the first goal change saved here, for "Undo goal changes made since you opened this plan".
    if (earlierGoals === null && pending.some(edit => edit.edit === 'goals')) earlierGoals = current.inputs.goals
    preview = null
    applied += 1
    show(shown)
    onChanged()
  })
  const useTime = (instant: string): void => {
    const lock = pending.find(edit => edit.edit === 'job' && 'lock' in edit)
    if (lock !== undefined && lock.edit === 'job') previewEdits([{ edit: 'job', key: lock.key, lock: instant }], preview?.label ?? 'Fix the start')
  }
  const link = (run: string): void => withModel(async current => { show(await actions.link(current, run, selectedOption)); onChanged() })
  const refresh = (): void => withModel(async current => { show(await actions.refresh(current, selectedOption)); onChanged() })
  /**
   * Runs one use of the solver at a time (Generate, the ladder's rungs, a what-if), with Cancel in the header;
   * a preview asked for meanwhile waits and goes when it ends.
   */
  const solve = (work: (current: PlanModel, signal: AbortSignal) => Promise<void>): void => {
    const current = model
    if (current === null || generating !== null) return
    const controller = new AbortController()
    generating = controller
    gate.start()
    error = null
    errorCause = null
    void (async () => {
      try { await work(current, controller.signal) } catch (cause) { fail(cause) } finally {
        generating = null
        // A preview asked for during the run goes now, against the plan as Generate left it.
        const held = gate.end()
        if (held !== null) runPreview(held.edits, held.label)
      }
    })()
  }
  const generate = (input: GenerateInput): void => solve(async (current, signal) => {
    const shown = await actions.generate(current, input, signal, selectedOption)
    show(shown)
    error = shown.error
    errorCause = shown.cause
    onChanged()
    const cleared = whatIfsClearedNotice(whatIfOptions(current), whatIfOptions(shown.model))
    if (cleared !== null) notice = cleared
  })
  /** Works out the rungs of "what overtime buys" still to solve, lowest first. */
  const solveLadder = (): void => {
    const missing = context === null ? [] : (ladder?.toSolve ?? []).map(rung => ({ name: rung.name, request: rungRequest(rung, context) }))
    if (missing.length === 0 || model === null || generating !== null) return
    solving = true
    solve(async (current, signal) => {
      try {
        const shown = await actions.solveRungs(current, missing, signal, selectedOption)
        show(shown)
        onChanged()
        if (shown.error === null) notice = shown.notice ?? 'Every rung of what overtime buys is worked out on this plan.'
        else if (isNotBuilt(shown.error)) { notice = null; buys = { state: 'not-built', pages: [], text: null } }
        else { notice = null; fail(shown.error) }
      } finally { solving = false }
    })
  }
  /** Asks one what-if; its answer is a card beside the timeline, and the timeline keeps what it showed. */
  const askWhatIf = (label: string, variant: WhatIfVariant): void => {
    if (model === null || generating !== null) return
    asking = true
    whatIfMissing = null
    solve(async (current, signal) => {
      try {
        const shown = await actions.whatIf(current, variant, signal, selectedOption)
        askedLast = shown.asked
        show(shown)
        notice = whatIfAskedNotice(label, whatIfOptions(current), whatIfOptions(shown.model), wide)
        onChanged()
      } catch (cause) {
        if (signal.aborted) notice = 'Cancelled. Nothing was asked.'
        else whatIfMissing = isNotBuilt(cause) ? 'What-ifs are not available yet in this version of Planning.' : refusalText(cause, context?.names.any)
      } finally { asking = false }
    })
  }
  const showOption = (option: string): void => withModel(async current => {
    model = await actions.rows(current, option)
    selectedOption = option
    finish = null
    why = null
    view = 'schedule'
    // What differs is asked of the option on the timeline, so it follows the one shown.
    if (choosing === 'compare') { compareAgainst = null; ask('compare') }
  })
  const explainFinish = (): void => {
    const shownContext = context
    if (shownContext !== null) void attempt(async () => { const answer = await actions.finish(shownContext, selectedOption); choosing = null; finish = answer.steps; limiting = answer.limiting; finishOnTop = true; reveal('.finish-panel') })
  }
  const explainStart = (job: string): void => {
    const shownContext = context
    if (shownContext === null) return
    void attempt(async () => {
      const answer = await actions.whyStart(shownContext, selectedOption, job, rows)
      why = answer.why
      if (answer.notice !== null) notice = answer.notice
    })
  }
  const baseline = (option: string, name: string, note: string): void => withModel(async current => { show(await actions.baseline(current, option, name, note)); onChanged() })
  const onAction = (action: CardAction): void => {
    if (action === 'open-workspace') onOpenWorkspace()
    else if (action === 'link-run' || action === 'add-work') view = 'equipment'
    else if (action === 'refresh') refresh()
    else if (action === 'generate') generate({})
    else if (action === 'why-recommended') openChoice('why')
    else if (action === 'align-window') {
      const now = model === null ? null : simulationNow(model.inputs)
      const built = model === null || now === null ? null : alignWindowEdit(model.inputs, now)
      const window = built?.ok ? built.edits.find(edit => edit.edit === 'plan')?.window : undefined
      if (built?.ok && window !== undefined && context !== null) previewEdits(built.edits, `Align the window to the simulation: ${context.format.when(window.start)} to ${context.format.when(window.end)}`)
    }
    else explainFinish()
  }
  const findRuns = (): void => { void attempt(async () => { runs = await actions.runs(model?.inputs.settings.scenario?.id) }) }
  const search = async (text: string): Promise<readonly PlanningSubject[]> => model === null ? [] : actions.search(model, text)
  const detail = async (locator: string): Promise<PlanningSubject> => {
    if (model === null) throw new Error('The plan is not read yet.')
    return actions.detail(model, locator)
  }
</script>

{#snippet optionDetail()}
  {#if shown && model && context}
    {#if shownIsWhatIf}
      <!-- A what-if shown on the timeline keeps its card; with the what-ifs open, that card is already there. -->
      {#if choosing !== 'whatif'}
        <section class="shown-option" aria-labelledby="shown-title">
          <h2 id="shown-title">Shown on the timeline</h2>
          <WhatIfCard card={whatIfCard(shown, model, context)} {proof} selected busy={busy || generating !== null} onSelect={showOption} onPick={pick} />
        </section>
      {/if}
    {:else}
      <section class="shown-option" aria-labelledby="shown-title">
        <h2 id="shown-title">{shown.label}</h2>
        {#if requestText(shown, model.inputs)}<p class="hint">{requestText(shown, model.inputs)}</p>{/if}
        <StatusBlock view={statusView(shown.status, context)} warnings={otherWarnings(shown)} caution={sizeCautionOf(shown)} stale={!shown.fresh} {proof} onPick={pick} />
      </section>
    {/if}
  {/if}
{/snippet}

{#snippet finishPanel()}
  {#if finish !== null}<FinishPanel steps={finish} {limiting} onPick={pick} onClose={() => { finish = null; limiting = null }} />{/if}
{/snippet}

{#snippet choosePanel()}
  {#if model && context && choosing !== null}
    <div class="choose-panel">
      {#if choosing === 'ladder'}
        <Ladder view={ladder} state={buys.state} text={buys.text} busy={busy || generating !== null} {solving} selected={selectedOption} onSolve={solveLadder}
          onFiner={() => { whatIfKind = 'out'; openChoice('whatif') }} onSelect={showOption} onMethod={next => { ladderMethod = next }} onPick={pick} onClose={() => { choosing = null }} />
      {:else if choosing === 'whatif'}
        {#key whatIfKind}
          <WhatIfPanel {context} cards={whatIfs} proofs={whatIfProofs} kind={whatIfKind} selected={selectedOption} busy={busy || generating !== null} {asking} missing={whatIfMissing}
            onAsk={askWhatIf} onSelect={showOption} onPick={pick} onClose={() => { choosing = null; whatIfKind = null }} />
        {/key}
      {:else if choosing === 'why'}
        {#if recommendedOption}
          <WhyRecommended title={`Why “${recommendedOption.label}” is recommended`} policy={policyLines(context)} answer={whyShown} choices={whyChoices} against={whyAgainst} onAgainst={option => { whyAgainst = option; ask('why') }} onClose={() => { choosing = null }} />
        {:else}
          <section class="why-panel"><div class="panel-heading"><h2 tabindex="-1">Why recommended</h2><button type="button" class="quiet" onclick={() => { choosing = null }}>Close</button></div><p class="hint">No option is recommended on the plan as it is now. Generate first.</p></section>
        {/if}
      {:else if compareOption}
        <ComparePanel answer={compareShown} unpaired={compareUnpaired} more={compareMore} onMore={compareCursor === null ? undefined : readMoreMoved} previous={previousSet === null ? [] : previousRows(previousSet)} against={compareAgainst} onAgainst={option => { compareAgainst = option; ask('compare') }} onClose={() => { choosing = null }} />
      {/if}
    </div>
  {/if}
{/snippet}

{#if model !== null && context !== null}
  <div class="plan-screen">
    <p class="back"><button type="button" class="link" onclick={onOpenLibrary}>← All plans</button></p>
    <PlanHeader {context} title={model.title} {size} generating={generating !== null} {busy} onGenerate={generate} onCancel={() => generating?.abort()} />
    {#if error}<ErrorNotice text={error} cause={errorCause} />{/if}
    {#if notice}<p class="notice" aria-live="polite">{notice}</p>{/if}
    {#if banner}
      <section class="outcome" class:refused={!banner.recommended} aria-labelledby="outcome-title">
        <p id="outcome-title" class="outcome-title">{banner.title}</p>
        {#if banner.lines.length > 0}<ul>{#each banner.lines as line, index (index)}<li>{line}</li>{/each}</ul>{/if}
      </section>
    {/if}
    <div class="screen-grid" class:no-detail={!detailOpen}>
      <div class="col-attention">
        <p class="phone-only jump"><a href="#plan-views">Jump to the plan views and forms</a></p>
        <AttentionColumn {cards} busy={busy || generating !== null} {onAction} />
        <Glance sections={glance(context)} />
        <div class="phone-only"><ShiftList {shifts} /></div>
      </div>
      <nav class="views" id="plan-views" aria-label="Plan views">
        {#each views as item (item.key)}<button type="button" class:current={view === item.key} aria-pressed={view === item.key} onclick={() => { view = item.key }}>{item.word}</button>{/each}
      </nav>
      <div class="col-main">
        {#if view === 'schedule'}
          {#if compared}<OptionsGlance glance={compared} selected={selectedOption} {busy} shownWhatIf={shownIsWhatIf ? shown?.label ?? null : null} {choices} open={choosing} onSelect={showOption} onChoose={question => openChoice(question, true)} />{/if}
          {#if !wide}{@render optionDetail()}{/if}
          {#if layout}<div class="desktop-only"><Timeline {layout} selected={selectedJob} onSelect={selectJob} /></div>{/if}
          <WorkList {context} {rows} selected={selectedJob} onSelect={selectJob} />
        {:else if view === 'add'}
          <!-- Each applied change starts the forms afresh (maint's walk 4): nothing stays filled in from it. -->
          {#key applied}<JobForm {context} busy={busy || generating !== null} onPreview={previewEdits} />{/key}
        {:else if view === 'equipment'}
          <!-- The World picker keeps its search and results across an Apply, so several items take one search. -->
          <EquipmentPicker {context} {runs} {linkedRun} busy={busy || generating !== null} onLink={link} onRefresh={refresh} {onOpenWorkspace} onFindRuns={findRuns} onSearch={search} onDetail={detail} onPreview={previewEdits} />
        {:else if view === 'crews'}
          {#key applied}<CrewForm {context} busy={busy || generating !== null} onPreview={previewEdits} />{/key}
        {:else if view === 'rules'}
          {#key applied}<RulesPanel {context} {earlierGoals} busy={busy || generating !== null} onPreview={previewEdits} />{/key}
        {:else}
          <OptionsTable options={planOptions(model)} whatIfs={whatIfs.length} recommended={model.options?.recommended ?? null} {context} refusals={model.refusals} selected={selectedOption} {busy} onSelect={showOption} onBaseline={baseline} onPick={pick} />
        {/if}
      </div>
      <!-- The detail column: a question about the options, an edit's preview, the selected job, what sets the finish, and the shown option. -->
      <div class="col-panel" bind:this={panel}>
        {@render choosePanel()}
        {#if finishOnTop}{@render finishPanel()}{/if}
        {#if preview}
          <EditPreview {preview} {pending} {context} {busy} onApply={apply} onDiscard={() => { preview = null }} onUseTime={useTime} onAddEdits={extra => previewEdits([...pending, ...extra], preview?.label ?? 'the change')} />
        {:else if selectedJob}
          {#key applied}<JobPanel jobKey={selectedJob} {context} row={rows.find(row => row.job === selectedJob)} scheduled={rows.length === 0 ? null : new Set(rows.map(row => row.job))} {why} busy={busy || generating !== null} onWhy={explainStart} onPick={pick} onPreview={previewEdits} onClose={() => { selectedJob = null; why = null }} />{/key}
        {/if}
        {#if !finishOnTop}{@render finishPanel()}{/if}
        {#if wide && view === 'schedule'}{@render optionDetail()}{/if}
      </div>
    </div>
  </div>
{:else if error}
  <div class="plan-screen"><ErrorNotice text={error} cause={errorCause} /><button type="button" onclick={onOpenLibrary}>← All plans</button></div>
{:else}
  <p class="loading">Opening the plan…</p>
{/if}
