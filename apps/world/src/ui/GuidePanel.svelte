<script lang="ts">
  import type { GuidanceScreen, GuidanceSession } from './guidance-session.ts'
  let { screen, session, explore }: { screen: GuidanceScreen; session: GuidanceSession | null; explore: () => void } = $props()
</script>

<div class="guide-content">
  {#if screen.error}<p class="problem" role="status">{screen.error}</p>{/if}
  {#if !screen.recipient}<p>Presentation receiver is unavailable. Guide progress remains in World.</p><button type="button" disabled={screen.busy} onclick={() => void session?.reconnect()}>Reconnect this screen</button>{/if}
  {#if screen.suggestion}
    <section class="suggestion" aria-label="Attention suggestion">
      <strong>{screen.suggestion.source.label}</strong>
      <p>{screen.suggestion.purpose}</p>
      <p class="meta">{screen.suggestion.action.kind} · {screen.suggestion.target.type.replace('world.', '')} · {screen.suggestion.target.id}</p>
      <div class="actions"><button type="button" onclick={() => void session?.accept()}>Show suggestion</button><button type="button" onclick={() => void session?.decline()}>Decline</button></div>
    </section>
  {/if}
  {#if screen.guide}
    <h4>{screen.guide.title}</h4>
    {#if screen.guide.problem}<p class="problem" role="status">{screen.guide.problem}</p>{/if}
    {#if !screen.guide.attemptId}
      <p>{screen.guide.description ?? 'Follow the guide, or explore this Run at your own pace.'}</p>
      <div class="actions"><button type="button" disabled={screen.busy || !screen.recipient} onclick={() => void session?.action('start')}>Guide me</button><button type="button" onclick={explore}>Explore</button></div>
      <p class="meta">Guide progress belongs to your attempt. Explore leaves playback to the Run’s Play and Advance controls.</p>
      {#if screen.explored}<p role="status">Explore selected. Open Guide any time to begin an eligible attempt.</p>{/if}
    {:else}
      <p class="meta">{screen.guide.status}{screen.restored ? ' · restored; actions will wait for Show here' : ''}</p>
      {#if screen.guide.step}
        <strong>{screen.guide.step.title}</strong>
        <p class="instruction">{screen.guide.step.instruction}</p>
        {#if screen.guide.step.help}<details><summary>Help</summary><p>{screen.guide.step.help}</p></details>{/if}
        {#if screen.guide.condition}<p class="evidence">{screen.guide.condition.status}: {screen.guide.condition.reason}</p>{/if}
        {#if screen.guide.prompt}
          <section class="evidence" aria-label="Prompt task evidence">
            <strong>{screen.guide.prompt.status}</strong><p>{screen.guide.prompt.reason}</p>
            {#if screen.guide.prompt.evidence?.submission}
              <p class="meta">Submitted by {screen.guide.prompt.evidence.submission.senderName ?? screen.guide.prompt.evidence.submission.senderId} · Message {screen.guide.prompt.evidence.submission.messageId}</p>
              <p class="meta">{screen.guide.prompt.evidence.responses.length} causal responses. Inserting a draft is separate from sending it.</p>
            {/if}
          </section>
        {/if}
        {#if screen.guide.step.effects.length > 0}
        {@const applied = screen.guide.step.effects.filter(effect => screen.guide?.receipts?.some(record => record.effectId === effect.id && record.receipt.status === 'applied')).length}
        {@const unavailable = screen.guide.step.effects.some(effect => effect.delivery === 'unavailable' || screen.guide?.receipts?.some(record => record.effectId === effect.id && ['unavailable', 'expired', 'superseded', 'cancelled', 'declined'].includes(record.receipt.status)))}
        {#if unavailable}<p class="problem" role="status">A presentation action did not complete. Open outcomes for its reason, use Show here to retry, or skip this step.</p>{/if}
        <details><summary>Presentation outcomes · {applied} of {screen.guide.step.effects.length} applied</summary>
        <ul aria-label="Guide action outcomes">
          {#each screen.guide.step.effects as effect (effect.id)}
            {@const record = screen.guide.receipts?.find(receipt => receipt.effectId === effect.id)}
            <li>{effect.action.kind} · {effect.id}: <strong>{record?.receipt.status ?? effect.delivery ?? 'not delivered'}</strong>{#if record}<span class="meta"> · delivery at {new Date(record.receipt.at).toLocaleTimeString()}</span>{/if}{#if record?.receipt.reason ?? effect.reason} — {record?.receipt.reason ?? effect.reason}{/if}</li>
          {/each}
        </ul></details>
        {/if}
      {/if}
      <div class="actions">
        {#if !screen.guide.step || screen.error}<button type="button" disabled={screen.busy} onclick={() => void session?.read()}>Read current guide</button>{/if}
        {#if screen.guide.status === 'active'}
          <button type="button" disabled={screen.busy} onclick={() => void session?.action('show')}>Show here</button>
          <button type="button" disabled={screen.busy || screen.restored} onclick={() => void session?.action('next')}>{screen.guide.step?.completion === 'acknowledge' ? 'I understand · Next' : 'Check and continue'}</button>
          <button type="button" disabled={screen.busy || screen.restored} onclick={() => void session?.action('skip')}>Skip step</button>
          <button type="button" disabled={screen.busy} onclick={() => void session?.action('pause')}>Pause guide</button>
        {:else if screen.guide.status === 'paused'}
          <button type="button" disabled={screen.busy} onclick={() => void session?.action('resume', true)}>Resume here</button>
        {/if}
        {#if screen.guide.status === 'active' || screen.guide.status === 'paused'}
          <button type="button" disabled={screen.busy} onclick={() => void session?.action('stop')}>Stop guide</button>
        {:else}
          <button type="button" disabled={screen.busy} onclick={() => void session?.action('start')}>Start new attempt</button>
        {/if}
      </div>
      {#if screen.restored}<button type="button" disabled={screen.busy} onclick={() => void session?.action('show', true)}>Take over this attempt here</button>{/if}
      <p class="meta">Guide Pause/Stop affects instructions, never shared simulation playback. A displayed cue does not prove understanding or physical success.</p>
      <details><summary>Attempt reference</summary><p class="reference">{screen.guide.attemptId}</p><p class="meta">This opaque reference resumes this attempt in this Run and perspective. It is not a Person identity.</p></details>
    {/if}
  {:else if !screen.error}
    <p>This Run has no authored step guide. Current scenario instructions remain available above.</p>
  {/if}
  {#if screen.cue && (screen.cue.mode === 'suggest' || screen.cue.action.kind === 'explain')}
    <section class="cue" aria-label="Current presentation cue"><strong>{screen.cue.source.label}</strong><p>{screen.cue.action.kind === 'explain' ? screen.cue.action.title : screen.cue.purpose}</p>{#if screen.cue.action.kind === 'explain'}<p>{screen.cue.action.text}</p>{/if}<button type="button" onclick={() => session?.clearCue()}>Clear cue</button></section>
  {:else if screen.cue}<button type="button" onclick={() => session?.clearCue()}>Clear current cue</button>{/if}
</div>

<style>
  .guide-content { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 10px; }
  h4 { margin: 0 0 8px; font-size: 14px; }
  p { line-height: 1.5; margin: 8px 0; white-space: pre-line; }
  .meta { color: var(--muted); font-size: 12px; }
  .problem, .evidence, .suggestion, .cue { padding: 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel-strong); overflow-wrap: anywhere; }
  .problem { border-style: dashed; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-block: 10px; }
  button { min-height: 38px; padding: 7px 10px; font: inherit; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; }
  button:disabled { opacity: .65; cursor: default; }
  button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  ul { padding-left: 18px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  summary { cursor: pointer; min-height: 32px; }
  .reference { overflow-wrap: anywhere; font-family: monospace; }
  @media (pointer: coarse) { button, summary { min-height: 44px; } }
</style>
