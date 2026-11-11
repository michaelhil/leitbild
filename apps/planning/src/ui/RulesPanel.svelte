<script lang="ts">
  import type { Edit } from '../plan/edit-schema.ts'
  import MarkTag from './MarkTag.svelte'
  import RuleForm from './RuleForm.svelte'
  import { ruleView, settingViews } from './rules-text.ts'
  import { goalOrderText, type Context } from './status-text.ts'

  // Hard rules in words with their kind and source; the window and one-at-a-time crews as settings;
  // the goals as an ordered policy. Rules are never offered as a trade.
  let { context, busy = false, onPreview }: { context: Context; busy?: boolean; onPreview: (edits: readonly Edit[], label: string) => void } = $props()
  const rules = $derived(context.inputs.rules.map(rule => ruleView(rule, context)))
  const settings = $derived(settingViews(context))
  const goals = $derived(goalOrderText(context.inputs.goals, context))
  const sourceTone = (shape: string) => shape === '△' ? 'assumption' : shape === '◉' ? 'world' : 'plain'
</script>

<section class="rules" aria-labelledby="rules-title">
  <h2 id="rules-title">Rules</h2>
  <p class="hint">Hard rules always hold. Generate never trades them against goals; changing or removing one needs someone's agreement.</p>
  {#if rules.length === 0}<p class="hint">No rules yet.</p>{/if}
  <ul class="rule-list">
    {#each rules as rule (rule.key)}
      <li>
        <p><MarkTag mark={rule.mark} tone="rule" /> <strong>{rule.kind}.</strong> {rule.words}</p>
        <p class="hint">{rule.covers}</p>
        <p class="hint"><MarkTag mark={rule.source.mark} tone={sourceTone(rule.source.mark.shape)} />{rule.source.note ? ` ${rule.source.note}` : ''}</p>
        <button type="button" class="quiet" disabled={busy} onclick={() => onPreview([{ edit: 'remove', what: 'rule', key: rule.key }], `Remove the rule “${rule.words}”`)}>Remove…</button>
      </li>
    {/each}
  </ul>
  <h3>Settings</h3>
  <ul class="rule-list">
    {#each settings as setting, index (index)}<li><MarkTag mark={setting.mark} /> <strong>{setting.name}:</strong> {setting.text}</li>{/each}
  </ul>
  <h3>Goals, in order</h3>
  <ol class="goal-order">{#each goals as goal (goal)}<li>{goal.replace(/^\d+\. /, '')}</li>{/each}</ol>
  <RuleForm {context} {busy} {onPreview} />
</section>
