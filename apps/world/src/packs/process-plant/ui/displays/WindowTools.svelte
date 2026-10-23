<script lang="ts">
  import { ChevronDown, ChevronRight, Ellipsis, FileText, GitBranch, History, Library, ShieldCheck, Sparkles, X, Zap } from 'lucide-svelte'
  import type { PackWindowToolsProps } from '../../../../core/packs/protocol.ts'
  import { invokeSimulationRunCapability } from '../../../../ui/simulation-run-client.ts'
  import { runOnMount } from '../../../../ui/svelte-lifecycle.svelte.ts'
  import { processPlantActionInvokeCommandKind } from '../../command-kinds.ts'
  import type { ProcessPlantActionCatalogEntry, ProcessPlantArtifactKind } from '../plant-client.ts'
  import type { ProposalListEntry } from './operation/operation-presenter.ts'
  import OperationsLogDialog from './window/OperationsLogDialog.svelte'
  import PlantActionsDialog from './window/PlantActionsDialog.svelte'
  import ProposalsChip from './window/ProposalsChip.svelte'
  import { readPendingProposals, readWindowPlant, reviewSubject, type WindowPlant } from './window/window-operations.ts'
  import { windowUnit } from './window/window-unit.ts'

  // The Plant's tools in the display window's header, for the Plant whose
  // display the window shows (PackUiContribution.windowTools). Its chips: the
  // runtime not started yet; its pending proposals with their count, read
  // every two seconds (QA-10), each opening its item's World default after the
  // shown display, where the item's pop-over carries the card; the procedure
  // its most challenged safety function calls for while no run runs it. Its
  // tools: the operations log, the Run's Assistant where the Host offers it,
  // and More (the component graph, specification and model credibility of
  // the Plant, and the Plant catalog); apart under their own label, the
  // Instructor's scenario events and faults, which are not operator actions
  // and show only where this screen plays the Run's controller. Short of room,
  // the chips stay and the tools are items of the window's More menu. The
  // window keeps one of these per Plant it shows.

  let { runId, object, openDisplay, controller, openAssistant, runningProcedures, openProcedure, room, menu }: PackWindowToolsProps = $props()

  type Engineering =
    | { readonly kind: 'artifact'; readonly artifact: ProcessPlantArtifactKind }
    | { readonly kind: 'credibility' }
    | { readonly kind: 'catalog' }

  const PROPOSALS_EVERY_MS = 2_000
  const menuId = $props.id()

  let plant = $state.raw<WindowPlant | null>(null)
  let unavailable = $state<string | null>(null)
  let proposals = $state.raw<ReadonlyArray<ProposalListEntry>>([])
  // A failed read of the proposals stays with the chip that reads them, never over the display, until a read succeeds.
  let proposalsFailure = $state<string | null>(null)
  let open = $state<'more' | 'instructor' | null>(null)
  let actionsOpen = $state(false)
  let logOpen = $state(false)
  let engineering = $state.raw<Engineering | null>(null)
  let ArtifactModal = $state.raw<typeof import('../ProcessPlantArtifactModal.svelte').default | null>(null)
  let CredibilityModal = $state.raw<typeof import('../ProcessPlantCredibilityModal.svelte').default | null>(null)
  let CatalogModal = $state.raw<typeof import('../ProcessPlantCatalogModal.svelte').default | null>(null)
  let runningActionId = $state<string | null>(null)
  // What became of the last Instructor action or read: sent reads neutral, accepted as success, anything else as an error.
  let notice = $state<{ readonly text: string; readonly tone: 'neutral' | 'success' | 'error' } | null>(null)
  let moreButton = $state<HTMLButtonElement | null>(null)
  let instructorButton = $state<HTMLButtonElement | null>(null)
  let menuElement = $state<HTMLElement | null>(null)
  // Where focus goes back to when a dialog closes: the tool that opened it, or the window's More button.
  let returnFocus: HTMLElement | null = null
  let disposed = false

  const objectId = $derived(object.id)
  const folded = $derived(room === 'folded')
  const unit = $derived(windowUnit(object, { running: runningProcedures, controller }))
  // The engineering views and the Instructor's actions are a Plant's (the Pack's other objects have none).
  const isPlant = $derived(unit !== null)
  const instructorOffered = $derived(unit?.instructor === true)

  const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err)

  $effect(() => {
    const plantId = objectId
    plant = null
    unavailable = null
    proposals = []
    proposalsFailure = null
    readWindowPlant(runId, plantId).then(
      read => { if (!disposed && objectId === plantId) plant = read },
      err => { if (!disposed && objectId === plantId) unavailable = `The Plant cannot be read: ${errorText(err)}` },
    )
    let reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      try {
        proposals = await readPendingProposals(runId, plantId)
        proposalsFailure = null
      } catch (err) {
        proposalsFailure = `Pending proposals cannot be read: ${errorText(err)}`
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, PROPOSALS_EVERY_MS)
    return () => clearInterval(timer)
  })

  // Folded, the tools are the window's More menu items; unfolded, the window lists none of them.
  $effect(() => {
    menu(folded ? foldedTools : null)
    return () => menu(null)
  })
  $effect(() => {
    if (folded) open = null
  })

  const trigger = (which: 'more' | 'instructor'): HTMLElement | null => which === 'more' ? moreButton : instructorButton

  const closeMenu = (returnFocusToTrigger: boolean): void => {
    const which = open
    if (which === null) return
    open = null
    if (returnFocusToTrigger) trigger(which)?.focus()
  }

  // Opened from the header, a dialog gives focus back to the tool's button; from the window's More menu, to its More
  // button, which has focus once the menu closed.
  const opener = (from: HTMLElement | null): HTMLElement | null =>
    folded ? (document.activeElement instanceof HTMLElement ? document.activeElement : null) : from

  const restoreFocus = (): void => {
    const to = returnFocus
    returnFocus = null
    if (to?.isConnected) to.focus()
  }

  const openLog = (from: HTMLElement | null): void => {
    if (plant === null) return
    returnFocus = opener(from)
    logOpen = true
  }

  const closeLog = (): void => {
    logOpen = false
    restoreFocus()
  }

  const openActions = (): void => {
    open = null
    if (plant === null) return
    returnFocus = opener(instructorButton)
    actionsOpen = true
  }

  const closeActions = (): void => {
    actionsOpen = false
    restoreFocus()
  }

  const engineeringName = (next: Engineering): string =>
    next.kind === 'catalog' ? 'The Plant catalog' : next.kind === 'credibility' ? 'The model credibility'
      : next.artifact === 'authored-spec' ? 'The Plant specification' : 'The component graph'

  // Each opens in a modal of its own, loaded when first asked for.
  const openEngineering = async (next: Engineering): Promise<void> => {
    open = null
    returnFocus = opener(moreButton)
    try {
      if (next.kind === 'artifact') ArtifactModal ??= (await import('../ProcessPlantArtifactModal.svelte')).default
      else if (next.kind === 'credibility') CredibilityModal ??= (await import('../ProcessPlantCredibilityModal.svelte')).default
      else CatalogModal ??= (await import('../ProcessPlantCatalogModal.svelte')).default
      if (!disposed) engineering = next
    } catch (err) {
      if (!disposed) notice = { text: `${engineeringName(next)} cannot be opened: ${errorText(err)}`, tone: 'error' }
    }
  }

  const closeEngineering = (): void => {
    engineering = null
    restoreFocus()
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || open === null) return
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
  }

  // The display samples the Plant every second, so an action shows there without a reload; the notice says what
  // became of it: sent, then accepted or refused with the Plant's reason, or why it could not be sent.
  const runAction = async (target: WindowPlant, action: ProcessPlantActionCatalogEntry, parameters: Readonly<Record<string, number>>): Promise<void> => {
    if (runningActionId !== null) return
    actionsOpen = false
    runningActionId = action.id
    const named = `Instructor action "${action.title}" on ${target.label}`
    notice = { text: `${named}: sent…`, tone: 'neutral' }
    try {
      const response = await invokeSimulationRunCapability(runId, {
        capabilityId: processPlantActionInvokeCommandKind,
        input: { plantId: target.plantId, actionId: action.id, parameters },
      })
      if (response.kind !== 'command') throw new Error(`${processPlantActionInvokeCommandKind} is not a command`)
      if (!disposed) notice = response.result.ok ? { text: `${named}: accepted.`, tone: 'success' } : { text: `${named}: refused. ${response.result.reason}`, tone: 'error' }
    } catch (err) {
      if (!disposed) notice = { text: `${named} could not be sent: ${errorText(err)}`, tone: 'error' }
    } finally {
      if (!disposed) runningActionId = null
    }
  }

  runOnMount(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target
      if (open === null || !(target instanceof Node)) return
      if (menuElement?.contains(target) || trigger(open)?.contains(target)) return
      open = null
    }
    document.addEventListener('pointerdown', outside, true)
    return () => {
      disposed = true
      document.removeEventListener('pointerdown', outside, true)
    }
  })
