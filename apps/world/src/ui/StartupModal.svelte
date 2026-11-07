<script lang="ts">
  import ModalShell from './components/ModalShell.svelte'
  import type { StatusTone } from './components/StatusDot.svelte'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import { startupIsReady, type StartupStep } from './startup.ts'

  interface Props {
    readonly steps: ReadonlyArray<StartupStep>
    readonly tone: StatusTone
    readonly retry: () => Promise<void>
    readonly close: () => void
    readonly closeWhenReadyOnly?: boolean
  }

  const {
    steps,
    tone,
    retry,
    close,
    closeWhenReadyOnly = true,
  }: Props = $props()

  let nowMs = $state(performance.now())
  let retrying = $state(false)
  const ready = $derived(startupIsReady(steps))
  const failedStep = $derived(steps.find(step => step.status === 'failed') ?? null)
  const runningStep = $derived(steps.find(step => step.status === 'running') ?? null)
  const canClose = $derived(!closeWhenReadyOnly || failedStep !== null)

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

  const retryStartup = async (): Promise<void> => {
    if (retrying) return
    retrying = true
    try {
      await retry()
    } finally {
      retrying = false
    }
  }

  runOnMount(() => {
    const interval = window.setInterval(() => {
      nowMs = performance.now()
    }, 250)
    return () => window.clearInterval(interval)
  })
</script>

<ModalShell
  title={failedStep ? 'Simulation startup issue' : ready ? 'Simulation ready' : 'Opening simulation'}
  close={close}
  closeOnBackdrop={canClose}
  closeOnEscape={canClose}
  showClose={canClose}
  titleTone={tone}
  size="medium"
>
  <p role="status">{failedStep?.error ?? runningStep?.label ?? (ready ? 'The control surface is ready.' : 'Preparing the control surface.')}</p>
  <details class="startup-step-diagnostics">
    <summary>Startup details</summary>
    <ol class="startup-steps">
      {#each steps as step (step.id)}
        <li class:done={step.status === 'done'} class:running={step.status === 'running'} class:failed={step.status === 'failed'}>
          <span class="startup-indicator"></span>
          <span class="startup-step-main">
            <span class="startup-step-label">{step.label}</span>
            {#if step.error}
              <span class="startup-step-error">{step.error}</span>
            {/if}
            {#if step.details?.length}
              <!-- Measurements are for diagnosis, not for the player: folded away unless the step failed. -->
              <details class="startup-step-diagnostics" open={step.status === 'failed'}>
                <summary>Diagnostics</summary>
                <span class="startup-step-details">
                  {#each step.details as detail}
                    <span><strong>{detail.label}</strong> {detail.value}</span>
                  {/each}
                </span>
              </details>
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
  </details>
  {#snippet footer()}
    {#if failedStep}
      <div class="startup-actions">
        <button class="command-button" disabled={retrying} onclick={retryStartup}>
          {retrying ? 'Retrying' : 'Retry'}
        </button>
      </div>
    {/if}
  {/snippet}
</ModalShell>
