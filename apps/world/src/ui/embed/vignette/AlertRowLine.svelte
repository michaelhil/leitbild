<script lang="ts">
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import { alertIcon, alertTitle, detailText, UNACK_WORD, type RowParts } from './alerts.ts'
  import { wholeWords } from './fit-words.ts'
  import './openbridge.ts'

  // One alert row (plan v5 W2.5, W2.7), always one line: OpenBridge's alert
  // icon as its record stands (alerts.ts alertIcon: flashing while
  // unacknowledged news, its priority steady while it asks no attention),
  // UNACK, its object where the list holds several, its first-out mark ("1st
  // RX TRIP:"), its message, then its tag ("LO-LO · ALM"), its notes ("after RX
  // TRIP") and its age, and where its list offers it (`onack`: in the display
  // window), ACK. Its list fits the parts to its width (alerts.ts fitRow): only
  // the message gives way, by whole words (wholeWords), and where even its
  // first word does not fit, the notes go, then the tag; the icon, UNACK, the
  // mark, the age and ACK stand. The full words stay in its title and its text
  // for assistive technology. A row on an element opens it (`onopen`); one
  // expected after a first-out is faded.
  let { row, parts, nowMs, faded = false, onopen, onack, acking = false }: {
    row: AlertRow
    /** What stands on its line (fitRow). */
    parts: RowParts
    nowMs: number
    faded?: boolean
    onopen?: (() => void) | undefined
    /** Acknowledges it, where its list offers that (parts.ack). */
    onack?: (() => void) | undefined
    /** Its acknowledgement is on its way. */
    acking?: boolean
  } = $props()

  const icon = $derived(alertIcon(row))
</script>

{#snippet content()}
  {#if icon.kind === 'icon'}
    <span class="icon"><obc-alert-icon alertType={icon.type} acknowledged={icon.acknowledged} active={icon.active}></obc-alert-icon></span>
  {:else if icon.kind === 'badge'}
    <span class="icon badge"><obc-badge type={icon.type} variant="flat" showIcon showNumber={false}></obc-badge></span>
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

<div class="row" class:faded>
  {#if onopen === undefined}
    <div class="body" title={alertTitle(row, nowMs)}>{@render content()}</div>
  {:else}
    <button type="button" class="body" title={`${alertTitle(row, nowMs)} · open`} onclick={onopen}>{@render content()}</button>
  {/if}
  {#if parts.ack === true && onack !== undefined}
    <button type="button" class="ack" disabled={acking} title={`Acknowledge: ${row.alert.message}`} onclick={onack}>ACK</button>
  {/if}
</div>

<style>
  .row { display: flex; align-items: center; gap: 6px; width: 100%; height: var(--row); min-width: 0; }
  .body { position: relative; display: flex; align-items: center; gap: 6px; flex: 1 1 0; height: 100%; min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; white-space: nowrap; overflow: hidden; }
  button.body { cursor: pointer; }
  button.body:hover { background: var(--flat-hover-background-color); }
  button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .icon { flex: none; display: block; width: 20px; height: 20px; }
  .icon obc-alert-icon { display: block; width: 20px; height: 20px; }
  .badge { display: flex; align-items: center; justify-content: center; }
  .word { flex: none; font-weight: 700; }
  strong, .mark, .unack { flex: none; font-size: 12px; }
  .mark, .unack { font-weight: 700; letter-spacing: 0.03em; }
  .unack { color: var(--element-active-color); }
  /* The one part that gives way: its room is what the others leave, and its words are fitted to it. */
  .message { flex: 1 1 0; min-width: 0; overflow: hidden; }
  .detail { flex: none; font-size: 12px; color: var(--element-neutral-color); }
  /* A person's acknowledgement, in the display window: a small button that never gives way. */
  .ack { flex: none; width: 40px; height: 20px; padding: 0; border: 1px solid var(--border-outline-color); border-radius: 3px; background: var(--container-section-color); color: var(--element-active-color); font: inherit; font-size: 11px; font-weight: 700; letter-spacing: 0.03em; cursor: pointer; }
  .ack:hover { background: var(--flat-hover-background-color); }
  .ack:disabled { color: var(--element-disabled-color); cursor: progress; }
  /* Expected after a first-out: listed, never hidden, read after what is news. */
  .faded { opacity: 0.62; }
  /* The whole message, read by assistive technology, not shown. */
  .full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