</script>

{#snippet engineeringItems(done: () => void, role: 'menuitem' | undefined)}
  {#if isPlant}
    <button type="button" class="display-window-menu-item" {role} onclick={() => { done(); void openEngineering({ kind: 'artifact', artifact: 'compiled-graph-mermaid' }) }}>
      <GitBranch size={16} aria-hidden="true" />
      <span>Component graph</span>
    </button>
    <button type="button" class="display-window-menu-item" {role} onclick={() => { done(); void openEngineering({ kind: 'artifact', artifact: 'authored-spec' }) }}>
      <FileText size={16} aria-hidden="true" />
      <span>Plant specification</span>
    </button>
    <button type="button" class="display-window-menu-item" {role} onclick={() => { done(); void openEngineering({ kind: 'credibility' }) }}>
      <ShieldCheck size={16} aria-hidden="true" />
      <span>Model credibility</span>
    </button>
    <hr class="menu-rule" />
  {/if}
  <button type="button" class="display-window-menu-item" {role} onclick={() => { done(); void openEngineering({ kind: 'catalog' }) }}>
    <Library size={16} aria-hidden="true" />
    <span>Plant catalog</span>
  </button>
{/snippet}

{#snippet instructorItem(done: () => void, role: 'menuitem' | undefined)}
  <button
    type="button"
    class="display-window-menu-item"
    {role}
    title={plant !== null ? '' : (unavailable ?? '')}
    aria-disabled={plant === null}
    onclick={() => { done(); openActions() }}
  >
    <Zap size={16} aria-hidden="true" />
    <span>{plant !== null ? `Scenario events and faults on ${plant.label}…` : `Scenario events and faults: ${unavailable ?? 'the Plant is still being read'}`}</span>
  </button>
{/snippet}

<!-- The window's More menu, while the header is short of room: every tool, the Instructor's apart under its label. -->
{#snippet foldedTools(done: () => void)}
  <button
    type="button"
    class="display-window-menu-item"
    title={plant !== null ? '' : (unavailable ?? '')}
    aria-disabled={plant === null}
    onclick={() => { done(); openLog(null) }}
  >
    <History size={16} aria-hidden="true" />
    <span>{plant !== null ? `Operations log of ${plant.label}` : `Operations log: ${unavailable ?? 'the Plant is still being read'}`}</span>
  </button>
  {#if openAssistant !== null}
    <button type="button" class="display-window-menu-item" onclick={() => { done(); openAssistant() }}>
      <Sparkles size={16} aria-hidden="true" />
      <span>Assistant</span>
    </button>
  {/if}
  {@render engineeringItems(done, undefined)}
  {#if instructorOffered}
    <div class="menu-label">Instructor</div>
    {@render instructorItem(done, undefined)}
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="display-window-plant" role="group" aria-label="Plant" onkeydown={keydown}>
  {#if unit !== null && !unit.started}
    <span class="not-started" role="status" title="The Plant's runtime has not started yet: its display has no readings, alarms or procedures to show">Not started</span>
  {/if}
  <ProposalsChip entries={proposals} failure={proposalsFailure} open={entry => openDisplay(reviewSubject(objectId, entry))} />
  {#if unit?.notRunning}
    {@const called = unit.notRunning}
    <button
      type="button"
      class="not-running"
      aria-label="{called.procedureId} not running: open it in the procedure window"
      title={`${called.why}\nOpen ${called.procedureId} in the procedure window`}
      onclick={() => openProcedure(called.procedureId)}
    >
      <!-- Folded, the words give way to the window's title; the procedure stays, its full name read out. -->
      <span>{room === 'folded' ? called.procedureId : `${called.procedureId} not running`}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  {/if}
  {#if !folded}
    <button
      type="button"
      class="display-window-button"
      aria-label={plant !== null ? `Operations log of ${plant.label}` : `Operations log unavailable: ${unavailable ?? 'the Plant is still being read'}`}
      title={plant !== null ? `Operations log of ${plant.label}: what people and AI agents did and proposed` : (unavailable ?? '')}
      aria-disabled={plant === null}
      onclick={(event) => openLog(event.currentTarget)}
    >
      <History size={17} aria-hidden="true" />
    </button>
    {#if openAssistant !== null && room === 'wide'}
      <button type="button" class="display-window-button" aria-label="Open the Run's Assistant" title="Assistant: open the Run's Assistant room" onclick={openAssistant}>
        <Sparkles size={17} aria-hidden="true" />
      </button>
    {/if}
    <button
      bind:this={moreButton}
      type="button"
      class="display-window-button"
      aria-label="More about {object.label}"
      title="More: {isPlant ? 'component graph, specification, model credibility, ' : ''}Plant catalog"
      aria-haspopup="menu"
      aria-expanded={open === 'more'}
      aria-controls={open === 'more' ? `${menuId}-more` : undefined}
      onclick={() => { open = open === 'more' ? null : 'more' }}
    >
      <Ellipsis size={17} aria-hidden="true" />
    </button>
    {#if open === 'more'}
      <div bind:this={menuElement} id="{menuId}-more" class="display-window-popover more tools-menu" role="menu" aria-label="More about {object.label}">
        <!-- Short of room, the Assistant gives way to the window's title and stands first here. -->
        {#if openAssistant !== null && room === 'short'}
          <button type="button" class="display-window-menu-item" role="menuitem" onclick={() => { open = null; openAssistant() }}>
            <Sparkles size={16} aria-hidden="true" />
            <span>Assistant</span>
          </button>
        {/if}
        {@render engineeringItems(() => undefined, 'menuitem')}
      </div>
    {/if}
  {/if}
</div>
{#if !folded && instructorOffered}
  <!-- The instructor's tools sit apart from the operator's, under their own label: injecting a fault is not an operator action. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="display-window-instructor" role="group" aria-label="Instructor" onkeydown={keydown}>
    <button
      bind:this={instructorButton}
      type="button"
      class="display-window-instructor-button"
      aria-label="Instructor"
      aria-haspopup="menu"
      aria-expanded={open === 'instructor'}
      aria-controls={open === 'instructor' ? `${menuId}-instructor` : undefined}
      title="Instructor tools: scenario events and faults"
      onclick={() => { open = open === 'instructor' ? null : 'instructor' }}
    >
      <Zap size={15} aria-hidden="true" />
      {#if room === 'wide'}<span>Instructor</span>{/if}
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {#if open === 'instructor'}
      <div bind:this={menuElement} id="{menuId}-instructor" class="display-window-popover instructor tools-menu" role="menu" aria-label="Instructor">
        {@render instructorItem(() => undefined, 'menuitem')}
      </div>
    {/if}
  </div>
{/if}

{#if notice !== null}
  <div class="process-display-notice tools-notice" class:neutral={notice.tone === 'neutral'} class:success={notice.tone === 'success'} role="status">
    <span>{notice.text}</span>
    <button type="button" aria-label="Dismiss" onclick={() => { notice = null }}><X size={16} aria-hidden="true" /></button>
  </div>
{/if}

{#if logOpen && plant !== null}
  <OperationsLogDialog simulationRunId={runId} {plant} close={closeLog} />
{/if}

{#if actionsOpen && plant !== null}
  <PlantActionsDialog
    simulationRunId={runId}
    {plant}
    {runningActionId}
    run={(target, action, parameters) => { void runAction(target, action, parameters) }}
    close={closeActions}
  />
{/if}

{#if engineering?.kind === 'artifact' && ArtifactModal !== null}
  <ArtifactModal simulationRunId={runId} plantId={objectId} artifact={engineering.artifact} close={closeEngineering} />
{:else if engineering?.kind === 'credibility' && CredibilityModal !== null}
  <CredibilityModal simulationRunId={runId} plantId={objectId} close={closeEngineering} />
{:else if engineering?.kind === 'catalog' && CatalogModal !== null}
  <CatalogModal simulationRunId={runId} close={closeEngineering} />
{/if}

<style>
  /* Below the header, over the display, as the window's own notices stand. */
  .tools-notice { top: 50px; }

  /* Said in words beside the Plant's tools: a pending runtime has nothing to show yet. */
  .not-started {
    flex: 0 0 auto;
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* The procedure the worst safety function calls for, one press from the procedure window: the accent, as "New ›". */
  .display-window-plant .not-running {
    padding: 0 6px 0 8px;
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    font-weight: 650;
  }

  /* A menu of the header's own takes the header's button style otherwise: its items read as the window's menu items. */
  .tools-menu .display-window-menu-item {
    justify-content: flex-start;
    padding: 0 8px;
    color: var(--text);
  }

  .menu-rule {
    width: 100%;
    margin: 2px 0;
    border: 0;
    border-top: 1px solid var(--border);
  }

  .menu-label {
    padding: 6px 8px 2px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
</style>
