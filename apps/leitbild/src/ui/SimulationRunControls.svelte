<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { ModuleCapabilityDescriptor, ModuleResourceDescriptor } from '@leitbild/contracts'
  import { jsonRequest, request } from './api.ts'

  interface RunClock {
    readonly currentTime: string
    readonly paused: boolean
    readonly speed: number
    readonly updatedAt: string
  }

  interface RunSummary {
    readonly id: string
    readonly title: string
    readonly clock: RunClock | null
  }
  interface FastForwardState {
    readonly kind: 'continuous' | 'timed'
    readonly status: 'running' | 'stopped' | 'completed' | 'failed'
    readonly startedSimulationTime: string
    readonly targetSimulationTime?: string
    readonly currentSimulationTime: string
    readonly onComplete: 'paused' | 'realtime'
    readonly startedAt: string
    readonly updatedAt: string
    readonly activeWallMs: number
    readonly simulatedMs: number
    readonly measuredSpeed: number
    readonly error?: string
  }
  interface ExecutionState {
    readonly mode: 'paused' | 'realtime' | 'fast-forward'
    readonly currentSimulationTime: string
    readonly updatedAt: string
    readonly fastForward: FastForwardState | null
  }
  interface InvocationResponse<T> {
    readonly result: T
    readonly createdResources?: ReadonlyArray<ModuleResourceDescriptor['ref']>
  }

  interface Props {
    readonly workspaceId: string
    readonly resource: ModuleResourceDescriptor
    readonly resources: ReadonlyArray<ModuleResourceDescriptor>
    readonly capabilities: ReadonlyArray<ModuleCapabilityDescriptor>
    readonly onSwitch: (runId: string) => void
    readonly onClose: () => void
    readonly refreshResources: () => Promise<void>
    readonly reportError: (message: string) => void
  }

  let { workspaceId, resource, resources, capabilities, onSwitch, onClose, refreshResources, reportError }: Props = $props()
  let summary = $state<RunSummary | null>(null)
  let execution = $state<ExecutionState | null>(null)
  let actionBusy = $state(false)
  let actionError = $state('')
  let minutes = $state(60)
  let onComplete = $state<'paused' | 'realtime'>('paused')
  let copyName = $state('')
  let wallNow = $state(Date.now())
  let copyDialog = $state<HTMLDialogElement | null>(null)
  let timerDialog = $state<HTMLDialogElement | null>(null)
  let familyOpen = $state(false)
  let editingRunId = $state<string | null>(null)
  let editingName = $state('')
  let renameInput = $state<HTMLInputElement | null>(null)
  let notice = $state('')
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let refreshToken = 0

  const capabilityAvailableFor = (candidate: ModuleResourceDescriptor, id: string): boolean =>
    candidate.capabilityIds.includes(id) && capabilities.some(capability => capability.id === id)
  const capabilityAvailable = (id: string): boolean => capabilityAvailableFor(resource, id)
  const invoke = async <T>(target: ModuleResourceDescriptor['ref'], capabilityId: string, input: unknown): Promise<InvocationResponse<T>> =>
    await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`,
      jsonRequest('POST', { resource: target, input, actor: { kind: 'human' } }))
  const familyId = (candidate: ModuleResourceDescriptor): string =>
    candidate.links.find(link => link.rel === 'run-family' && link.ref.type === 'world.simulation-run')?.ref.id ?? candidate.ref.id
  const family = $derived(resources
    .filter(candidate => candidate.ref.type === 'world.simulation-run' && familyId(candidate) === familyId(resource))
    .sort((left, right) => {
      const rootId = familyId(resource)
      if (left.ref.id === rootId) return -1
      if (right.ref.id === rootId) return 1
      return left.title.localeCompare(right.title)
    }))

  const nextCopyName = (): string => {
    let number = Math.max(1, family.length)
    let candidate = `${resource.title} - copy ${number}`
    const names = new Set(family.map(member => member.title))
    while (names.has(candidate)) { number += 1; candidate = `${resource.title} - copy ${number}` }
    return candidate
  }
  const refresh = async (): Promise<void> => {
    const token = ++refreshToken
    try {
      const [nextSummary,nextExecution] = await Promise.all([
        invoke<RunSummary>(resource.ref, 'world.simulation-run.read', {}),
        invoke<ExecutionState>(resource.ref, 'world.simulation-run.execution.read', {}),
      ])
      if (token !== refreshToken) return
      summary = nextSummary.result
      execution = nextExecution.result
    } catch (cause) { if (token === refreshToken) reportError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (actionBusy) return
    actionBusy = true
    actionError = ''
    try { await action() }
    catch (cause) {
      actionError = cause instanceof Error ? cause.message : String(cause)
      reportError(actionError)
    } finally {
      actionBusy = false
    }
  }
  const showNotice = (message: string): void => {
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    notice = message
    noticeTimer = setTimeout(() => { notice = ''; noticeTimer = null }, 2_000)
  }
  const openCopyDialog = (): void => {
    copyName = nextCopyName()
    copyDialog?.showModal()
  }
  const createCopy = (): void => {
    void runAction(async () => {
      const response = await invoke<{ readonly id: string; readonly title: string }>(resource.ref, 'world.simulation-run.copy', copyName.trim() === '' ? {} : { name: copyName.trim() })
      await refreshResources()
      copyDialog?.close()
      onSwitch(response.result.id)
      showNotice(`You are now in ${response.result.title}`)
    })
  }
  const setMode = (mode: ExecutionState['mode']): void => {
    void runAction(async () => {
      execution = (await invoke<ExecutionState>(resource.ref, 'world.simulation-run.execution.set', { mode })).result
    })
  }
  const togglePlay = (): void => setMode(execution?.mode === 'paused' ? 'realtime' : 'paused')
  const toggleFastForward = (): void => setMode(execution?.mode === 'fast-forward' ? 'paused' : 'fast-forward')
  const advanceByDuration = (): void => {
    if (!Number.isFinite(minutes) || minutes <= 0) return
    void runAction(async () => {
      execution = (await invoke<ExecutionState>(resource.ref, 'world.simulation-run.execution.advance', { minutes, onComplete })).result
      timerDialog?.close()
    })
  }
  const switchRun = (id: string): void => {
    familyOpen = false
    editingRunId = null
    if (id !== resource.ref.id) onSwitch(id)
  }
  const startRename = async (member: ModuleResourceDescriptor): Promise<void> => {
    editingRunId = member.ref.id
    editingName = member.title
    await tick()
    renameInput?.focus()
    renameInput?.select()
  }
  const cancelRename = (): void => {
    editingRunId = null
    editingName = ''
  }
  const toggleFamily = (): void => {
    familyOpen = !familyOpen
    if (!familyOpen) cancelRename()
  }
  const saveRename = (member: ModuleResourceDescriptor): void => {
    const name = editingName.trim()
    void runAction(async () => {
      await invoke(member.ref, 'world.simulation-run.rename', { name: name === '' ? null : name, expectedTitle: member.title })
      await refreshResources()
      cancelRename()
    })
  }
  const handleRenameKey = (event: KeyboardEvent, member: ModuleResourceDescriptor): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      saveRename(member)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelRename()
    }
  }
  const deleteRun = (member: ModuleResourceDescriptor): void => {
    if (!confirm(`Delete ${member.title}? This cannot be undone.`)) return
    const deletingCurrent = member.ref.id === resource.ref.id
    void runAction(async () => {
      await invoke(member.ref, 'world.simulation-run.delete', {})
      const remaining = family.filter(candidate => candidate.ref.id !== member.ref.id)
      await refreshResources()
      familyOpen = false
      if (deletingCurrent) remaining.length > 0 ? onSwitch(remaining[0]!.ref.id) : onClose()
    })
  }
  const displayTime = $derived.by((): string => {
    if (execution?.mode === 'fast-forward') return new Date(execution.currentSimulationTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const clock = summary?.clock
    if (!clock) return '--:--:--'
    const base = Date.parse(clock.currentTime)
    const updated = Date.parse(clock.updatedAt)
    const value = clock.paused || !Number.isFinite(updated) ? base : base + Math.max(0, wallNow - updated) * clock.speed
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  })

  $effect(() => {
    resource.ref.id
    familyOpen = false
    editingRunId = null
    void refresh()
  })
  onMount(() => {
    const clockTicker = setInterval(() => { wallNow = Date.now() }, 250)
    const poll = setInterval(() => { void refresh() }, 1_000)
    const closeFamily = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest('.family-control')) {
        familyOpen = false
        cancelRename()
      }
    }
    window.addEventListener('pointerdown', closeFamily)
    return () => {
      clearInterval(clockTicker)
      clearInterval(poll)
      if (noticeTimer !== null) clearTimeout(noticeTimer)
      window.removeEventListener('pointerdown', closeFamily)
    }
  })
</script>

<div class="run-controls" aria-label="Simulation controls">
  {#if family.length > 1}<div class="family-control">
    <button class="family-trigger" type="button" aria-haspopup="true" aria-expanded={familyOpen} onclick={toggleFamily} title={resource.title}>
      <span class="family-label">{resource.title}</span><span aria-hidden="true">⌄</span>
    </button>
    {#if familyOpen}
      <div class="family-menu" role="group" aria-label="Run copies">
        {#each family as member (member.ref.id)}
          <div class:current={member.ref.id === resource.ref.id}>
            {#if editingRunId === member.ref.id}
              <input class="family-name-input" maxlength="120" aria-label={`Name for ${member.title}`} bind:this={renameInput} bind:value={editingName} onkeydown={(event) => handleRenameKey(event, member)} />
            {:else}
              <button class="family-member" type="button" aria-current={member.ref.id === resource.ref.id ? 'true' : undefined} title={member.title} onclick={() => switchRun(member.ref.id)}>{member.title}</button>
            {/if}
            <button class="family-rename" type="button" disabled={actionBusy || !capabilityAvailableFor(member, 'world.simulation-run.rename')} aria-label={`Rename ${member.title}`} title={`Rename ${member.title}`} onclick={() => void startRename(member)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button>
            <button class="family-delete" type="button" aria-label={`Delete ${member.title}`} title={`Delete ${member.title}`} onclick={() => deleteRun(member)}>×</button>
          </div>
        {/each}
      </div>
    {/if}
  </div>{:else}<span class="run-title" title={resource.title}>{resource.title}</span>{/if}
  <button type="button" disabled={actionBusy || !capabilityAvailable('world.simulation-run.copy')} onclick={openCopyDialog} title="Copy this Run" aria-label="Copy this Run"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
  <button type="button" disabled={!execution || actionBusy || !capabilityAvailable('world.simulation-run.execution.set')} onclick={togglePlay} title={execution?.mode === 'paused' ? 'Play in realtime' : 'Pause simulation'} aria-label={execution?.mode === 'paused' ? 'Play in realtime' : 'Pause simulation'}>{#if execution?.mode === 'paused'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 4 13 8-13 8z"/></svg>{:else}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>{/if}</button>
  <button class:active={execution?.mode === 'fast-forward'} type="button" disabled={!execution || actionBusy || !capabilityAvailable('world.simulation-run.execution.set')} onclick={toggleFastForward} title={execution?.mode === 'fast-forward' ? 'Stop fast-forward and pause' : 'Fast-forward at maximum speed'} aria-label={execution?.mode === 'fast-forward' ? 'Stop fast-forward and pause' : 'Fast-forward at maximum speed'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 5 9 7-9 7zM12 5l9 7-9 7z"/></svg></button>
  <span class:fast={execution?.mode === 'fast-forward'} class="clock" title={execution?.mode === 'fast-forward' ? `Fast-forwarding at ${execution.fastForward?.measuredSpeed.toFixed(1) ?? '0.0'}× measured` : execution?.mode === 'paused' ? 'Simulation paused' : 'Simulation running in realtime'}>{displayTime}{#if execution?.mode === 'fast-forward'}<small>{execution.fastForward?.measuredSpeed.toFixed(1) ?? '0.0'}×</small>{/if}</span>
  <button class:active={execution?.fastForward?.kind === 'timed' && execution?.fastForward?.status === 'running'} type="button" disabled={actionBusy || !capabilityAvailable('world.simulation-run.execution.advance')} onclick={() => timerDialog?.showModal()} title="Fast-forward by a fixed duration" aria-label="Fast-forward by a fixed duration"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2h6M12 14l3-3M12 6a8 8 0 1 0 8 8 8 8 0 0 0-8-8z"/></svg></button>
</div>
{#if actionError}<div class="control-error" role="alert">{actionError}</div>{/if}
{#if notice}<div class="switch-notice" role="status">{notice}</div>{/if}

<dialog class="control-dialog" bind:this={copyDialog}>
  <header><div><small>Independent Run</small><h2>Copy {resource.title}</h2></div><button class="close" type="button" onclick={() => copyDialog?.close()} aria-label="Close">×</button></header>
  <label>Copy name <span>(optional)</span><input maxlength="120" bind:value={copyName} /></label>
  <div class="actions"><button class="primary" type="button" disabled={actionBusy} onclick={createCopy}>{actionBusy ? 'Copying…' : 'Create copy'}</button></div>
  <p class="hint">The copy starts paused at the current simulation boundary. It can then run or fast-forward independently.</p>
</dialog>

<dialog class="control-dialog" bind:this={timerDialog}>
  <header><div><small>Simulation time</small><h2>Fast-forward by duration</h2></div><button class="close" type="button" onclick={() => timerDialog?.close()} aria-label="Close">×</button></header>
  {#if execution?.fastForward?.kind === 'timed' && execution.fastForward.status === 'running'}
    <section class="progress"><strong>Fast-forwarding · {execution.fastForward.measuredSpeed.toFixed(1)}×</strong><span>{new Date(execution.fastForward.currentSimulationTime).toLocaleString()} → {execution.fastForward.targetSimulationTime ? new Date(execution.fastForward.targetSimulationTime).toLocaleString() : ''}</span></section>
    <div class="actions"><button class="primary" type="button" disabled={actionBusy} onclick={() => setMode('paused')}>Stop and pause</button></div>
  {:else}
    <label>Simulated minutes<input type="number" min="0.01" max="10080" step="1" bind:value={minutes} /></label>
    <fieldset><legend>When the target is reached</legend><label class="choice"><input type="radio" value="paused" bind:group={onComplete} /> Pause</label><label class="choice"><input type="radio" value="realtime" bind:group={onComplete} /> Play in realtime</label></fieldset>
    <div class="actions"><button class="primary" type="button" disabled={actionBusy} onclick={advanceByDuration}>{actionBusy ? 'Starting…' : 'Start fast-forward'}</button></div>
  {/if}
  <p class="hint">Live external feeds cannot invent future observations and will reject fast-forward.</p>
</dialog>

<style>
  .run-controls { min-width: 0; margin-left: auto; display: flex; align-items: center; gap: .35rem; color: #dfe8dc; }
  button { min-width: 30px; min-height: 28px; padding: 0 .45rem; border: 1px solid #536157; border-radius: 6px; color: inherit; background: #243128; font: inherit; cursor: pointer; }
  button:hover { border-color: #87958a; background: #314037; } button:disabled { opacity: .45; cursor: wait; } button.active { border-color: #65a9ea; color: #b9dcff; background: #1c4261; }
  button svg { width: 16px; height: 16px; display: block; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .clock { min-width: 112px; padding: 0 .25rem; color: #cbd6cc; font: 600 .74rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; white-space: nowrap; } .clock small { margin-left: .28rem; color: #8ec6ff; font-size: .64rem; } .clock.fast { color: #d8ecff; }
  .family-control { position: relative; min-width: 0; } .family-trigger { max-width: min(250px, 24vw); display: flex; align-items: center; gap: .35rem; font-size: .7rem; } .family-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-title { max-width: min(250px, 24vw); overflow: hidden; color: #dfe8dc; font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
  .family-menu { position: absolute; z-index: 80; top: calc(100% + .4rem); right: 0; width: min(360px, calc(100vw - 2rem)); padding: .35rem; border: 1px solid #647168; border-radius: 9px; background: #18231c; box-shadow: 0 14px 38px #0008; }
  .family-menu > div { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; border-radius: 6px; } .family-menu > div.current { background: #2a3d30; }
  .family-member { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; background: transparent; text-align: left; } .family-delete { border: 0; color: #d8a7a3; background: transparent; font-size: 1rem; }
  .family-rename { min-width: 28px; padding: 0 .35rem; border: 0; color: #b9c6bc; background: transparent; } .family-rename svg { width: 14px; height: 14px; }
  .family-name-input { min-width: 0; margin: .2rem .35rem; padding: .38rem .45rem; border: 1px solid #7f9d87; border-radius: 5px; color: #f4faf5; background: #111a14; font: inherit; outline: none; } .family-name-input:focus { border-color: #a6c5ad; box-shadow: 0 0 0 2px #5d8f6a55; }
  .control-error { position: fixed; z-index: 120; top: 3rem; right: 1rem; max-width: min(440px, calc(100vw - 2rem)); padding: .65rem .8rem; border-radius: 8px; color: #fff; background: #8e302b; box-shadow: 0 8px 24px #0005; font-size: .78rem; }
  .switch-notice { position: fixed; z-index: 140; top: 50%; left: 50%; translate: -50% -50%; max-width: min(520px, calc(100vw - 2rem)); padding: 1.1rem 1.4rem; border: 1px solid #8da596; border-radius: 12px; color: #f5fff6; background: #15241ddb; box-shadow: 0 20px 60px #0007; backdrop-filter: blur(8px); font-size: 1rem; font-weight: 700; text-align: center; pointer-events: none; }
  .control-dialog { width: min(500px, calc(100vw - 2rem)); padding: 0; border: 1px solid #aeb9ad; border-radius: 14px; color: #172019; background: #f6f8f4; box-shadow: 0 24px 70px #0006; } .control-dialog::backdrop { background: #0a100b99; backdrop-filter: blur(2px); }
  .control-dialog > header { padding: 1rem 1.1rem; display: flex; align-items: start; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #d5ddd3; } .control-dialog h2 { margin: .1rem 0 0; font-size: 1.05rem; }
  .control-dialog header small, .hint, .progress span, .control-dialog label span { color: #687269; } .control-dialog > :not(header) { margin-left: 1.1rem; margin-right: 1.1rem; } .control-dialog > :last-child { margin-bottom: 1.1rem; }
  .control-dialog .close { min-width: 32px; min-height: 32px; padding: 0; border-color: #b8c1b6; color: #334139; background: #fff; font-size: 1.2rem; }
  .control-dialog > label { margin-top: 1rem; display: grid; gap: .35rem; color: #4c584e; font-size: .82rem; font-weight: 650; } .control-dialog > label input { width: 100%; min-height: 38px; padding: .55rem .65rem; border: 1px solid #bdc7bb; border-radius: 7px; background: #fff; font: inherit; }
  fieldset { margin-top: 1rem !important; padding: .7rem .8rem; display: flex; gap: 1rem; border: 1px solid #cbd5c9; border-radius: 8px; } fieldset legend { padding: 0 .25rem; color: #4c584e; font-size: .78rem; font-weight: 650; } label.choice { display: flex; align-items: center; gap: .35rem; font-size: .8rem; }
  .progress { margin-top: 1rem; padding: .8rem; display: grid; gap: .25rem; border: 1px solid #65a9ea; border-radius: 8px; background: #fff; box-shadow: inset 3px 0 #3988d1; font-size: .8rem; }
  .actions { margin-top: .85rem; display: flex; justify-content: flex-end; gap: .5rem; } .control-dialog .actions button { min-height: 38px; padding: .5rem .8rem; border-color: #aeb9ad; color: #213026; background: #fff; } .control-dialog .actions button.primary { border-color: #263c2b; color: #f5fff2; background: #263c2b; }
  .hint { font-size: .72rem; line-height: 1.4; } @media (max-width: 760px) { .family-control, .run-title { display: none; } .clock { min-width: 96px; } }
</style>
