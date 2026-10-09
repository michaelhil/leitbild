<script lang="ts">
  import type { ComposedAlarmsPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { alarmAge, visibleAlarms } from './panel-presenters.ts'

  // Filling a unit overview's narrow column, the list takes the height left
  // there: each alarm gets two lines (its whole title, then its flags and
  // age), and as many show as that height holds.
  let { panel, latest, fill = false }: { panel: ComposedAlarmsPanel; latest: ComposedDisplaySample | undefined; fill?: boolean } = $props()

  /** A two-line row and the gap under it, and the title line with its gap (the CSS below). */
  const TWO_LINE_PITCH = 40
  const TITLE = 17
  let height = $state<number>(composedDisplayLayout.alarms)
  // At its least height (composedDisplayLayout.alarms) the column's list holds two alarms.
  const rows = $derived(fill ? Math.max(2, Math.floor((height - TITLE) / TWO_LINE_PITCH)) : composedDisplayLayout.alarmRows)

  const alarms = $derived(visibleAlarms(latest?.alarms ?? [], panel.scope, panel.ruleIds))
  // When some do not fit, the last row says how many and how many are unacknowledged.
  const shown = $derived(alarms.length > rows ? alarms.slice(0, rows - 1) : alarms)
  const hidden = $derived(alarms.slice(shown.length))
</script>

<section class="alarms" class:fill style={fill ? `min-height:${composedDisplayLayout.alarms}px` : `height:${composedDisplayLayout.alarms}px`} bind:clientHeight={height} aria-label="Active alarms">
  <h2>{panel.scope === 'related' ? 'Related active alarms' : 'Active alarms in this unit'}</h2>
  {#if latest?.alarms === undefined}
    <p class="empty">Alarm state not received yet.</p>
  {:else if alarms.length === 0}
    <p class="empty">{panel.scope === 'related' ? 'No active alarm or trip on the displayed signals.' : 'No active alarm or trip.'}</p>
  {:else}
    <ul>
      {#each shown as alarm (alarm.id)}
        {#if fill}
          <li class={`severity-${alarm.severity} two-line`} class:unacknowledged={!alarm.acknowledged}>
            <span class="kind">{alarm.kind === 'trip' ? 'TRIP' : 'ALM'}</span>
            <span class="title" title={alarm.title}>{alarm.title}</span>
            <span class="meta">{#if alarm.firstOut}<span class="flag">first out</span>{/if}{#if !alarm.acknowledged}<span class="flag">unack</span>{/if}<span class="age">{alarmAge(latest.plantElapsedMs, alarm.firstActiveElapsedMs)}</span></span>
          </li>
        {:else}
          <li class={`severity-${alarm.severity}`} class:unacknowledged={!alarm.acknowledged}>
            <span class="kind">{alarm.kind === 'trip' ? 'TRIP' : 'ALM'}</span>
            <span class="title" title={alarm.title}>{alarm.title}</span>
            {#if alarm.firstOut}<span class="flag">first out</span>{/if}
            {#if !alarm.acknowledged}<span class="flag">unack</span>{/if}
            <span class="age">{alarmAge(latest.plantElapsedMs, alarm.firstActiveElapsedMs)}</span>
          </li>
        {/if}
      {/each}
    </ul>
    {#if hidden.length > 0}<p class="more">+{hidden.length} more active{#if hidden.some(alarm => !alarm.acknowledged)}{' '}({hidden.filter(alarm => !alarm.acknowledged).length} unacknowledged){/if}</p>{/if}
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
  /* Alarm colour appears only for real, active alarms, keyed by severity. */
  li.severity-critical { border-left-color: var(--alert-alarm-color); }
  li.severity-warning { border-left-color: var(--alert-warning-color); }
  li.severity-notice, li.severity-info { border-left-color: var(--alert-caution-color); }
  li.unacknowledged .title { font-weight: 600; }
  .kind { font-size: 10.5px; font-weight: 700; width: 32px; flex: none; }
  .title { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .flag { font-size: 10.5px; color: var(--element-neutral-color); flex: none; }
  .age { font-size: 11px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; flex: none; }
  .empty, .more { margin: 2px 0; font-size: 12px; color: var(--element-neutral-color); }
</style>
