<script lang="ts">
  import { onMount } from 'svelte'
  import type { ModuleCapabilityDescriptor,ModuleResourceDescriptor } from '@leitbild/contracts'
  import { jsonRequest,request,type RequestError } from './api.ts'

  interface RunClock {
    readonly currentTime: string
    readonly paused: boolean
    readonly speed: number
    readonly updatedAt: string
  }

  interface RunOrigin {
    readonly kind: 'fork'
    readonly sourceRunId: string
    readonly sourceSequence: number
    readonly forkedAt: string
  }

  interface RunSummary {
    readonly id: string
    readonly title: string
    readonly clock: RunClock | null
    readonly origin: RunOrigin | null
  }

  interface AccelerationJob {
    readonly status: 'running' | 'paused' | 'completed' | 'failed'
    readonly startedSimulationTime: string
    readonly targetSimulationTime: string
    readonly currentSimulationTime: string
    readonly startedAt: string
    readonly updatedAt: string
    readonly activeWallMs: number
    readonly simulatedMs: number
    readonly measuredSpeed: number
    readonly error?: string
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
    readonly refreshResources: () => Promise<void>
    readonly reportError: (message: string) => void
  }

  let { workspaceId,resource,resources,capabilities,onSwitch,refreshResources,reportError }: Props = $props()
  let summary = $state<RunSummary | null>(null)
  let acceleration = $state<AccelerationJob | null>(null)
  let actionBusy = $state(false)
  let actionError = $state('')
  let minutes = $state(60)
  let copyName = $state('')
  let wallNow = $state(Date.now())
  let dialog = $state<HTMLDialogElement | null>(null)
  let refreshToken = 0

  const capabilityAvailable = (id: string): boolean =>
    resource.capabilityIds.includes(id) && capabilities.some(capability => capability.id === id)

  const invoke = async <T>(target: ModuleResourceDescriptor['ref'], capabilityId: string, input: unknown): Promise<InvocationResponse<T>> =>
    await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`,
      jsonRequest('POST', { resource: target, input, actor: { kind: 'human' } }))

  const refresh = async (): Promise<void> => {
    const token = ++refreshToken
    try {
      const [nextSummary,nextAcceleration] = await Promise.all([
        invoke<RunSummary>(resource.ref, 'world.simulation-run.read', {}),
        invoke<AccelerationJob | null>(resource.ref, 'world.simulation-run.acceleration.read', {}),
      ])
      if (token !== refreshToken) return
      summary = nextSummary.result
      acceleration = nextAcceleration.result
    } catch (cause) {
      if (token === refreshToken) reportError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (actionBusy) return
    actionBusy = true
    actionError = ''
    try { await action() }
    catch (cause) {
      const error = cause as RequestError
      actionError = cause instanceof Error ? cause.message : String(cause)
      const activeRunId = typeof error.details?.activeRunId === 'string' ? error.details.activeRunId : null
      if (activeRunId && resources.some(candidate => candidate.ref.id === activeRunId)) {
        actionError = `${actionError}. Switch to the active Run from the header.`
      }
    } finally {
      actionBusy = false
      await refresh()
      await refreshResources()
    }
  }

  const startAcceleration = (): void => {
    if (!Number.isFinite(minutes) || minutes <= 0) return
    void runAction(async () => {
      acceleration = (await invoke<AccelerationJob>(resource.ref, 'world.simulation-run.acceleration.start', { minutes })).result
    })
  }

  const forkAndAccelerate = (): void => {
    if (!Number.isFinite(minutes) || minutes <= 0) return
    void runAction(async () => {
      const forked = await invoke<{ readonly id: string }>(resource.ref, 'world.simulation-run.fork', {
        ...(copyName.trim() === '' ? {} : { name: copyName.trim() }),
      })
      const forkId = forked.result.id
      const forkRef = { ...resource.ref, id: forkId }
      await refreshResources()
      onSwitch(forkId)
      acceleration = (await invoke<AccelerationJob>(forkRef, 'world.simulation-run.acceleration.start', { minutes })).result
      copyName = ''
    })
  }

  const forkOnly = (): void => {
    void runAction(async () => {
      const forked = await invoke<{ readonly id: string }>(resource.ref, 'world.simulation-run.fork', {
        ...(copyName.trim() === '' ? {} : { name: copyName.trim() }),
      })
      await refreshResources()
      onSwitch(forked.result.id)
      copyName = ''
    })
  }

  const pauseAcceleration = (): void => {
    void runAction(async () => {
      acceleration = (await invoke<AccelerationJob>(resource.ref, 'world.simulation-run.acceleration.pause', {})).result
    })
  }

  const toggleWallClock = (): void => {
    if (!summary?.clock || acceleration?.status === 'running') return
    void runAction(async () => {
      const clock = (await invoke<RunClock>(resource.ref, 'world.simulation-run.clock.set', {
        paused: !summary!.clock!.paused,
        ...(!summary!.clock!.paused ? {} : { speed: 1 }),
      })).result
      summary = { ...summary!, clock }
    })
  }

  const displayTime = $derived.by((): string => {
    const acceleratedTime = acceleration?.status === 'running' ? acceleration.currentSimulationTime : null
    if (acceleratedTime) return new Date(acceleratedTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const clock = summary?.clock
    if (!clock) return '--:--:--'
    const base = Date.parse(clock.currentTime)
    const updated = Date.parse(clock.updatedAt)
    const value = clock.paused || !Number.isFinite(updated) ? base : base + Math.max(0, wallNow - updated) * clock.speed
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  })

  const family = $derived.by(() => {
    const runs = resources.filter(candidate => candidate.ref.type === 'world.simulation-run')
    const ids = new Set<string>([resource.ref.id])
    let changed = true
    while (changed) {
      changed = false
      for (const candidate of runs) {
        const related = candidate.links
          .filter(link => (link.rel === 'fork' || link.rel === 'fork-of') && link.ref.type === 'world.simulation-run')
          .map(link => link.ref.id)
        if (!ids.has(candidate.ref.id) && !related.some(id => ids.has(id))) continue
        if (!ids.has(candidate.ref.id)) { ids.add(candidate.ref.id); changed = true }
        for (const id of related) if (!ids.has(id)) { ids.add(id); changed = true }
      }
    }
    return runs.filter(candidate => ids.has(candidate.ref.id))
  })

  $effect(() => {
    resource.ref.id
    void refresh()
  })

  onMount(() => {
    const tick = setInterval(() => { wallNow = Date.now() }, 250)
    const poll = setInterval(() => { void refresh() }, 1_500)
    return () => { clearInterval(tick); clearInterval(poll) }
  })
</script>

<div class="run-controls" aria-label="Simulation controls">
  {#if family.length > 1}
    <label class="family" title="Switch between the source Run and its what-if copies">
      <span aria-hidden="true">⑂</span>
      <select value={resource.ref.id} onchange={event => onSwitch(event.currentTarget.value)} aria-label="Switch Simulation Run">
        {#each family as member (member.ref.id)}<option value={member.ref.id}>{member.title}</option>{/each}
      </select>
    </label>
  {/if}
  <button class="clock-toggle" type="button" disabled={!summary?.clock || acceleration?.status === 'running' || actionBusy} onclick={toggleWallClock} title={summary?.clock?.paused ? 'Resume at normal speed' : 'Pause simulation'} aria-label={summary?.clock?.paused ? 'Resume at normal speed' : 'Pause simulation'}>{summary?.clock?.paused ? '▶' : 'Ⅱ'}</button>
  <span class="clock" class:accelerating={acceleration?.status === 'running'} title={acceleration?.status === 'running' ? `Accelerating at ${acceleration.measuredSpeed.toFixed(1)}× measured` : summary?.clock?.paused ? 'Simulation paused' : 'Simulation running'}>{displayTime}{#if acceleration?.status === 'running'} <small>{acceleration.measuredSpeed.toFixed(1)}×</small>{/if}</span>
  <button class="timer" class:active={acceleration?.status === 'running'} type="button" onclick={() => dialog?.showModal()} title="Acceleration and what-if copies" aria-label="Acceleration and what-if copies">⏱</button>
</div>

<dialog class="acceleration-dialog" bind:this={dialog}>
  <header><div><small>Simulation time</small><h2>{resource.title}</h2></div><button class="close" type="button" onclick={() => dialog?.close()} aria-label="Close">×</button></header>
  {#if acceleration}
    <section class="progress" class:running={acceleration.status === 'running'}>
      <strong>{acceleration.status === 'running' ? 'Accelerating' : acceleration.status === 'completed' ? 'Target reached' : acceleration.status}</strong>
      <span>{new Date(acceleration.currentSimulationTime).toLocaleString()} → {new Date(acceleration.targetSimulationTime).toLocaleString()}</span>
      <span>{acceleration.measuredSpeed.toFixed(1)}× measured · {(acceleration.activeWallMs / 1000).toFixed(1)} s compute time</span>
      {#if acceleration.error}<span class="error">{acceleration.error}</span>{/if}
    </section>
  {/if}
  {#if acceleration?.status === 'running'}
    <button class="primary" type="button" disabled={actionBusy} onclick={pauseAcceleration}>{actionBusy ? 'Pausing…' : 'Pause at next boundary'}</button>
  {:else}
    <label>Simulated minutes<input type="number" min="0.01" max="10080" step="1" bind:value={minutes} /></label>
    <div class="actions"><button class="primary" type="button" disabled={actionBusy || !capabilityAvailable('world.simulation-run.acceleration.start')} onclick={startAcceleration}>{actionBusy ? 'Starting…' : 'Accelerate this Run'}</button></div>
    <hr />
    <label>What-if copy name <span>(optional)</span><input maxlength="120" bind:value={copyName} placeholder={`${resource.title} — what-if copy`} /></label>
    <div class="actions"><button type="button" disabled={actionBusy || !capabilityAvailable('world.simulation-run.fork')} onclick={forkOnly}>Create copy</button><button class="primary" type="button" disabled={actionBusy || !capabilityAvailable('world.simulation-run.fork')} onclick={forkAndAccelerate}>Create copy and accelerate</button></div>
  {/if}
  {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
  <p class="hint">Live external feeds cannot invent future observations and will explicitly reject acceleration.</p>
</dialog>

<style>
  .run-controls { min-width: 0; margin-left: auto; display: flex; align-items: center; gap: .35rem; color: #dfe8dc; }
  button, select { min-height: 28px; border: 1px solid #536157; border-radius: 6px; color: inherit; background: #243128; font: inherit; }
  button { min-width: 30px; padding: 0 .45rem; cursor: pointer; }
  button:hover, select:hover { border-color: #87958a; background: #314037; }
  button:disabled { opacity: .45; cursor: wait; }
  .clock { min-width: 78px; padding: 0 .25rem; color: #cbd6cc; font: 600 .74rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; }
  .clock small { margin-left: .25rem; color: #8ec6ff; font-size: .62rem; }
  .clock.accelerating { color: #d8ecff; }
  .timer.active { border-color: #65a9ea; color: #b9dcff; background: #1c4261; }
  .family { max-width: min(280px, 28vw); display: flex; align-items: center; gap: .25rem; color: #aebbb0; }
  .family select { max-width: 240px; padding: 0 .4rem; overflow: hidden; text-overflow: ellipsis; font-size: .7rem; }
  .acceleration-dialog { width: min(520px, calc(100vw - 2rem)); padding: 0; border: 1px solid #aeb9ad; border-radius: 14px; color: #172019; background: #f6f8f4; box-shadow: 0 24px 70px #0006; }
  .acceleration-dialog::backdrop { background: #0a100b99; backdrop-filter: blur(2px); }
  .acceleration-dialog > header { padding: 1rem 1.1rem; display: flex; align-items: start; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #d5ddd3; }
  .acceleration-dialog h2 { margin: .1rem 0 0; font-size: 1.05rem; }
  .acceleration-dialog header small, .hint, .progress span, label span { color: #687269; }
  .acceleration-dialog > :not(header) { margin-left: 1.1rem; margin-right: 1.1rem; }
  .acceleration-dialog > :last-child { margin-bottom: 1.1rem; }
  .acceleration-dialog .close { min-width: 32px; min-height: 32px; padding: 0; border-color: #b8c1b6; color: #334139; background: #fff; font-size: 1.2rem; }
  .acceleration-dialog label { margin-top: 1rem; display: grid; gap: .35rem; color: #4c584e; font-size: .82rem; font-weight: 650; }
  .acceleration-dialog input { width: 100%; min-height: 38px; padding: .55rem .65rem; border: 1px solid #bdc7bb; border-radius: 7px; background: #fff; font: inherit; }
  .progress { margin-top: 1rem; padding: .8rem; display: grid; gap: .25rem; border: 1px solid #cbd5c9; border-radius: 8px; background: #fff; font-size: .8rem; }
  .progress.running { border-color: #65a9ea; box-shadow: inset 3px 0 #3988d1; }
  .actions { margin-top: .75rem; display: flex; flex-wrap: wrap; gap: .5rem; }
  .acceleration-dialog .actions button, .acceleration-dialog > button { min-height: 38px; padding: .5rem .75rem; border-color: #aeb9ad; color: #213026; background: #fff; }
  .acceleration-dialog .actions button.primary, .acceleration-dialog > button.primary { border-color: #263c2b; color: #f5fff2; background: #263c2b; }
  hr { margin-top: 1rem; border: 0; border-top: 1px solid #d5ddd3; }
  .error { color: #9a2e28 !important; }
  .hint { font-size: .72rem; line-height: 1.4; }
  @media (max-width: 700px) { .family { display: none; } .clock { min-width: 70px; } }
</style>
