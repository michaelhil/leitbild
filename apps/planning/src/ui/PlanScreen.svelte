<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { PlanningSubject } from '@leitbild/contracts'
  import type { Edit } from '../plan/edit-schema.ts'
  import { isRequestError, refusalText, type GenerateInput, type PlanningClient } from './api.ts'
  import { attentionCards, type CardAction } from './attention.ts'
  import AttentionColumn from './AttentionColumn.svelte'
  import CrewForm from './CrewForm.svelte'
  import EditPreview from './EditPreview.svelte'
  import EquipmentPicker from './EquipmentPicker.svelte'
  import Glance from './Glance.svelte'
  import { glance } from './orientation.ts'
  import FinishPanel from './FinishPanel.svelte'
  import OptionsGlance from './OptionsGlance.svelte'
  import { optionsGlance } from './options-glance.ts'
  import { outcomeBanner, refusalProof } from './outcome.ts'
  import type { FinishStep, NameKind, Part, WhyStart } from './explain-text.ts'
  import { createTimeFormat } from './format.ts'
  import { planSizeLine } from './size-text.ts'
  import JobForm from './JobForm.svelte'
  import JobPanel from './JobPanel.svelte'
  import { createNames, type PlanModel, type PlanView, type RunChoice } from './model.ts'
  import OptionsTable from './OptionsTable.svelte'
  import PlanHeader from './PlanHeader.svelte'
  import type { Preview } from './preview.ts'
  import RulesPanel from './RulesPanel.svelte'
  import { alignWindowEdit, simulationNow } from './edit-forms.ts'
  import { createPlanActions, type Shown } from './plan-actions.ts'
  import { createPreviewGate } from './preview-gate.ts'
  import { requestText } from './request.ts'
  import { revealPanel } from './reveal.ts'
  import { shiftList } from './shift-list.ts'
  import ShiftList from './ShiftList.svelte'
  import StatusBlock from './StatusBlock.svelte'
  import { statusView, type Context } from './status-text.ts'
  import Timeline from './Timeline.svelte'
  import { layoutTimeline } from './timeline-layout.ts'
  import WorkList from './WorkList.svelte'

  /**
   * With no option to recommend, the first current option that has no schedule is the one whose status and
   * proof show in the detail column, so the reason is on the screen without a click. It has no rows to read.
   */
  const firstRefused = (plan: PlanModel | null): string | null =>
    plan?.options?.items.find(option => option.fresh && option.status.word !== 'validated feasible')?.key ?? null

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
  let notice = $state<string | null>(null)
  let finish = $state<readonly FinishStep[] | null>(null)
  let limiting = $state<{ readonly parts: readonly Part[] } | null>(null)
  let why = $state<WhyStart | null>(null)
  let preview = $state<Preview | null>(null)
  let pending = $state<readonly Edit[]>([])
  /** Counts applied changes; the forms are keyed on it so each starts empty after an Apply. */
  let applied = $state(0)
  let panel = $state<HTMLElement | undefined>(undefined)
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
    reveal('.job-panel')
  }

  const context = $derived<Context | null>(model === null ? null : { inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
  const rows = $derived(model !== null && selectedOption !== null ? model.rows[selectedOption] ?? [] : [])
  const layout = $derived(model !== null && context !== null ? layoutTimeline(model.inputs, rows, context.format) : null)
  const cards = $derived(model !== null && context !== null ? attentionCards(model, context) : [])
  const banner = $derived(model !== null && context !== null ? outcomeBanner(model, context) : null)
  const shifts = $derived(model !== null && context !== null ? shiftList(model.inputs, rows, context.format) : [])
  const shown = $derived(model?.options?.items.find(option => option.key === selectedOption) ?? null)
  const linkedRun = $derived(model?.inputs.settings.run ? runs.find(run => run.id === model?.inputs.settings.run?.id)?.title ?? null : null)
  // Plainly whether this plan is inside the certified size (maint's walk 3, R2-9-01), in one line.
  const size = $derived(model?.certifiedSize ? { line: planSizeLine(model.certifiedSize, model.inputs), evidence: model.certifiedSize.evidence } : null)
  /** Whether the detail column has anything in it; when it has not, the work takes its width. */
  const detailOpen = $derived(preview !== null || selectedJob !== null || finish !== null || (wide && view === 'schedule' && shown !== null))
  const compared = $derived(model !== null && context !== null ? optionsGlance(model, context) : null)
  const proof = $derived(model !== null && context !== null && shown?.status.word === 'proven infeasible' ? refusalProof(model.refusals[shown.key], context) : null)

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
  }
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    busy = true
    error = null
    try { await work() } catch (cause) {
      error = refusalText(cause, context?.names.any)
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
    reveal('.preview')
  })
  const apply = (authority: { name: string; reason: string } | null): void => withModel(async current => {
    const shown = await actions.apply(current, pending, authority, selectedOption, preview?.label ?? 'the change')
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
  const generate = (input: GenerateInput): void => {
    const current = model
    if (current === null || generating !== null) return
    const controller = new AbortController()
    generating = controller
    gate.start()
    error = null
    void (async () => {
      try {
        const shown = await actions.generate(current, input, controller.signal, selectedOption)
        show(shown)
        error = shown.error
        onChanged()
      } catch (cause) { error = refusalText(cause, context?.names.any) } finally {
        generating = null
        // A preview asked for during the run goes now, against the plan as Generate left it.
        const held = gate.end()
        if (held !== null) runPreview(held.edits, held.label)
      }
    })()
  }
  const showOption = (option: string): void => withModel(async current => {
    model = await actions.rows(current, option)
    selectedOption = option
    finish = null
    why = null
    view = 'schedule'
  })
  const explainFinish = (): void => {
    const shownContext = context
    if (shownContext !== null) void attempt(async () => { const answer = await actions.finish(shownContext, selectedOption); finish = answer.steps; limiting = answer.limiting; reveal('.finish-panel') })
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
    <section class="shown-option" aria-labelledby="shown-title">
      <h2 id="shown-title">{shown.label}</h2>
      {#if requestText(shown, model.inputs)}<p class="hint">{requestText(shown, model.inputs)}</p>{/if}
      <StatusBlock view={statusView(shown.status, context)} warnings={shown.warnings.map(warning => warning.text)} stale={!shown.fresh} {proof} onPick={pick} />
    </section>
  {/if}
{/snippet}

{#if model !== null && context !== null}
  <div class="plan-screen">
    <p class="back"><button type="button" class="link" onclick={onOpenLibrary}>← All plans</button></p>
    <PlanHeader {context} title={model.title} {size} generating={generating !== null} {busy} onGenerate={generate} onCancel={() => generating?.abort()} />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
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
          {#if compared}<OptionsGlance glance={compared} selected={selectedOption} {busy} onSelect={showOption} />{/if}
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
          {#key applied}<RulesPanel {context} busy={busy || generating !== null} onPreview={previewEdits} />{/key}
        {:else}
          <OptionsTable options={model.options?.items ?? []} recommended={model.options?.recommended ?? null} {context} refusals={model.refusals} selected={selectedOption} {busy} onSelect={showOption} onBaseline={baseline} onPick={pick} />
        {/if}
      </div>
      <!-- The detail column: an edit's preview, the selected job, what sets the finish, and the shown option. -->
      <div class="col-panel" bind:this={panel}>
        {#if preview}
          <EditPreview {preview} {pending} {context} {busy} onApply={apply} onDiscard={() => { preview = null }} onUseTime={useTime} onAddEdits={extra => previewEdits([...pending, ...extra], preview?.label ?? 'the change')} />
        {:else if selectedJob}
          {#key applied}<JobPanel jobKey={selectedJob} {context} row={rows.find(row => row.job === selectedJob)} scheduled={rows.length === 0 ? null : new Set(rows.map(row => row.job))} {why} busy={busy || generating !== null} onWhy={explainStart} onPick={pick} onPreview={previewEdits} onClose={() => { selectedJob = null; why = null }} />{/key}
        {/if}
        {#if finish !== null}<FinishPanel steps={finish} {limiting} onPick={pick} onClose={() => { finish = null; limiting = null }} />{/if}
        {#if wide && view === 'schedule'}{@render optionDetail()}{/if}
      </div>
    </div>
  </div>
{:else if error}
  <div class="plan-screen"><p class="error" role="alert">{error}</p><button type="button" onclick={onOpenLibrary}>← All plans</button></div>
{:else}
  <p class="loading">Opening the plan…</p>
{/if}
