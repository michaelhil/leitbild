<script lang="ts">
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import { alertIcon, alertTitle, rowParts, UNACK_WORD, wordsThatFit } from './alerts.ts'
  import './openbridge.ts'

  // One alert row (plan v5 W2.5): OpenBridge's alert icon drawn steady (until
  // people acknowledge, W2.7), UNACK, its first-out mark ("1st RX TRIP:"), its
  // message, then its tag ("LO-LO · RX TRIP"), what it is expected after, its
  // marks and its age. Where it does not fit one line whole (its list says,
  // `stacked`), it takes two: icon, mark and message, then UNACK and the rest
  // under them. Only the message gives way, by whole words (wordsThatFit), so
  // the icon, UNACK, the mark, the tag and the age are never cut; the full
  // words stay in its title and its text for assistive technology. A row on an
  // element opens it (`onopen`); one expected after a first-out is faded.
  let { row, nowMs, heading, stacked, faded = false, onopen }: {
    row: AlertRow
    nowMs: number
    /** Its object, where the list holds several objects' alerts. */
    heading?: string | undefined
    stacked: boolean
    faded?: boolean
    onopen?: (() => void) | undefined
  } = $props()

  const parts = $derived(rowParts(row, nowMs, heading))
  const icon = $derived(alertIcon(row))

  /** A message as many of its whole words as its room shows, fitted again when its room or its text changes. */
  const fitted = (node: HTMLElement, text: string) => {
    let full = text
    const fit = (): void => {
      node.textContent = wordsThatFit(full, candidate => {
        node.textContent = candidate
        return node.scrollWidth <= node.clientWidth
      })
    }
    fit()
    const resized = new ResizeObserver(fit)
    resized.observe(node)
    return { update: (next: string) => { full = next; fit() }, destroy: () => resized.disconnect() }
  }
</script>

{#snippet content()}
  <span class="line">
    {#if 'type' in icon}
      <span class="icon"><obc-alert-icon alertType={icon.type} acknowledged={icon.acknowledged} active={icon.active}></obc-alert-icon></span>
    {:else}
      <span class="word">{icon.word}</span>
    {/if}
    {#if parts.mark !== null}<span class="mark">{parts.mark}:</span>{/if}
    <span class="message" aria-hidden="true" use:fitted={parts.message}></span>
    <span class="full">{parts.message}</span>
  </span>
  <span class="meta">
    {#if parts.unack}<span class="unack">{UNACK_WORD}</span>{/if}
    {#if parts.heading !== undefined}<strong>{parts.heading}</strong>{/if}
    <span class="detail">{parts.detail}</span>
  </span>
{/snippet}

{#if onopen === undefined}
  <div class="row" class:stacked class:faded title={alertTitle(row, nowMs)}>{@render content()}</div>
{:else}
  <button type="button" class="row" class:stacked class:faded title={`${alertTitle(row, nowMs)} · open`} onclick={onopen}>{@render content()}</button>
{/if}

<style>
  .row { position: relative; display: flex; align-items: center; gap: 6px; width: 100%; height: var(--row); min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; white-space: nowrap; overflow: hidden; }
  button.row { cursor: pointer; }
  button.row:hover { background: var(--flat-hover-background-color); }
  button.row:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  /* On one line the two halves are one row: icon, UNACK, heading, mark, message, detail. */
  .line, .meta { display: contents; }
  .row:not(.stacked) .meta .unack, .row:not(.stacked) .meta strong { order: -1; }
  .row:not(.stacked) .icon, .row:not(.stacked) .word { order: -2; }
  /* On two lines: icon, mark and message; under them, UNACK, heading and detail. */
  .row.stacked { flex-direction: column; align-items: stretch; justify-content: center; gap: 0; height: calc(2 * var(--row)); }
  .row.stacked .line, .row.stacked .meta { display: flex; align-items: center; gap: 6px; min-width: 0; height: var(--row); }
  .row.stacked .meta { padding-left: 26px; }
  .icon { flex: none; display: block; width: 20px; height: 20px; }
  .icon obc-alert-icon { display: block; width: 20px; height: 20px; }
  .word { flex: none; font-weight: 700; }
  strong, .mark, .unack { flex: none; font-size: 12px; }
  .mark, .unack { font-weight: 700; letter-spacing: 0.03em; }
  .unack { color: var(--element-active-color); }
  /* The one part that gives way: its room is what the others leave, and its words are fitted to it. */
  .message { flex: 1 1 0; min-width: 0; overflow: hidden; }
  .detail { flex: none; font-size: 12px; color: var(--element-neutral-color); }
  .row.stacked .detail { margin-left: auto; }
  /* Expected after a first-out: listed, never hidden, read after what is news. */
  .faded { opacity: 0.62; }
  /* The whole message, read by assistive technology, not shown. */
  .full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
