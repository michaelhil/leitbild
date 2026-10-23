<script lang="ts">
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import { alertIcon, alertTitle, detailText, UNACK_WORD, type RowParts } from './alerts.ts'
  import { wholeWords } from './fit-words.ts'
  import './openbridge.ts'

  // One alert row (plan v5 W2.5), always one line: OpenBridge's alert icon
  // drawn steady (until people acknowledge, W2.7), UNACK, its object where the
  // list holds several, its first-out mark ("1st RX TRIP:"), its message, then
  // its tag ("LO-LO · ALM"), its notes ("after RX TRIP") and its age. Its list
  // fits the parts to its width (alerts.ts fitRow): only the message gives
  // way, by whole words (wholeWords), and where even its first word does not
  // fit, the notes go, then the tag; the icon, UNACK, the mark and the age
  // stand. The full words stay in its title and its text for assistive
  // technology. A row on an element opens it (`onopen`); one expected after a
  // first-out is faded.
  let { row, parts, nowMs, faded = false, onopen }: {
    row: AlertRow
    /** What stands on its line (fitRow). */
    parts: RowParts
    nowMs: number
    faded?: boolean
    onopen?: (() => void) | undefined
  } = $props()

  const icon = $derived(alertIcon(row))
</script>

{#snippet content()}
  {#if 'type' in icon}
    <span class="icon"><obc-alert-icon alertType={icon.type} acknowledged={icon.acknowledged} active={icon.active}></obc-alert-icon></span>
  {:else}
    <span class="word">{icon.word}</span>
  {/if}
  {#if parts.unack}<span class="unack">{UNACK_WORD}</span>{/if}
  {#if parts.heading !== undefined}<strong>{parts.heading}</strong>{/if}
  {#if parts.mark !== null}<span class="mark">{parts.mark}:</span>{/if}
  <span class="message" aria-hidden="true" use:wholeWords={parts.message}></span>
  <span class="full">{parts.message}</span>
  <span class="detail">{detailText(parts.detail)}</span>
{/snippet}

{#if onopen === undefined}
  <div class="row" class:faded title={alertTitle(row, nowMs)}>{@render content()}</div>
{:else}
  <button type="button" class="row" class:faded title={`${alertTitle(row, nowMs)} · open`} onclick={onopen}>{@render content()}</button>
{/if}

<style>
  .row { position: relative; display: flex; align-items: center; gap: 6px; width: 100%; height: var(--row); min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; white-space: nowrap; overflow: hidden; }
  button.row { cursor: pointer; }
  button.row:hover { background: var(--flat-hover-background-color); }
  button.row:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .icon { flex: none; display: block; width: 20px; height: 20px; }
  .icon obc-alert-icon { display: block; width: 20px; height: 20px; }
  .word { flex: none; font-weight: 700; }
  strong, .mark, .unack { flex: none; font-size: 12px; }
  .mark, .unack { font-weight: 700; letter-spacing: 0.03em; }
  .unack { color: var(--element-active-color); }
  /* The one part that gives way: its room is what the others leave, and its words are fitted to it. */
  .message { flex: 1 1 0; min-width: 0; overflow: hidden; }
  .detail { flex: none; font-size: 12px; color: var(--element-neutral-color); }
  /* Expected after a first-out: listed, never hidden, read after what is news. */
  .faded { opacity: 0.62; }
  /* The whole message, read by assistive technology, not shown. */
  .full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
