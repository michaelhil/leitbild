<script lang="ts">
  import { einsatzColors } from '../colors.ts'
  import type { OrderWhen, Stop, UnitOrderInput } from '../order-schema.ts'
  import { svgImageSource } from './einsatz-client.ts'
  import { dispatchWords, type CardView } from './presenters.ts'

  /**
   * The selection block's card, docked at the top of the Dispatch panel: a
   * unit's (armed or not), a call's, a closed call's or a site's. A thin view
   * over the presenters' card. Nothing the operator is about to hit moves:
   * every button stands in a fixed place for its kind and is disabled with
   * its reason, shown beside it, rather than hidden; a refusal shows in the
   * reserved slot at the top of the card, and the armed card's busy choices
   * and refusals in its own reserved slot above the target rows; in the call
   * card the commands come first and the assigned units after them, and the
   * Close confirm stands beside Close. Every control is at least 44 px.
   */
  interface Props {
    readonly card: CardView
    /** The last refusal or failure the panel reports, shown in the card's reserved slot. */
    readonly feedback: string | null
    readonly icon: (id: string) => string | undefined
    /** Whether this call's Close waits for its confirm. */
    readonly confirming: boolean
    readonly back: () => void
    readonly arm: (unitId: string, when: 'after' | null) => void
    readonly targetRow: (target: Stop) => void
    /** A choice of the busy prompt, offered here as well as on the map. */
    readonly promptChoice: (choice: OrderWhen) => void
    readonly recall: (unitId: string) => void
    readonly undo: (unitId: string, commandId: string) => void
    readonly removeStop: (unitId: string, stopId: string) => void
    readonly deliverTo: (unitId: string, siteId: string) => void
    readonly order: (input: UnitOrderInput) => void
    readonly toggleChip: (unitId: string) => void
    readonly refresh: (callId: string) => void
    readonly askClose: (callId: string) => void
    readonly cancelClose: () => void
    readonly closeTask: (callId: string) => void
    readonly setSite: (siteId: string, accepting: boolean) => void
  }

  const props: Props = $props()
  const card = $derived(props.card)
</script>

