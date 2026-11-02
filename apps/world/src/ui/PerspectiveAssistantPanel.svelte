<script lang="ts">
  import type { PerspectiveAssistantScreen, PerspectiveAssistantSession } from './perspective-assistant-session.ts'
  let { screen, session, roleLabels }: { screen: PerspectiveAssistantScreen; session: PerspectiveAssistantSession | null; roleLabels: ReadonlyArray<string> } = $props()
  const labels = {
    idle: 'Not set up', preparing: 'Preparing access', pending: 'Waiting for Assistant setup',
    connecting: 'Connecting this World view', connected: 'World view connected', disconnected: 'View disconnected', revoked: 'Scope ended',
  } as const
</script>

<section class="perspective-assistant" aria-label="Exercise Assistant scope">
  <h4>Exercise Assistant</h4>
  <p class="scope">{roleLabels.join(' + ')} · <strong>Inspect only</strong></p>
  <p class="state" role="status" aria-live="polite">{labels[screen.phase]}</p>
  {#if screen.problem}<p class="problem" role="status">{screen.problem}</p>{/if}
  <div class="actions">
    <button type="button" disabled={!screen.available || screen.phase === 'preparing' || screen.admission?.runtimeAvailability?.status === 'unavailable'} onclick={() => void session?.ask()}>{screen.admission?.status === 'active' ? 'Open this Assistant' : screen.admission?.status === 'pending' ? 'Resume setup' : 'Set up this Assistant'}</button>
    {#if screen.phase === 'disconnected' && screen.admission?.status === 'active' && screen.admission.runtimeAvailability?.status !== 'unavailable'}<button type="button" onclick={() => void session?.reconnect()}>Reconnect this view</button>{/if}
    {#if screen.phase === 'preparing' || screen.admission && screen.admission.status !== 'revoked'}<button type="button" onclick={() => void session?.end()}>{screen.phase === 'preparing' ? 'Stop setup' : 'End this scope'}</button>{/if}
  </div>
  <p class="help">This scope can inspect permitted information and offer attention cues. It cannot issue simulation commands. Changing exercise roles starts a separate conversation; unsent text stays with its original conversation.</p>
  {#if screen.admission}
    <details><summary>Scope and evidence</summary>
      <dl><dt>World admission</dt><dd>{screen.admission.status}</dd><dt>Perspective</dt><dd>{screen.admission.resource.id}</dd><dt>Admission generation</dt><dd>{screen.admission.admissionGeneration}</dd><dt>Run incarnation</dt><dd>{screen.admission.runIncarnation}</dd><dt>Role-set digest</dt><dd>{screen.admission.roleSetDigest}</dd></dl>
      <p class="help">World owns this admission. A connected view does not establish model availability or fresh operational evidence. Exercise role selection is not authenticated participant membership.</p>
    </details>
  {/if}
  {#if screen.attention.suggestion}
    <section class="attention" aria-label="Perspective attention suggestion">
      <strong>{screen.attention.suggestion.source.label}</strong><p>{screen.attention.suggestion.purpose}</p>
      <div class="actions"><button type="button" onclick={() => void session?.accept()}>Show suggestion</button><button type="button" onclick={() => void session?.decline()}>Decline</button></div>
    </section>
  {/if}
  {#if screen.attention.cue}
    <section class="attention" aria-label="Perspective presentation cue">
      <strong>{screen.attention.cue.source.label}</strong>
      {#if screen.attention.cue.action.kind === 'explain'}<p>{screen.attention.cue.action.title}</p><p>{screen.attention.cue.action.text}</p>{:else}<p>{screen.attention.cue.purpose}</p>{/if}
      <button type="button" onclick={() => session?.clearCue()}>Clear attention</button>
    </section>
  {/if}
</section>

<style>
  .perspective-assistant { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 10px; }
  h4 { margin: 0 0 8px; font-size: 14px; }
  p { margin: 8px 0; line-height: 1.5; white-space: pre-line; overflow-wrap: anywhere; }
  .scope, .state { font-size: 13px; }
  .help { color: var(--muted); font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-block: 10px; }
  .problem, .attention { border: 1px solid var(--border); border-radius: 7px; padding: 10px; background: var(--panel-strong); }
  .problem { border-style: dashed; }
  button { min-height: 38px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--panel); font: inherit; cursor: pointer; }
  button:disabled { opacity: .65; cursor: default; }
  button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  summary { min-height: 32px; cursor: pointer; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px; font-size: 12px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  @media (pointer: coarse) { button, summary { min-height: 44px; } }
</style>
