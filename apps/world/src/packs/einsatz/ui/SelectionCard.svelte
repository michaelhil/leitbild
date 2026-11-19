<script lang="ts">
  import { ArrowDown, ArrowUp, House, X } from 'lucide-svelte'
  import { einsatzColors } from '../colors.ts'
  import type { Stop, UnitOrderInput } from '../order-schema.ts'
  import { svgImageSource } from './einsatz-client.ts'
  import { dispatchWords, type CardView, type PlanStopView } from './presenters.ts'

  /**
   * The unit card keeps the plan and map selection controls in reach.
   * The Targets disclosure gives the same actions to keyboard users.
   * The other cards keep their call and site controls.
   */
  interface Props {
    readonly card: CardView
    readonly unitPending: boolean
    /** The last refusal or failure the panel reports, shown in the card's reserved slot. */
    readonly feedback: string | null
    readonly icon: (id: string) => string | undefined
    /** Whether this call's Close waits for its confirm. */
    readonly confirming: boolean
    readonly back: () => void
    readonly targetRow: (target: Stop) => void
    readonly recall: (unitId: string) => void
    readonly undo: (unitId: string, commandId: string) => void
    readonly chooseStop: (stopId: string) => void
    readonly moveStop: (stopId: string, direction: -1 | 1) => void
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

{#snippet chosen(label: string)}
  <span class="order-chip selected" aria-current="true">✓ {label}</span>
{/snippet}

{#snippet planStop(stop: PlanStopView)}
  <span class="index">{stop.index}</span>
  <span class="what">
    {stop.text}{#if stop.eta !== null} · <span class="num">{stop.eta}</span>{/if}
    {#if stop.by !== null}<span class="by">{stop.by}</span>{/if}
  </span>
{/snippet}

<article class="card" data-kind={card.kind} aria-label={card.kind === 'unit' || card.kind === 'site' ? card.title : card.label}>
  {#if card.kind === 'unit'}
    <header>
      {@render badge(card.icon, einsatzColors.unit)}
      <div class="unit-name">
        <h3>{card.title}</h3>
        <p class="status" data-tone={card.status.tone}><span class="dot" aria-hidden="true">●</span> {card.status.word}{#if card.status.due !== null} · <span class="num">{card.status.due}</span>{/if}</p>
      </div>
      {#if card.readOnly === null}
        <button type="button" class="icon-action" title={card.recall.reason ?? card.recall.label} aria-label={card.recall.label} disabled={props.unitPending || !card.recall.enabled} onclick={() => props.recall(card.id)}>
          <House size={17} aria-hidden="true" />
        </button>
      {/if}
      <button type="button" class="icon-action" title={dispatchWords.close} aria-label={dispatchWords.close} onclick={props.back}>
        <X size={17} aria-hidden="true" />
      </button>
    </header>
    {#if card.readOnly !== null}<p class="note">{card.readOnly}</p>{/if}
    {#if props.feedback !== null}<p class="refusal" role="alert">{props.feedback}</p>{/if}
    {#each card.states as state, index (index)}<p class="state">{state}</p>{/each}
    {#if card.plan.length > 0 || card.predicted !== null}
      <h4>{card.planHeading}</h4>
      <ol class="plan">
        {#each card.plan as stop (stop.id)}
          <li class:active={stop.active} aria-current={stop.active ? 'step' : undefined}>
            {#if card.removable}
              <button type="button" class="stop-target" title={stop.removeLabel} aria-label={stop.removeLabel} disabled={props.unitPending} onclick={() => props.chooseStop(stop.id)}>
                {@render planStop(stop)}
              </button>
            {:else}
              <span class="stop-target">{@render planStop(stop)}</span>
            {/if}
            {#if stop.canMoveUp || stop.canMoveDown}
              <div class="move-controls">
                <button type="button" class="icon-action" title="Move earlier" aria-label={`Move stop ${stop.index} earlier: ${stop.text}`} disabled={props.unitPending || !stop.canMoveUp} onclick={() => props.moveStop(stop.id, -1)}>
                  <ArrowUp size={16} aria-hidden="true" />
                </button>
                <button type="button" class="icon-action" title="Move later" aria-label={`Move stop ${stop.index} later: ${stop.text}`} disabled={props.unitPending || !stop.canMoveDown} onclick={() => props.moveStop(stop.id, 1)}>
                  <ArrowDown size={16} aria-hidden="true" />
                </button>
              </div>
            {/if}
          </li>
        {/each}
        {#if card.predicted !== null}<li class="predicted"><span class="index">┄</span><span class="what">{card.predicted}</span></li>{/if}
      </ol>
    {/if}
    {#if card.readOnly === null}
      {@const undo = card.undo}
      <div class="undo-row">
        <button type="button" disabled={props.unitPending || !undo.enabled} onclick={() => { if (undo.commandId !== null) props.undo(card.id, undo.commandId) }}>{undo.label}</button>
        {#if undo.reason !== null}<span class="reason">{undo.reason}</span>{/if}
      </div>
      {#if props.unitPending || card.targetNotice !== null}<p class="note" role="status">{props.unitPending ? 'Updating plan…' : card.targetNotice}</p>{/if}
      {#if card.targets.length > 0 || card.targetsLoading}
        <details class="unit-disclosure">
          <summary>Targets</summary>
          <ol class="targets">
            {#each card.targets as row (row.key)}
              <li><button type="button" class="target" disabled={props.unitPending || card.targetsLoading} onclick={() => props.targetRow(row.target)}>
                <span>{row.text}</span>
                {#if row.eta !== null}<span class="num">{row.eta}</span>{/if}
              </button></li>
            {/each}
          </ol>
        </details>
      {/if}
    {/if}
    {#if card.facts.length > 0 || (card.readOnly === null && card.recall.reason !== null)}
      <details class="unit-disclosure">
        <summary>Unit details</summary>
        {#if card.facts.length > 0}<p class="facts">{card.facts.join(' · ')}</p>{/if}
        {#if card.readOnly === null && card.recall.reason !== null}<p class="note">{card.recall.reason}</p>{/if}
      </details>
    {/if}
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
    {#if card.observed !== null}<p class="note">{card.observed}</p>{/if}
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
        {#each carrier.sites as site (site.siteId)}
          {#if !carrier.enabled}<span class="site-name">{site.text}</span>
          {:else if site.selected}{@render chosen(site.text)}
          {:else}<button type="button" class="order-chip" onclick={() => props.order(site.order)}>{site.text}</button>{/if}
        {/each}
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
  /* The reserved slots keep their height empty or full, so nothing under them moves when a refusal comes or goes. */
  .slot { min-height: 32px; }
  .reason { min-height: 16px; }
  button { min-height: 44px; min-width: 44px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; font: inherit; font-size: 13px; cursor: pointer; touch-action: manipulation; text-align: left; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .x { flex: none; text-align: center; font-size: 18px; line-height: 1; }
  .unit-name { flex: 1; min-width: 0; }
  .unit-name p { margin-top: 2px; font-size: 12px; }
  .icon-action { flex: none; display: inline-grid; place-items: center; padding: 0; }
  .primary { width: 100%; text-align: center; border-color: var(--accent); background: var(--accent); color: var(--panel); font-weight: 700; }
  .secondary { width: 100%; text-align: center; }
  .command { display: grid; gap: 4px; }
  .command.waiting { opacity: .7; }
  .command-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  .refresh { text-align: center; font-size: 12px; }
  .status { color: var(--text); }
  .status[data-tone='free'] .dot { color: var(--success); }
  .status[data-tone='busy'] .dot { color: var(--accent); }
  .status[data-tone='returning'] .dot { color: var(--muted); }
  .status[data-tone='attention'] .dot, .status[data-tone='out'] .dot { color: var(--critical); }
  .note, .reason, .facts, .by, .priority { color: var(--muted); font-size: 12px; }
  .refusal, .state, .overdue { color: var(--critical); font-size: 12px; }
  .code { font-weight: 750; color: var(--critical); }
  .new { padding: 1px 6px; border-radius: 6px; background: var(--warning); color: var(--panel); font-size: 11px; font-weight: 750; }
  .targets, .plan, .needs { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .target { width: 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; }
  .plan li, .stop-target { display: flex; align-items: center; gap: 6px; }
  .stop-target { flex: 1; min-width: 44px; padding: 4px; }
  button.stop-target { border-color: transparent; }
  button.stop-target:hover { border-color: var(--border); }
  .move-controls { display: flex; gap: 4px; }
  .undo-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .plan li.active .what { font-weight: 650; }
  .plan .predicted { color: var(--muted); font-style: italic; }
  .index { flex: none; min-width: 18px; text-align: center; color: var(--critical); font-variant-numeric: tabular-nums; }
  .predicted .index { color: var(--muted); }
  .what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .needs li.met { color: var(--success); }
  /* A chips row keeps one height whether its sites are named or offered, so nothing under it moves when Dispatch makes them live. */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-height: 44px; }
  .chips-label { color: var(--muted); font-size: 12px; }
  /* A toggle chip drops or restores a proposed unit; it orders nothing. */
  .chip { border-radius: 22px; border-style: dashed; }
  .chip.dropped { opacity: .5; text-decoration: line-through; }
  /* An order chip gives an order on one tap: a solid accent button, apart from the toggles. */
  .order-chip { border-color: var(--accent); color: var(--accent); font-weight: 650; }
  /* Where the load goes now: the chosen site, filled. */
  .order-chip.selected { box-sizing: border-box; min-height: 44px; display: inline-flex; align-items: center; padding: 4px 10px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: var(--panel); font-size: 13px; }
  /* A site named before the carrier is on the call: plain text, not a button. */
  .site-name { color: var(--muted); font-size: 12px; }
  .apart { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .destructive { border-color: var(--critical); color: var(--critical); }
  .confirm { font-weight: 700; }
  summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--muted); font-size: 12px; }
  .unit-disclosure summary { display: list-item; padding-block: 13px; box-sizing: border-box; }
  .unit-disclosure summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  details ul { margin: 0; padding-left: 16px; color: var(--muted); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
</style>
