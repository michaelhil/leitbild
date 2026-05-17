<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { StartupStep } from './startup.ts'

  export let steps: ReadonlyArray<StartupStep>
  export let retry: () => Promise<void>
  export let close: () => void

  let nowMs = performance.now()
  let retrying = false
  let interval: number | null = null

  const elapsedSeconds = (step: StartupStep): string => {
    if (!step.startedAtMs) return ''
    const endMs = step.completedAtMs ?? nowMs
    const seconds = Math.max(0, (endMs - step.startedAtMs) / 1000)
    if (seconds < 1) return ''
    return `${seconds.toFixed(1)}s`
  }

  const statusLabel = (step: StartupStep): string => {
    if (step.status === 'done') return 'Done'
    if (step.status === 'running') return 'Running'
    if (step.status === 'failed') return 'Failed'
    return 'Pending'
  }

  const failedStep = (): StartupStep | null =>
    steps.find(step => step.status === 'failed') ?? null

  const retryStartup = async (): Promise<void> => {
    if (retrying) return
    retrying = true
    try {
      await retry()
    } finally {
      retrying = false
    }
  }

  onMount(() => {
    interval = window.setInterval(() => {
      nowMs = performance.now()
    }, 250)
  })

  onDestroy(() => {
    if (interval !== null) window.clearInterval(interval)
  })
</script>

<div class="startup-backdrop" role="status" aria-live="polite">
  <button class="startup-dismiss-layer" type="button" aria-label="Close startup progress" on:click={close}></button>
  <section class="startup-modal" aria-label="Leitbild startup progress">
    <header>
      <div>
        <h2>Starting Leitbild</h2>
        <p>Opening the control surface and checking each startup step.</p>
      </div>
    </header>

    <ol class="startup-steps">
      {#each steps as step (step.id)}
        <li class:done={step.status === 'done'} class:running={step.status === 'running'} class:failed={step.status === 'failed'}>
          <span class="startup-indicator"></span>
          <span class="startup-step-main">
            <span class="startup-step-label">{step.label}</span>
            {#if step.error}
              <span class="startup-step-error">{step.error}</span>
            {/if}
          </span>
          <span class="startup-step-status">
            {statusLabel(step)}
            {#if elapsedSeconds(step)}
              · {elapsedSeconds(step)}
            {/if}
          </span>
        </li>
      {/each}
    </ol>

    {#if failedStep()}
      <div class="startup-actions">
        <button class="command-button" disabled={retrying} on:click={retryStartup}>
          {retrying ? 'Retrying' : 'Retry'}
        </button>
      </div>
    {/if}
  </section>
</div>
