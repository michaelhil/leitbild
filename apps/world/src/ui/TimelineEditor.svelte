<script lang="ts">
  import type { ScenarioDefinition } from '../core/scenarios/definition.ts'
  import type { ScenarioAuthoringCatalog } from '../core/scenarios/authoring.ts'
  import AdvancedConfiguration from './AdvancedConfiguration.svelte'
  import { scenarioTimelineCueSchema } from '../core/model/scenario.ts'
  type Cue = NonNullable<ScenarioDefinition['timeline']>['cues'][number]
  let { cues, commands, onchange }: { cues: Cue[]; commands: ScenarioAuthoringCatalog['commands']; onchange: (cues: Cue[]) => void } = $props()
  const replace = (index: number, cue: Cue) => onchange(cues.map((value, i) => i === index ? cue : value))
  const add = () => onchange([...cues, { id: `cue-${crypto.randomUUID()}`, title: 'Untitled cue', at: { kind: 'after_scenario_start', seconds: Math.max(0, ...cues.map(cue => cue.at.seconds)) + 60 }, actions: [] }])
</script>
<section>
  <h3>Timeline</h3><p>Discrete actions use simulation time. Equal-time cues execute in the order listed.</p>
  {#each cues as cue, index (cue.id)}
    <details>
      <summary>{cue.at.seconds}s · {cue.title ?? cue.id}</summary>
      <label>Title <input value={cue.title ?? ''} oninput={event => replace(index, { ...cue, title: event.currentTarget.value })} /></label>
      <label>Seconds after start <input type="number" min="0" value={cue.at.seconds} oninput={event => { if (Number.isFinite(event.currentTarget.valueAsNumber)) replace(index, { ...cue, at: { ...cue.at, seconds: event.currentTarget.valueAsNumber } }) }} /></label>
      {#each cue.actions as action, actionIndex}
        {#if action.type === 'invoke_capability'}
          {@const command = commands.find(command => command.id === action.capabilityId)}
          <p>{command?.title ?? action.capabilityId}</p>
          <AdvancedConfiguration label="Command input" value={action.input} onapply={async input => {
            const updated = { ...cue, actions: cue.actions.map((value, i) => i === actionIndex ? { ...action, input } : value) }
            replace(index, updated)
          }} />
          {#if command}<details><summary>Input schema</summary><pre>{JSON.stringify(command.inputSchema, null, 2)}</pre></details>{/if}
        {:else}<p>{action.type.replaceAll('_', ' ')}</p>{/if}
        <button onclick={() => replace(index, { ...cue, actions: cue.actions.filter((_, i) => i !== actionIndex) })}>Remove action</button>
      {/each}
      <label>Add command <select value="" onchange={event => { const id = event.currentTarget.value; if (id) replace(index, { ...cue, actions: [...cue.actions, { type: 'invoke_capability', capabilityId: id, input: {} }] }); event.currentTarget.value = '' }}><option value="">Choose a command…</option>{#each commands as command (command.id)}<option value={command.id}>{command.title}</option>{/each}</select></label>
      {#if cue.actions.length === 0}<p>Add an action before saving this cue.</p>{/if}
      <AdvancedConfiguration label="Cue configuration" value={cue} onapply={async value => { const next = scenarioTimelineCueSchema.parse(value); if (next.id !== cue.id) throw new Error('Cue identity cannot be changed here.'); replace(index, next) }} />
      <button onclick={() => onchange(cues.filter((_, i) => i !== index))}>Remove cue</button>
    </details>
  {/each}
  <button onclick={add}>Add cue</button>
</section>
<style>
  details { padding: 8px; border: 1px solid #425670; border-radius: 6px; margin-block: 8px; }
  label { display: block; margin-block: 8px; } input, select { display: block; width: 100%; box-sizing: border-box; }
  pre { white-space: pre-wrap; font-size: 12px; max-height: 250px; overflow: auto; }
</style>
