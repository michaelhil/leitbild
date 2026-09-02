<script lang="ts">
  import type { AuthoringField } from './scenario-builder-model.ts'
  import { valueAtPath } from './scenario-builder-model.ts'
  let { fields, targetFor, onchange }: {
    fields: ReadonlyArray<AuthoringField>
    targetFor: (field: AuthoringField) => Record<string, unknown> | undefined
    onchange: (field: AuthoringField, value: unknown) => void
  } = $props()
</script>

{#each fields as field (`${field.target}:${field.path.join('.')}`)}
  {@const target = targetFor(field)}
  {#if target}
    <label>{field.label}
      {#if field.control.kind === 'select'}
        <select value={String(valueAtPath(target, field.path) ?? field.control.defaultValue)} onchange={event => onchange(field,event.currentTarget.value)}>
          {#each field.control.options as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
        </select>
      {:else if field.control.kind === 'boolean'}
        <input type="checkbox" checked={Boolean(valueAtPath(target,field.path)??field.control.defaultValue)} onchange={event=>onchange(field,event.currentTarget.checked)} />
      {:else if field.control.kind === 'number'}
        <input type="number" value={Number(valueAtPath(target,field.path)??field.control.defaultValue)} min={field.control.min} max={field.control.max} step={field.control.step} onchange={event=>{if(Number.isFinite(event.currentTarget.valueAsNumber))onchange(field,event.currentTarget.valueAsNumber)}} />
      {:else}
        <input value={String(valueAtPath(target,field.path)??field.control.defaultValue)} oninput={event=>onchange(field,event.currentTarget.value)} />
      {/if}
    </label>
  {/if}
{/each}
