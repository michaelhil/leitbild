<script lang="ts">
  import type { GuidanceScreen, GuidanceSession } from './guidance-session.ts'

  let { screen, session, explore }: { screen: GuidanceScreen; session: GuidanceSession | null; explore: () => void } = $props()
  const guide = $derived(screen.guide)
  const step = $derived(guide?.step)
  const finished = $derived(guide?.status === 'completed' || guide?.status === 'stopped')
  const resumeHere = $derived(!finished && (guide?.status === 'paused' || screen.restored))
  const workingStep = $derived(guide?.status === 'active' && !resumeHere)
  const isPrompt = $derived(step?.completion === 'prompt-response')
  const sentPrompt = $derived(Boolean(guide?.prompt?.evidence?.submission))
  const mayShow = $derived(workingStep && Boolean(step?.effects.length) && !sentPrompt)
  const receiptFor = (effectId: string) => guide?.receipts?.find(record => record.effectId === effectId)?.receipt
  const failedEffect = $derived(step?.effects.find(effect => {
    const status = receiptFor(effect.id)?.status ?? effect.delivery
    return status !== undefined && ['unavailable', 'expired', 'superseded', 'cancelled', 'declined'].includes(status)
  }))
  const applied = $derived(step?.effects.filter(effect => receiptFor(effect.id)?.status === 'applied').length ?? 0)
  const nextLabel = $derived(isPrompt && guide?.prompt?.status !== 'responded'
    ? 'Check for reply'
    : step?.completion === 'condition' || step?.completion === 'presentation'
      ? 'Check and continue' : 'Continue')
  const showLabel = $derived(isPrompt ? 'Show prompt' : failedEffect ? 'Try showing again' : applied > 0 ? 'Show again' : 'Show this step')
  type PrimaryAction = 'reconnect' | 'read' | 'start' | 'resume' | 'next' | 'show'
  const primary = $derived.by((): { action: PrimaryAction; label: string } | null => {
    if (!screen.recipient && (guide || screen.error || screen.busy)) return { action: 'reconnect', label: screen.busy ? 'Connecting…' : 'Reconnect guide' }
    if (!guide) return null
    if (!guide.attemptId || finished) return { action: 'start', label: finished ? 'Start a new attempt' : 'Start guide' }
    if (resumeHere) return { action: 'resume', label: screen.restored ? 'Resume on this screen' : 'Resume guide' }
    if (!step) return { action: 'read', label: 'Reload current step' }
    if (step.completion === 'presentation' && step.effects.length === 1 && failedEffect) return { action: 'show', label: showLabel }
    return { action: 'next', label: nextLabel }
  })
  let primaryButton = $state<HTMLButtonElement | null>(null)
  const runPrimary = (): void => {
    if (screen.busy || !primary || !session) return
    const { action } = primary
    if (action === 'reconnect') void session.reconnect()
    else if (action === 'read') void session.read()
    else void session.action(action, action === 'resume')
  }
  const changeStep = (action: 'skip' | 'pause' | 'stop', event: MouseEvent): void => {
    if (screen.busy || !screen.recipient || !session) return
    // This option can disappear when the command returns. Move its keyboard
    // focus to the stable primary action while the learner is still here.
    if (document.activeElement === event.currentTarget) primaryButton?.focus({ preventScroll: true })
    void session.action(action)
  }
</script>

