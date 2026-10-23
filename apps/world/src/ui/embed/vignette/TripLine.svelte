<script lang="ts">
  import { ageText, tripLine } from '../../../features/displays/alerts/list.ts'
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import type { VignetteView } from '../../../features/displays/compose/model.ts'
  import { elementOf } from './alerts.ts'
  import { wholeWords } from './fit-words.ts'
  import { vignetteOpening } from './opening.svelte.ts'

  // The trip line under a vignette's title row (plan v5 W2.4): for the one
  // object the vignette draws or lists, each first-out whose group stops an
  // energy end (the trip), in the order they came in, as the alarm strip
  // orders them: its group's label, its message and its age ("<GROUP>
  // <message> 2:59 · <GROUP> <message> 2:58", in the Pack's words); then
  // "ACTUATED:" and the other groups that hold, by their labels. Every
  // label opens what it names: a trip's label the energy end it
  // stops, a message and an actuation the element its alert is on (a drawing
  // here selects it, else its default opens after this display). Only the
  // messages give way, by whole words; labels and ages are never cut. Nothing
  // shows while nothing has tripped or actuated; where the composer keeps the
  // row (`reserve`: a whole object, with its chips), the row stays, empty, so
  // nothing below it moves when a trip comes in.
  let { view, rows, reserve = false }: { view: VignetteView; rows: ReadonlyArray<AlertRow>; reserve?: boolean } = $props()

  const opening = vignetteOpening()
  /** The object it is about: the one its drawing draws, else the one its alerts list. */
  const objectId = $derived.by((): string | null => {
    const drawn = view.sections.find(section => section.kind === 'topology')
    if (drawn?.kind === 'topology') return drawn.objectId
    const listed = [...new Set(view.sections.flatMap(section => section.kind === 'alerts' && section.objectIds !== 'run' ? section.objectIds : []))]
    return listed.length === 1 ? listed[0]! : null
  })
  const line = $derived(objectId === null ? { leads: [], actuated: [] } : tripLine(rows, objectId))
  const nowMs = $derived(opening?.now ?? Number.NaN)
  const can = $derived(opening !== undefined && opening.where !== null)
  const show = (elementId: string | undefined): (() => void) | undefined =>
    !can || elementId === undefined || objectId === null ? undefined : () => { void opening!.element(objectId, elementId) }
</script>

{#snippet label(text: string, opens: (() => void) | undefined, what: string)}
  {#if opens === undefined}<span class="label">{text}</span>{:else}<button type="button" class="label" title={`${what}: open`} onclick={opens}>{text}</button>{/if}
{/snippet}

{#if line.leads.length > 0 || line.actuated.length > 0}
  <div class="trip" aria-label="Trip and actuations">
    {#each line.leads as lead, index (lead.row.key)}
      {#if index > 0}<span class="sep" aria-hidden="true">·</span>{/if}
      <span class="lead">
        {#if lead.label !== undefined}{@render label(lead.label, show(lead.ends[0]), lead.label)}{/if}
        {#if show(elementOf(lead.row)) === undefined}
          <span class="message" aria-hidden="true" use:wholeWords={lead.row.alert.message}></span>
        {:else}
          <button type="button" class="message" aria-label={`${lead.row.alert.message}: open`} title={`${lead.row.alert.message}: open`} onclick={show(elementOf(lead.row))} use:wholeWords={lead.row.alert.message}></button>
        {/if}
        {#if show(elementOf(lead.row)) === undefined}<span class="full">{lead.row.alert.message}</span>{/if}
        {#if ageText(nowMs, lead.row) !== null}<span class="age" title={`${lead.row.raised?.at.slice(11, 19) ?? ''} UTC`}>{ageText(nowMs, lead.row)}</span>{/if}
      </span>
    {/each}
    {#if line.actuated.length > 0}
      {#if line.leads.length > 0}<span class="sep" aria-hidden="true">·</span>{/if}
      <span class="actuated"><span class="word">ACTUATED:</span>{#each line.actuated as actuated, index (actuated.label)}{#if index > 0}<span class="sep" aria-hidden="true">·</span>{/if}{@render label(actuated.label, show(elementOf(actuated.row)), actuated.row.alert.message)}{/each}</span>
    {/if}
  </div>
{:else if reserve}
  <div class="trip" aria-hidden="true"></div>
{/if}

<style>
  .trip { display: flex; align-items: center; gap: 6px; height: var(--row); min-width: 0; white-space: nowrap; overflow: hidden; font-size: 13px; }
  .lead { display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; }
  .label, .word { flex: none; font-weight: 700; letter-spacing: 0.03em; }
  .label { padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; background: none; color: var(--element-active-color); font: inherit; font-weight: 700; }
  button.label, button.message { cursor: pointer; }
  button.label:hover, button.message:hover { background: var(--flat-hover-background-color); }
  button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  /* The one part that gives way, by whole words. */
  .message { flex: 0 1 auto; min-width: 0; overflow: hidden; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
  .age { flex: none; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .sep { flex: none; color: var(--element-neutral-color); }
  .actuated { display: flex; align-items: center; gap: 6px; flex: none; }
  .full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
