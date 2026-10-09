<script lang="ts">
  import type { ComposedAlarmsPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { alarmAge, visibleAlarms } from './panel-presenters.ts'

  let { panel, latest }: { panel: ComposedAlarmsPanel; latest: ComposedDisplaySample | undefined } = $props()

  const alarms = $derived(visibleAlarms(latest?.alarms ?? [], panel.scope, panel.ruleIds))
  // When some do not fit, the last row says how many and how many are unacknowledged.
  const shown = $derived(alarms.length > composedDisplayLayout.alarmRows ? alarms.slice(0, composedDisplayLayout.alarmRows - 1) : alarms)
  const hidden = $derived(alarms.slice(shown.length))
</script>

<section class="alarms" style={`height:${composedDisplayLayout.alarms}px`} aria-label="Active alarms">
  <h2>{panel.scope === 'related' ? 'Related active alarms' : 'Active alarms in this unit'}</h2>
  {#if latest?.alarms === undefined}
    <p class="empty">Alarm state not received yet.</p>
  {:else if alarms.length === 0}
    <p class="empty">{panel.scope === 'related' ? 'No active alarm or trip on the displayed signals.' : 'No active alarm or trip.'}</p>
  {:else}
    <ul>
      {#each shown as alarm (alarm.id)}
        <li class={`severity-${alarm.severity}`} class:unacknowledged={!alarm.acknowledged}>
          <span class="kind">{alarm.kind === 'trip' ? 'TRIP' : 'ALM'}</span>
          <span class="title" title={alarm.title}>{alarm.title}</span>
          {#if alarm.firstOut}<span class="flag">first out</span>{/if}
          {#if !alarm.acknowledged}<span class="flag">unack</span>{/if}
          <span class="age">{alarmAge(latest.plantElapsedMs, alarm.firstActiveElapsedMs)}</span>
        </li>
      {/each}
    </ul>
    {#if hidden.length > 0}<p class="more">+{hidden.length} more active{#if hidden.some(alarm => !alarm.acknowledged)}{' '}({hidden.filter(alarm => !alarm.acknowledged).length} unacknowledged){/if}</p>{/if}
  {/if}
</section>

<style>
  .alarms { display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
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