{#snippet badge(id: string, colour: string)}
  {@const svg = props.icon(id)}
  <span class="badge" style:background={colour} aria-hidden="true">{#if svg !== undefined}<img src={svgImageSource(svg)} alt="" />{/if}</span>
{/snippet}

{#snippet slot()}
  <p class="slot refusal" role="alert">{props.feedback ?? ''}</p>
{/snippet}

<article class="card" data-kind={card.kind} aria-label={card.kind === 'unit' || card.kind === 'site' ? card.title : card.label}>
  {#if card.kind === 'unit'}
    {#if card.armed !== null}
      <div class="banner" role="status">
        <strong>{card.armed.banner}</strong>
        <button type="button" class="x" aria-label={dispatchWords.cancel} onclick={props.back}>×</button>
      </div>
    {/if}
    <header>
      {@render badge(card.icon, einsatzColors.unit)}
      <h3>{card.title}</h3>
      {#if card.armed === null}<button type="button" class="x" aria-label={dispatchWords.close} onclick={props.back}>×</button>{/if}
    </header>
    {#if card.armed === null}
      {@render slot()}
    {:else}
      {@const armedSlot = card.armed.slot}
      <div class="slot armed-slot">
        {#if armedSlot.kind === 'busy'}
          <div class="row-buttons">
            <button type="button" onclick={() => props.promptChoice('after')}>{armedSlot.after}</button>
            <button type="button" class="warning" onclick={() => props.promptChoice('now')}>{armedSlot.now}</button>
          </div>
        {:else if armedSlot.kind === 'busy-reading'}
          <p class="note">{dispatchWords.readingJob}</p>
        {:else if armedSlot.kind === 'refusal'}
          <p class="refusal" role="alert">{armedSlot.text}</p>
        {:else if props.feedback !== null}
          <p class="refusal" role="alert">{props.feedback}</p>
        {/if}
      </div>
    {/if}
    <p class="status" data-tone={card.status.tone}><span class="dot" aria-hidden="true">●</span> {card.status.word}{#if card.status.due !== null} · <span class="num">{card.status.due}</span>{/if}</p>
    {#if card.readOnly !== null}<p class="note">{card.readOnly}</p>{/if}
    {#if card.armed === null}
      <button type="button" class="primary" disabled={!card.dispatch.enabled} onclick={() => props.arm(card.id, null)}>{card.dispatch.label}</button>
      <div class="stacked">
        <button type="button" disabled={!card.recall.enabled} onclick={() => props.recall(card.id)}>{card.recall.label}</button>
        <p class="reason">{card.recall.reason ?? ''}</p>
        <button type="button" disabled={!card.undo.enabled} onclick={() => { if (card.undo.commandId !== null) props.undo(card.id, card.undo.commandId) }}>{card.undo.label}</button>
        <p class="reason">{card.undo.reason ?? ''}</p>
      </div>
    {:else}
      <h4>{dispatchWords.validTargets}</h4>
      {#if card.armed.rows.length === 0}
        <p class="note rows-note">{dispatchWords.loadingTargets}</p>
      {:else}
        <ol class="targets">
          {#each card.armed.rows as row (row.key)}
            <li>
              <button type="button" class="target" class:dimmed={row.refused !== null} onclick={() => props.targetRow(row.target)}>
                <span>{row.text}</span>
                {#if row.eta !== null}<span class="num">{row.eta}</span>{/if}
                {#if row.drops !== null}<span class="drops">{row.drops}</span>{/if}
                {#if row.refused !== null}<span class="why">{row.refused}</span>{/if}
              </button>
            </li>
          {/each}
        </ol>
      {/if}
    {/if}
    {#if card.plan.length > 0 || card.predicted !== null}
      <h4>{card.planHeading}</h4>
      <ol class="plan">
        {#each card.plan as stop (stop.id)}
          <li class:active={stop.active}>
            <span class="index">{stop.index}</span>
            <span class="what">{stop.text}{#if stop.eta !== null} · <span class="num">{stop.eta}</span>{/if}{#if stop.by !== null} <span class="by">{stop.by}</span>{/if}</span>
            {#if card.removable}<button type="button" class="x" aria-label={stop.removeLabel} onclick={() => props.removeStop(card.id, stop.id)}>×</button>{/if}
          </li>
        {/each}
        {#if card.predicted !== null}<li class="predicted"><span class="index">┄</span><span class="what">{card.predicted}</span></li>{/if}
      </ol>
    {/if}
    {#if card.armed === null && card.deliverTo.length > 0}
      <div class="chips" role="group" aria-label={dispatchWords.deliverTo}>
        <span class="chips-label">{dispatchWords.deliverTo}</span>
        {#each card.deliverTo as site (site.siteId)}<button type="button" class="order-chip" onclick={() => props.deliverTo(card.id, site.siteId)}>{site.label}</button>{/each}
      </div>
    {/if}
    {#if card.armed === null && card.addStop !== null}
      <button type="button" class="secondary" disabled={!card.addStop.enabled} onclick={() => props.arm(card.id, 'after')}>{card.addStop.label}</button>
      <p class="reason">{card.addStop.reason ?? ''}</p>
    {/if}
    {#if card.facts.length > 0}<p class="facts">{card.facts.join(' · ')}</p>{/if}
  {:else if card.kind === 'call'}
    {@const proposal = card.proposal}
    <header>
      {@render badge(card.icon, einsatzColors.task)}
      <h3>{card.label}</h3>
      <span class="code">{card.code}</span>
      {#if card.isNew}<span class="new">{dispatchWords.newBadge}</span>{/if}
      <button type="button" class="x" aria-label={dispatchWords.close} onclick={props.back}>×</button>
    </header>
    {@render slot()}
    <p class="status"><span class="priority">{card.priority}</span> · <span class="num">{card.waiting}</span>{#if card.overdue !== null} · <span class="overdue">{card.overdue}</span>{/if}</p>
    <ul class="needs">
      {#each card.needs as need, index (index)}<li class:met={need.met}>{need.met ? '✓' : '✗'} {need.text}</li>{/each}
    </ul>
    <div class="command" class:waiting={proposal.waiting}>
      <div class="command-row">
        <button type="button" class="primary" disabled={!proposal.button.enabled} onclick={() => { if (proposal.order !== null) props.order(proposal.order) }}>{proposal.button.label}</button>
        <button type="button" class="refresh" disabled={!proposal.refresh.enabled} onclick={() => props.refresh(card.id)}>{proposal.refresh.label}</button>
      </div>
      <p class="reason command-reason">{proposal.button.reason ?? ''}</p>
      {#if proposal.units.length > 0}
        <div class="chips" role="group" aria-label={proposal.button.label}>
          {#each proposal.units as unit (unit.unitId)}
            <button type="button" class="chip" class:dropped={unit.dropped} aria-pressed={!unit.dropped} disabled={proposal.waiting} onclick={() => props.toggleChip(unit.unitId)}>{unit.label}{#if unit.eta !== null} · {unit.eta}{/if}</button>
          {/each}
        </div>
      {/if}
      {#if proposal.covers !== null}<p class="facts">{proposal.covers}{#if proposal.remainder !== null} · {proposal.remainder}{/if}</p>{/if}
    </div>
    {#each card.deliverTo as carrier (carrier.unitLabel)}
      <div class="chips" role="group" aria-label={carrier.heading}>
        <span class="chips-label">{carrier.heading}</span>
        {#each carrier.sites as site (site.siteId)}<button type="button" class="order-chip" disabled={!carrier.enabled} onclick={() => props.order(site.order)}>{site.text}</button>{/each}
      </div>
    {/each}
    {#each card.alternatives as alternative (alternative.heading)}
      <div class="chips" role="group" aria-label={alternative.heading}>
        <span class="chips-label">{alternative.heading}</span>
        {#each alternative.units as unit (unit.unitId)}<button type="button" class="order-chip" disabled={proposal.waiting} onclick={() => props.order(unit.order)}>{unit.text}</button>{/each}
      </div>
    {/each}
    {#if card.whyNot.length > 0}
      <details>
        <summary>{dispatchWords.whyNot}</summary>
        <ul>{#each card.whyNot as entry (entry.label)}<li>{entry.label}: {entry.reasons}</li>{/each}</ul>
      </details>
    {/if}
    {#each card.assigned as unit (unit.unitId)}<p class="assigned">{unit.text}</p>{/each}
    {#each card.states as state, index (index)}<p class="state">{state}</p>{/each}
    <div class="apart">
      <button type="button" class="destructive" disabled={props.confirming} onclick={() => props.askClose(card.id)}>{card.close.label}</button>
      {#if props.confirming}
        <button type="button" class="destructive confirm" onclick={() => props.closeTask(card.id)}>{card.close.confirm}</button>
        <button type="button" onclick={props.cancelClose}>{dispatchWords.cancel}</button>
      {/if}
    </div>
  {:else if card.kind === 'closed-call'}
    <header>
      <h3>{card.label}</h3>
      <button type="button" class="x" aria-label={dispatchWords.close} onclick={props.back}>×</button>
    </header>
    {@render slot()}
    <p class="status">{card.text}</p>
  {:else}
    <header>
      {@render badge(card.icon, einsatzColors.unit)}
      <h3>{card.title}</h3>
      <button type="button" class="x" aria-label={dispatchWords.close} onclick={props.back}>×</button>
    </header>
    {@render slot()}
    {#if card.receiving !== null}
      {@const receiving = card.receiving}
      <p class="status">{receiving.accepting} · {receiving.slots}</p>
      <button type="button" class="secondary" onclick={() => props.setSite(card.id, receiving.toggle.accepting)}>{receiving.toggle.label}</button>
    {/if}
    {#if card.inbound.length > 0}
      <h4>{dispatchWords.inbound}</h4>
      <ul class="needs">{#each card.inbound as unit, index (index)}<li>{unit}</li>{/each}</ul>
    {/if}
    {#each card.states as state, index (index)}<p class="state">{state}</p>{/each}
  {/if}
</article>

<style>
  .card { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--accent); border-radius: 8px; background: var(--panel); }
  header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  h3 { flex: 1; min-width: 0; margin: 0; font-size: 14px; overflow-wrap: anywhere; }
  h4 { margin: 4px 0 0; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  p { margin: 0; }
  .badge { flex: none; width: 24px; height: 24px; display: inline-grid; place-items: center; border-radius: 50%; }
  .badge img { width: 16px; height: 16px; }
  .banner { display: flex; align-items: center; gap: 8px; padding: 0 0 0 8px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 16%, var(--panel)); }
  .banner strong { flex: 1; }
  /* The reserved slots keep their height empty or full, so nothing under them moves when a refusal comes or goes. */
  .slot { min-height: 32px; }
  .armed-slot { min-height: 44px; display: grid; align-items: center; }
  .reason { min-height: 16px; }
  button { min-height: 44px; min-width: 44px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; font: inherit; font-size: 13px; cursor: pointer; touch-action: manipulation; text-align: left; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .x { flex: none; text-align: center; font-size: 18px; line-height: 1; }
  .primary { width: 100%; text-align: center; border-color: var(--accent); background: var(--accent); color: var(--panel); font-weight: 700; }
  .secondary { width: 100%; text-align: center; }
  .row-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stacked { display: grid; gap: 2px; }
  .stacked button { width: 100%; }
  .command { display: grid; gap: 4px; }
  .command.waiting { opacity: .7; }
  .command-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  .refresh { text-align: center; font-size: 12px; }
  .status { color: var(--text); }
  .status[data-tone='free'] .dot { color: var(--success); }
  .status[data-tone='busy'] .dot { color: var(--accent); }
  .status[data-tone='returning'] .dot { color: var(--muted); }
  .status[data-tone='attention'] .dot, .status[data-tone='out'] .dot { color: var(--critical); }
  .note, .reason, .facts, .by, .why, .priority { color: var(--muted); font-size: 12px; }
  .refusal, .state, .overdue { color: var(--critical); font-size: 12px; }
  .code { font-weight: 750; color: var(--critical); }
  .new { padding: 1px 6px; border-radius: 6px; background: var(--warning); color: var(--panel); font-size: 11px; font-weight: 750; }
  .targets, .plan, .needs { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .rows-note { min-height: 44px; display: flex; align-items: center; }
  .target { width: 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .target.dimmed { opacity: .6; }
  .drops { color: var(--warning); font-size: 12px; }
  .plan li { display: flex; align-items: center; gap: 6px; }
  .plan li.active .what { font-weight: 650; }
  .plan .predicted { color: var(--muted); font-style: italic; }
  .index { flex: none; width: 18px; text-align: center; color: var(--muted); }
  .what { flex: 1; min-width: 0; }
  .needs li.met { color: var(--success); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .chips-label { color: var(--muted); font-size: 12px; }
  /* A toggle chip drops or restores a proposed unit; it orders nothing. */
  .chip { border-radius: 22px; border-style: dashed; }
  .chip.dropped { opacity: .5; text-decoration: line-through; }
  /* An order chip gives an order on one tap: a solid accent button, apart from the toggles. */
  .order-chip { border-color: var(--accent); color: var(--accent); font-weight: 650; }
  .apart { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .destructive { border-color: var(--critical); color: var(--critical); }
  .confirm { font-weight: 700; }
  .warning { border-color: var(--warning); color: var(--warning); }
  summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--muted); font-size: 12px; }
  details ul { margin: 0; padding-left: 16px; color: var(--muted); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
</style>
