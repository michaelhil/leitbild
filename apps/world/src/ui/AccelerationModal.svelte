<script lang="ts">
  import ModalShell from './components/ModalShell.svelte'
  import type { AccelerationJobState } from './types.ts'

  interface Props {
    readonly job: AccelerationJobState | null
    readonly busy: boolean
    readonly error: string
    readonly createdPath: string
    readonly close: () => void
    readonly createCopy: (minutes: number, name?: string) => Promise<void>
    readonly continueRun: (minutes: number) => Promise<void>
    readonly pause: () => Promise<void>
  }
  let { job, busy, error, createdPath, close, createCopy, continueRun, pause }: Props = $props()
  let minutes = $state(60)
  let name = $state('')
  const submit = (): void => {
    if (!Number.isFinite(minutes) || minutes <= 0) return
    if (job) void continueRun(minutes)
    else void createCopy(minutes, name.trim() || undefined)
  }
  const formatTime = (value: string): string => new Date(value).toLocaleString()
</script>

<ModalShell title="Accelerated copy" {close} size="small">
  <div class="stack">
    {#if job}
      <div class="status" class:running={job.status === 'running'}>
        <strong>{job.status === 'running' ? 'Computing' : job.status}</strong>
        <span>{formatTime(job.currentSimulationTime)} → {formatTime(job.targetSimulationTime)}</span>
        <span>{job.measuredSpeed.toFixed(1)}× measured · {(job.activeWallMs / 1000).toFixed(1)} s compute time</span>
      </div>
      {#if job.error}<p class="error">{job.error}</p>{/if}
      {#if job.status === 'running'}
        <button class="secondary" disabled={busy} onclick={() => void pause()}>Pause accelerated execution</button>
      {:else}
        <label>Additional simulated minutes<input type="number" min="0.01" max="10080" step="1" bind:value={minutes} /></label>
        <button disabled={busy} onclick={submit}>{busy ? 'Starting…' : 'Run further'}</button>
      {/if}
    {:else}
      <p>Create an independent copy at the Run’s current coherent state. The source keeps running unchanged; the copy advances as fast as its Packs can calculate and pauses at the target.</p>
      <label>Simulated minutes<input type="number" min="0.01" max="10080" step="1" bind:value={minutes} /></label>
      <label>Copy name <span>(optional)</span><input maxlength="120" bind:value={name} placeholder="Accelerated copy" /></label>
      <button disabled={busy} onclick={submit}>{busy ? 'Creating…' : 'Create and run copy'}</button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
    {#if createdPath}<a class="open" href={createdPath} target="_blank" rel="noopener">Open accelerated copy</a>{/if}
    <small>Live external feeds cannot be accelerated because future observations are not simulated.</small>
  </div>
</ModalShell>

<style>
  .stack { display: grid; gap: 14px; }
  p { margin: 0; line-height: 1.45; }
  label { display: grid; gap: 6px; font-weight: 650; }
  label span, small, .status span { color: var(--text-muted, #64748b); font-weight: 400; }
  input { min-height: 38px; border: 1px solid var(--border-subtle, #cbd5e1); border-radius: 6px; padding: 0 10px; background: var(--surface, white); color: inherit; font: inherit; }
  button, .open { min-height: 38px; border: 0; border-radius: 6px; padding: 0 14px; background: #2563eb; color: white; cursor: pointer; font: inherit; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
  button:disabled { opacity: .55; cursor: wait; }
  button.secondary { background: #334155; }
  .status { display: grid; gap: 5px; padding: 12px; border: 1px solid var(--border-subtle, #cbd5e1); border-radius: 7px; }
  .status.running { border-color: #3b82f6; }
  .error { color: #dc2626; }
</style>
