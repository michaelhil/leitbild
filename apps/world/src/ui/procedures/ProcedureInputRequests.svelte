<script lang="ts">
  import { untrack } from 'svelte'
  import type { ProcedureInputView } from './procedure-input.ts'
  let { requests, open, openChat = undefined }: {
    requests: ReadonlyArray<ProcedureInputView>
    open: (request: ProcedureInputView) => Promise<boolean>
    openChat?: (() => void) | undefined
  } = $props()
  let dismissed = $state<ReadonlySet<string>>(new Set())
  let opening = $state<string | null>(null)
  const activate = async (request: ProcedureInputView): Promise<void> => {
    if (opening !== null) return
    opening = request.key
    try { if (await open(request)) dismissed = new Set([...dismissed, request.key]) }
    finally { opening = null }
  }
  const shown = $derived(requests.filter(request => !dismissed.has(request.key)))
  $effect(() => {
    const active = new Set(requests.map(request => request.key))
    untrack(() => {
      const retained = new Set([...dismissed].filter(key => active.has(key)))
      if (retained.size !== dismissed.size) dismissed = retained
    })
  })
</script>

{#if shown.length}
  <aside class="procedure-input-requests" aria-label="Procedure input requests" data-map-ui>
    {#each shown as request (request.key)}
      <article role="alert">
        <strong>Agent needs your input</strong>
        <p class="where">{request.unit} · {request.run.procedureId} · {request.stepLabel ? `step ${request.stepLabel}` : 'current step'}</p>
        <p>{request.issue}</p>
        <div class="actions">
          <button type="button" class="primary" disabled={opening !== null} onclick={() => void activate(request)}>{opening === request.key ? 'Opening…' : `Open ${request.stepLabel ? `step ${request.stepLabel}` : 'step'}`}</button>
          {#if openChat}<button type="button" onclick={openChat}>Run chat</button>{/if}
          <button type="button" title="Hide this notice; the question remains in the procedure" onclick={() => { dismissed = new Set([...dismissed, request.key]) }}>Dismiss</button>
        </div>
      </article>
    {/each}
  </aside>
{/if}

<style>
  /* Above procedure/display windows (92/93), without blocking the map or taking focus. */
  .procedure-input-requests { position: fixed; right: 12px; bottom: 20px; z-index: 94; width: min(27rem, calc(100vw - 24px)); max-height: calc(100dvh - 110px); overflow-y: auto; display: grid; gap: 8px; color: var(--text); }
  article { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; box-shadow: 0 4px 16px color-mix(in srgb, var(--text) 16%, transparent); }
  strong { font-size: 15px; }
  p { margin: 8px 0; font-size: 14px; overflow-wrap: anywhere; }
  .where { color: var(--muted); font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  button { min-height: 44px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--panel); cursor: pointer; }
  button.primary { font-weight: 650; }
</style>
