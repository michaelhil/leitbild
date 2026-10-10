<script lang="ts">
  import type { ComposedAlarmsPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { alarmAge, alertTypeOf, visibleAlarms } from './panel-presenters.ts'

  // Filling a unit overview's narrow column, the list takes the height left
  // there: each alarm gets two lines (its whole title, then its flags and
  // age), and as many show as that height holds. Narrowed to one annunciator
  // system, the list says so and always ends with what the other systems hold.
  let { panel, latest, fill = false, only = null, showAll }: {
    panel: ComposedAlarmsPanel
    latest: ComposedDisplaySample | undefined
    fill?: boolean
    /** `drawn`: whether the drawing beside the list shows anything of the system. */
    only?: { readonly name: string; readonly label: string; readonly ruleIds: ReadonlyArray<string>; readonly drawn: boolean } | null
    showAll?: () => void
  } = $props()

  /** A two-line row and the gap under it, and the title line with its gap (the CSS below). */
  const TWO_LINE_PITCH = 40
  const TITLE = 17
  let height = $state<number>(composedDisplayLayout.alarms)
  // At its least height (composedDisplayLayout.alarms) the column's list holds two alarms.
  const rows = $derived(fill ? Math.max(2, Math.floor((height - TITLE) / TWO_LINE_PITCH)) : composedDisplayLayout.alarmRows)

  const all = $derived(visibleAlarms(latest?.alarms ?? [], panel.scope, panel.ruleIds))
  const onlyRules = $derived(only === null ? null : new Set(only.ruleIds))
  const alarms = $derived(onlyRules === null ? all : all.filter(alarm => onlyRules.has(alarm.ruleId)))
  const elsewhere = $derived(onlyRules === null ? [] : all.filter(alarm => !onlyRules.has(alarm.ruleId)))
  // When some do not fit, the last row says how many and how many are unacknowledged; narrowed, a row is kept for the other systems.
  const room = $derived(rows - (elsewhere.length > 0 ? 1 : 0))
  const shown = $derived(alarms.length > room ? alarms.slice(0, Math.max(0, room - 1)) : alarms)
  const hidden = $derived(alarms.slice(shown.length))
  const unacknowledged = (list: ReadonlyArray<{ readonly acknowledged: boolean }>) => list.filter(alarm => !alarm.acknowledged).length
</script>

<section class="alarms" class:fill style={fill ? `min-height:${composedDisplayLayout.alarms}px` : `height:${composedDisplayLayout.alarms}px`} bind:clientHeight={height} aria-label="Active alarms">
  {#if only !== null}
    <h2 class="narrowed" title={`${only.name}${only.drawn ? '' : ': none of its equipment is drawn here'}`}><span>{only.label} · {alarms.length} of {all.length}{only.drawn ? '' : ' · not drawn'}</span><button type="button" onclick={() => showAll?.()}>All ✕</button></h2>
  {:else}
    <h2>{panel.scope === 'related' ? 'Related active alarms' : 'Active alarms in this unit'}</h2>
  {/if}
  {#if latest?.alarms === undefined}
    <p class="empty">Alarm state not received yet.</p>
  {:else if alarms.length === 0 && elsewhere.length === 0}
    <p class="empty">{panel.scope === 'related' ? 'No active alarm or trip on the displayed signals.' : 'No active alarm or trip.'}</p>
  {:else}
    {#if alarms.length === 0}<p class="empty">No active alarm or trip in this system.</p>{/if}
    <ul>
      {#each shown as alarm (alarm.id)}
        {#if fill}
          <li class={`alert-${alertTypeOf(alarm.severity)} two-line`} class:unacknowledged={!alarm.acknowledged} class:cleared={!alarm.active}>
            <span class="kind">{alarm.kind === 'trip' ? 'TRIP' : 'ALM'}</span>
            <span class="title" title={alarm.title}>{alarm.title}</span>
            <span class="meta">{#if !alarm.active}<span class="flag">cleared</span>{/if}{#if alarm.firstOut}<span class="flag">first out</span>{/if}{#if !alarm.acknowledged}<span class="flag">unack</span>{/if}<span class="age">{alarmAge(latest.plantElapsedMs, alarm.firstActiveElapsedMs)}</span></span>
          </li>
        {:else}
          <li class={`alert-${alertTypeOf(alarm.severity)}`} class:unacknowledged={!alarm.acknowledged} class:cleared={!alarm.active}>
            <span class="kind">{alarm.kind === 'trip' ? 'TRIP' : 'ALM'}</span>
            <span class="title" title={alarm.title}>{alarm.title}</span>
            {#if !alarm.active}<span class="flag">cleared</span>{/if}
            {#if alarm.firstOut}<span class="flag">first out</span>{/if}
            {#if !alarm.acknowledged}<span class="flag">unack</span>{/if}
            <span class="age">{alarmAge(latest.plantElapsedMs, alarm.firstActiveElapsedMs)}</span>
          </li>
        {/if}
      {/each}
    </ul>
    {#if hidden.length > 0}<p class="more">+{hidden.length} more{#if unacknowledged(hidden) > 0}{' '}({unacknowledged(hidden)} unacknowledged){/if}</p>{/if}
    {#if elsewhere.length > 0}
      <!-- Never hidden by the filter: what the other systems hold, in the colour of the worst of it. -->
      <p class={`more elsewhere alert-${alertTypeOf(elsewhere[0]!.severity)}`}>+{elsewhere.length} in other systems{#if unacknowledged(elsewhere) > 0}{' '}({unacknowledged(elsewhere)} unacknowledged){/if}</p>
    {/if}
  {/if}
</section>

<style>
  .alarms { display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .alarms.fill { flex: 1 1 auto; }
  /* Two lines of 17 px (TWO_LINE_PITCH with the list's gap): the title across the row, then kind, flags and age. */
  li.two-line { display: grid; grid-template-columns: 32px minmax(0, 1fr); grid-template-rows: 17px 17px; column-gap: 8px; align-items: center; height: 38px; }
  li.two-line .title { grid-row: 1; grid-column: 1 / span 2; }
  li.two-line .kind { grid-row: 2; grid-column: 1; }
  li.two-line .meta { grid-row: 2; grid-column: 2; display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
  h2 { margin: 0; font-size: 11px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; gap: 8px; min-width: 0; height: 21px; padding: 0 6px; border-left: 4px solid var(--border-divider-color); background: var(--container-section-color); font-size: 12px; }
  /* Alarm colour appears only for real alarms, keyed by severity (alertTypeOf); a cleared one keeps it, dimmed, until acknowledged. */
  li.alert-alarm, .elsewhere.alert-alarm { border-left-color: var(--alert-alarm-color); }
  li.alert-warning, .elsewhere.alert-warning { border-left-color: var(--alert-warning-color); }
  li.alert-caution, .elsewhere.alert-caution { border-left-color: var(--alert-caution-color); }
  li.unacknowledged .title { font-weight: 600; }
  li.cleared .title { color: var(--element-neutral-color); }
  .elsewhere { margin: 0; padding: 2px 6px; border-left: 4px solid var(--border-divider-color); background: var(--container-section-color); }
  h2.narrowed { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--element-active-color); }
  h2.narrowed span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h2 button { font: inherit; font-size: 11px; text-transform: none; letter-spacing: 0; padding: 0 6px; border: 1px solid var(--border-outline-color); border-radius: 3px; background: var(--container-section-color); color: var(--element-active-color); cursor: pointer; }
  .kind { font-size: 10.5px; font-weight: 700; width: 32px; flex: none; }
  .title { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .flag { font-size: 10.5px; color: var(--element-neutral-color); flex: none; }
  .age { font-size: 11px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; flex: none; }
  .empty, .more { margin: 2px 0; font-size: 12px; color: var(--element-neutral-color); }
</style>
