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
  import { outcomeBanner } from './outcome.ts'
  import type { FinishStep, WhyStart } from './explain-text.ts'
  import { createTimeFormat } from './format.ts'
  import { certifiedSizeWords, measuredSizeWords } from '../plan/summary.ts'
  import JobForm from './JobForm.svelte'
  import JobPanel from './JobPanel.svelte'
  import { createNames, type PlanModel, type PlanView, type RunChoice } from './model.ts'
  import OptionsTable from './OptionsTable.svelte'
  import PlanHeader from './PlanHeader.svelte'
  import type { Preview } from './preview.ts'
  import RulesPanel from './RulesPanel.svelte'
  import { alignWindowEdit, simulationNow } from './edit-forms.ts'
  import { createPlanActions, type Shown } from './plan-actions.ts'
  import { revealPanel } from './reveal.ts'
  import { shiftList } from './shift-list.ts'
  import ShiftList from './ShiftList.svelte'
  import StatusBlock from './StatusBlock.svelte'
  import { statusView, type Context } from './status-text.ts'
  import Timeline from './Timeline.svelte'
  import { layoutTimeline } from './timeline-layout.ts'
  import WorkList from './WorkList.svelte'

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
  let selectedOption = $state<string | null>(initial?.options?.recommended ?? null)
  let busy = $state(false)
  let generating = $state<AbortController | null>(null)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let finish = $state<readonly FinishStep[] | null>(null)
  let why = $state<WhyStart | null>(null)
  let preview = $state<Preview | null>(null)
  let pending = $state<readonly Edit[]>([])
  let panel = $state<HTMLElement | undefined>(undefined)

  /** After a preview or a selected job appears, bring the panel into view and focus its heading. */
  const reveal = (): void => {
    // After the panel has rendered and laid out, so its heading has its final place on the page.
    void tick().then(() => requestAnimationFrame(() => {
      if (panel !== undefined) revealPanel(panel, window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    }))
  }
  const selectJob = (job: string): void => {
    selectedJob = job
    why = null
    reveal()
  }

  const context = $derived<Context | null>(model === null ? null : { inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
  const rows = $derived(model !== null && selectedOption !== null ? model.rows[selectedOption] ?? [] : [])
  const layout = $derived(model !== null && context !== null ? layoutTimeline(model.inputs, rows, context.format) : null)
  const cards = $derived(model !== null && context !== null ? attentionCards(model, context) : [])
  const banner = $derived(model !== null && context !== null ? outcomeBanner(model, context) : null)
  const shifts = $derived(model !== null && context !== null ? shiftList(model.inputs, rows, context.format) : [])
  const shown = $derived(model?.options?.items.find(option => option.key === selectedOption) ?? null)
  const linkedRun = $derived(model?.inputs.settings.run ? runs.find(run => run.id === model?.inputs.settings.run?.id)?.title ?? null : null)
  const certified = $derived(model?.certifiedSize ? { text: certifiedSizeWords(model.certifiedSize), measured: measuredSizeWords(model.certifiedSize), evidence: model.certifiedSize.evidence } : null)

  const views: ReadonlyArray<{ key: PlanView; word: string }> = [
    { key: 'schedule', word: 'Schedule' }, { key: 'add', word: 'Add jobs and links' }, { key: 'equipment', word: 'Equipment and World' },
    { key: 'crews', word: 'Crews and shifts' }, { key: 'rules', word: 'Rules and goals' }, { key: 'options', word: 'Options' },
  ]

  const actions = $derived(createPlanActions(client, planId, text => { notice = text }))
  const show = (shown: Shown): void => {
    model = shown.model
    selectedOption = shown.option
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
    void attempt(async () => {
      if (model === null) show(await actions.load(null))
      runs = await actions.runs(model?.inputs.settings.scenario?.id)
    })
  })

  const previewEdits = (edits: readonly Edit[], label: string): void => withModel(async current => {
    pending = edits
    preview = await actions.preview(current, edits, label)
    reveal()
  })
  const apply = (authority: { name: string; reason: string } | null): void => withModel(async current => {
    const shown = await actions.apply(current, pending, authority, selectedOption, preview?.label ?? 'the change')
    preview = null
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
    error = null
    void (async () => {
      try {
        const shown = await actions.generate(current, input, controller.signal, selectedOption)
        show(shown)
        error = shown.error
        onChanged()
      } catch (cause) { error = refusalText(cause, context?.names.any) } finally { generating = null }
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
    if (shownContext !== null) void attempt(async () => { finish = await actions.finish(shownContext, selectedOption) })
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
      if (built?.ok) previewEdits(built.edits, 'Align the window to the simulation')
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

{#if model !== null && context !== null}
  <div class="plan-screen">
    <p class="back"><button type="button" class="link" onclick={onOpenLibrary}>← All plans</button></p>
    <PlanHeader {context} title={model.title} {certified} generating={generating !== null} {busy} onGenerate={generate} onCancel={() => generating?.abort()} />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if notice}<p class="notice" aria-live="polite">{notice}</p>{/if}
    {#if banner}
      <section class="outcome" class:refused={!banner.recommended} aria-labelledby="outcome-title">
        <p id="outcome-title" class="outcome-title">{banner.title}</p>
        {#if banner.lines.length > 0}<ul>{#each banner.lines as line, index (index)}<li>{line}</li>{/each}</ul>{/if}
      </section>
    {/if}
    <div class="screen-grid">
      <div class="col-attention">
        <p class="phone-only jump"><a href="#plan-views">Jump to the plan views and forms</a></p>
        <AttentionColumn {cards} {finish} busy={busy || generating !== null} {onAction} />
        <Glance sections={glance(context)} />
        <div class="phone-only"><ShiftList {shifts} /></div>
      </div>
      <div class="col-main">
        <nav class="views" id="plan-views" aria-label="Plan views">
          {#each views as item (item.key)}<button type="button" class:current={view === item.key} aria-pressed={view === item.key} onclick={() => { view = item.key }}>{item.word}</button>{/each}
        </nav>
        {#if view === 'schedule'}
          {#if shown}
            <section class="shown-option" aria-labelledby="shown-title">
              <h2 id="shown-title">{shown.label}</h2>
              <StatusBlock view={statusView(shown.status, context)} warnings={shown.warnings.map(warning => warning.text)} stale={!shown.fresh} />
            </section>
          {/if}
          {#if layout}<div class="desktop-only"><Timeline {layout} selected={selectedJob} onSelect={selectJob} /></div>{/if}
          <WorkList {context} {rows} selected={selectedJob} onSelect={selectJob} />
        {:else if view === 'add'}
          <JobForm {context} {busy} onPreview={previewEdits} />
        {:else if view === 'equipment'}
          <EquipmentPicker {context} {runs} {linkedRun} {busy} onLink={link} onRefresh={refresh} {onOpenWorkspace} onFindRuns={findRuns} onSearch={search} onDetail={detail} onPreview={previewEdits} />
        {:else if view === 'crews'}
          <CrewForm {context} {busy} onPreview={previewEdits} />
        {:else if view === 'rules'}
          <RulesPanel {context} {busy} onPreview={previewEdits} />
        {:else}
          <OptionsTable options={model.options?.items ?? []} recommended={model.options?.recommended ?? null} {context} selected={selectedOption} {busy} onSelect={showOption} onBaseline={baseline} />
        {/if}
      </div>
      <div class="col-panel" bind:this={panel}>
        {#if preview}
          <EditPreview {preview} {pending} {context} {busy} onApply={apply} onDiscard={() => { preview = null }} onUseTime={useTime} onAddEdits={extra => previewEdits([...pending, ...extra], preview?.label ?? 'the change')} />
        {:else if selectedJob}
          <JobPanel jobKey={selectedJob} {context} row={rows.find(row => row.job === selectedJob)} scheduled={rows.length === 0 ? null : new Set(rows.map(row => row.job))} {why} {busy} onWhy={explainStart} onPreview={previewEdits} onClose={() => { selectedJob = null; why = null }} />
        {/if}
      </div>
    </div>
  </div>
{:else if error}
  <div class="plan-screen"><p class="error" role="alert">{error}</p><button type="button" onclick={onOpenLibrary}>← All plans</button></div>
{:else}
  <p class="loading">Opening the plan…</p>
{/if}
