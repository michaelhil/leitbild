<script lang="ts">
  import type { Edit } from '../plan/edit-schema.ts'
  import type { Weekday } from '../time/zone.ts'
  import { crewEdits, purchaseAllowedEdit, type CrewForm } from './edit-forms.ts'
  import { moneyText, sourceMark } from './format.ts'
  import MarkTag from './MarkTag.svelte'
  import { attributeViews, calendarText, orderView, resourceHoursText, resourceText } from './rules-text.ts'
  import type { Context } from './status-text.ts'

  // Crews and tools with their shift calendars and what can be bought; a new crew comes with its shift.
  let { context, busy = false, onPreview }: { context: Context; busy?: boolean; onPreview: (edits: readonly Edit[], label: string) => void } = $props()

  const days: ReadonlyArray<{ key: Weekday; word: string }> = [
    { key: 'mon', word: 'Mon' }, { key: 'tue', word: 'Tue' }, { key: 'wed', word: 'Wed' }, { key: 'thu', word: 'Thu' },
    { key: 'fri', word: 'Fri' }, { key: 'sat', word: 'Sat' }, { key: 'sun', word: 'Sun' },
  ]
  let label = $state('')
  let kind = $state<CrewForm['kind']>('crew')
  let count = $state('1')
  let crewSize = $state('')
  let calendar = $state('')
  let chosen = $state<Weekday[]>(['mon', 'tue', 'wed', 'thu', 'fri'])
  let from = $state('07:00')
  let to = $state('15:00')
  let sourceBy = $state<CrewForm['sourceBy']>('planner')
  let sourceNote = $state('')
  let problems = $state<readonly string[]>([])

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const built = crewEdits({ label, kind, count, crewSize, calendar, days: chosen, from, to, sourceBy, sourceNote }, context.inputs)
    if (!built.ok) { problems = built.problems; return }
    problems = []
    onPreview(built.edits, `Add ${label.trim()}`)
  }
  const markTone = (shape: string) => shape === '△' ? 'assumption' : shape === '◉' ? 'world' : shape === '?' ? 'unknown' : 'plain'
  const price = (purchase: Context['inputs']['purchases'][number]) => {
    const currency = context.inputs.settings.currency
    return [
      purchase.price.perPersonHour === undefined ? null : `${moneyText(purchase.price.perPersonHour, currency)} per person-hour`,
      purchase.price.perPeriodUsed === undefined ? null : `${moneyText(purchase.price.perPeriodUsed, currency)} per period used`,
      purchase.price.once === undefined ? null : `${moneyText(purchase.price.once, currency)} once`,
    ].filter(part => part !== null).join(' + ')
  }
</script>

<section class="crews" aria-labelledby="crews-title">
  <h2 id="crews-title">Crews, tools and shifts</h2>
  {#if context.inputs.resources.length === 0}<p class="hint">No crews or tools yet.</p>{/if}
  <ul class="item-list">
    {#each context.inputs.resources as resource (resource.key)}
      <li>
        <strong>{resource.label}</strong> <MarkTag mark={sourceMark(resource.source)} tone={markTone(sourceMark(resource.source).shape)} />
        <small>{resourceText(resource, context.names)}</small>
        <small>Works {resourceHoursText(resource, context.inputs, context.format)}</small>
        {#if resource.words}<small>{resource.words}</small>{/if}
        {#if resource.source.note}<small>{resource.source.note}</small>{/if}
        {#each attributeViews(resource, context.inputs.world.facts, context.format) as attribute, index (index)}
          <small><MarkTag mark={attribute.mark} tone={markTone(attribute.mark.shape)} /> {attribute.text}{attribute.source ? ` (${attribute.source})` : ''}</small>
        {/each}
      </li>
    {/each}
  </ul>

  <h3>Shifts</h3>
  <ul class="item-list">
    {#each context.inputs.calendars as item (item.key)}
      <li><strong>{item.label}</strong> <MarkTag mark={sourceMark(item.source)} tone={markTone(sourceMark(item.source).shape)} /><small>{calendarText(item, context.format)}</small>{#if item.source.note}<small>{item.source.note}</small>{/if}</li>
    {/each}
  </ul>

  {#if context.inputs.purchases.length > 0}
    <h3>What can be bought</h3>
    <ul class="item-list">
      {#each context.inputs.purchases as purchase (purchase.key)}
        <li>
          <strong>{purchase.label}</strong> <small>{price(purchase)}</small>
          {#if orderView(purchase, context.inputs, context.format)}
            {@const order = orderView(purchase, context.inputs, context.format)!}
            <small><MarkTag mark={order.mark} tone={order.mark.shape === '!' ? 'warning' : 'plain'} /> {order.text}</small>
          {/if}
          {#if purchase.replaces.length > 0}<small>Gives up the booked time it replaces.</small>{/if}
          <small>{purchase.allowed ? 'Generate may buy it.' : 'Generate may not buy it.'}</small>
          <button type="button" class="quiet" disabled={busy} onclick={() => {
            const built = purchaseAllowedEdit(purchase.key, !purchase.allowed)
            if (built.ok) onPreview(built.edits, `${purchase.allowed ? 'Do not allow' : 'Allow'} “${purchase.label}”`)
          }}>{purchase.allowed ? 'Do not allow it' : 'Allow it'}</button>
        </li>
      {/each}
    </ul>
  {/if}

  <form class="mini-form" onsubmit={submit}>
    <h3>Add a crew or tool</h3>
    <label>Name<input bind:value={label} placeholder="e.g. Day crew" /></label>
    <div class="field-pair">
      <label>It is a<select bind:value={kind}><option value="crew">crew</option><option value="tool">tool or vehicle</option></select></label>
      <label>How many<input inputmode="numeric" bind:value={count} /></label>
    </div>
    {#if kind === 'crew'}<label>People per crew (for prices per person-hour)<input inputmode="numeric" bind:value={crewSize} /></label>{/if}
    <label>Works on
      <select bind:value={calendar}><option value="">a new weekly shift</option>{#each context.inputs.calendars as item (item.key)}<option value={item.key}>{item.label}</option>{/each}</select>
    </label>
    {#if calendar === ''}
      <fieldset><legend>Working days</legend>
        {#each days as day (day.key)}<label class="inline"><input type="checkbox" checked={chosen.includes(day.key)} onchange={() => { chosen = chosen.includes(day.key) ? chosen.filter(item => item !== day.key) : [...chosen, day.key] }} /> {day.word}</label>{/each}
      </fieldset>
      <div class="field-pair">
        <label>From<input type="time" bind:value={from} /></label>
        <label>To<input type="time" bind:value={to} /></label>
      </div>
      <p class="hint">A shift that ends at or before it starts ends the next day.</p>
    {/if}
    <label>Who says so
      <select bind:value={sourceBy}><option value="planner">My own</option><option value="assumption">Assumption, not yet confirmed</option><option value="reference">From a reference</option></select>
    </label>
    <label>Where it comes from<input bind:value={sourceNote} /></label>
    <button type="submit" disabled={busy}>Preview</button>
    {#if problems.length > 0}<ul class="problems">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>{/if}
  </form>
</section>