<div class="guide-content">
  {#if guide}
    {#if guide.attemptId && !finished && step}
      <p class="meta step-number">{guide.title} · Step {(guide.completed?.length ?? 0) + 1}</p>
      <h3 aria-live="polite">{step.title}</h3>
      <p class="instruction">{step.instruction}</p>
    {:else}
      <h3>{guide.title}</h3>
      {#if finished}
        <p>{guide.status === 'completed' ? 'You finished this guide.' : 'You ended this guide.'} Keep exploring this Run, or start a new attempt.</p>
      {:else if !guide.attemptId}
        <p>{guide.description ?? 'Learn this Run one step at a time.'}</p>
      {/if}
    {/if}
  {:else if !screen.busy && !screen.error && !screen.suggestion && !screen.cue}
    <p class="meta">This Run has no step-by-step guide.</p>
  {/if}

  {#if screen.error || guide?.problem}<p class="notice" role="status">{screen.error ?? guide?.problem}</p>{/if}
  {#if workingStep && failedEffect && !screen.error && !guide?.problem}
    <p class="notice" role="status">This step couldn’t show one of its cues.</p>
  {/if}
  {#if workingStep && step?.completion === 'condition' && guide?.condition}
    <p class="status" role="status">{guide.condition.status === 'satisfied' ? 'The current Run meets this check.' : guide.condition.reason}</p>
  {/if}
  {#if workingStep && isPrompt && guide?.prompt}
    <p class="status" role="status">{guide.prompt.status === 'responded' ? 'The Assistant replied. You can continue.'
      : guide.prompt.status === 'unavailable' ? guide.prompt.reason
      : sentPrompt ? 'Waiting for an Assistant reply.' : 'Send the suggested prompt from the Assistant when you’re ready.'}</p>
  {/if}

  {#if primary}
    <div class="actions">
      <button class="primary" type="button" bind:this={primaryButton} aria-disabled={screen.busy || !session} onclick={runPrimary}>{primary.label}</button>
      {#if guide && (!guide.attemptId || finished)}
        <button class="quiet" type="button" onclick={explore}>{finished ? 'Back to the Run' : 'Explore on my own'}</button>
      {:else if screen.recipient && workingStep && step}
        {#if mayShow && primary.action !== 'show'}
          <button class="quiet" type="button" disabled={screen.busy} onclick={() => void session?.action('show')}>{showLabel}</button>
        {/if}
        {#if isPrompt}<button class="quiet" type="button" disabled={screen.busy} onclick={event => changeStep('skip', event)}>Skip this step</button>{/if}
      {/if}
    </div>
  {/if}
  {#if guide}
    {#if guide.attemptId && !finished && !screen.restored}
      <details class="secondary">
        <summary>Guide options</summary>
        <div class="actions">
          {#if workingStep}
            {#if !isPrompt}<button class="quiet" type="button" disabled={screen.busy || !screen.recipient} onclick={event => changeStep('skip', event)}>Skip this step</button>{/if}
            <button class="quiet" type="button" disabled={screen.busy || !screen.recipient} onclick={event => changeStep('pause', event)}>Pause guide</button>
            {#if screen.cue?.mode === 'guide' && screen.cue.action.kind !== 'explain'}<button class="quiet" type="button" onclick={() => session?.clearCue()}>Clear cue</button>{/if}
          {/if}
          <button class="quiet" type="button" disabled={screen.busy || !screen.recipient} onclick={event => changeStep('stop', event)}>End guide</button>
        </div>
        <p class="meta">Pause and End affect this guide. Use the Run’s time controls for the simulation.</p>
      </details>
    {/if}
    {#if guide.attemptId}
      <details class="secondary">
        <summary>{finished ? 'Attempt details' : 'Step details'}</summary>
        {#if step?.help}<p>{step.help}</p>{/if}
        {#if !finished && step?.effects.length}
          <ul aria-label="Guide cue outcomes">
            {#each step.effects as effect (effect.id)}
              {@const receipt = receiptFor(effect.id)}
              <li>{effect.action.kind} · {effect.id} · {receipt?.status ?? effect.delivery ?? 'waiting for delivery'}{#if receipt} · {new Date(receipt.at).toLocaleTimeString()}{/if}{#if receipt?.reason ?? effect.reason} — {receipt?.reason ?? effect.reason}{/if}</li>
            {/each}
          </ul>
        {/if}
        {#if !finished && guide.prompt?.evidence?.submission}
          <p class="meta">Message {guide.prompt.evidence.submission.messageId} · {guide.prompt.evidence.responses.length} linked responses</p>
        {/if}
        <p class="meta reference">Attempt {guide.attemptId}</p>
      </details>
    {/if}
  {/if}

  {#if screen.suggestion}
    <section class="separate" aria-label="Presentation suggestion">
      <h3>Suggestion from {screen.suggestion.source.label}</h3>
      <p>{screen.suggestion.purpose}</p>
      <div class="actions"><button type="button" onclick={() => void session?.accept()}>Show suggestion</button><button class="quiet" type="button" onclick={() => void session?.decline()}>Dismiss</button></div>
    </section>
  {/if}
  {#if screen.cue && (screen.cue.mode === 'suggest' || screen.cue.action.kind === 'explain')}
    <section class="separate" aria-label="Current presentation cue">
      <p class="meta">{screen.cue.source.label}</p>
      <h3>{screen.cue.action.kind === 'explain' ? screen.cue.action.title : screen.cue.purpose}</h3>
      {#if screen.cue.action.kind === 'explain'}<p>{screen.cue.action.text}</p>{/if}
      <button class="quiet" type="button" onclick={() => session?.clearCue()}>Clear cue</button>
    </section>
  {/if}
</div>

<style>
  .guide-content { min-width: 0; overflow-wrap: anywhere; }
  h3 { margin: 4px 0 8px; font-size: 16px; }
  p { line-height: 1.45; margin: 6px 0 8px; white-space: pre-line; }
  .meta, .secondary, .status { color: var(--muted); font-size: 12px; }
  .step-number { margin-top: 0; }
  .instruction { margin-bottom: 10px; }
  .notice { border-inline-start: 2px solid var(--accent); padding-inline-start: 8px; font-size: 13px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; }
  button { min-height: 38px; padding: 7px 10px; font: inherit; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; }
  .primary { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); font-weight: 650; }
  .quiet { border-color: transparent; background: transparent; }
  .quiet:hover:not(:disabled) { background: var(--panel-strong); }
  button:disabled, button[aria-disabled='true'] { opacity: .65; cursor: default; }
  button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  ul { padding-inline-start: 18px; line-height: 1.45; }
  summary { cursor: pointer; min-height: 28px; display: list-item; align-content: center; }
  .reference { font-family: monospace; }
  .separate { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
  @media (pointer: coarse) { button, summary { min-height: 44px; } }
</style>
