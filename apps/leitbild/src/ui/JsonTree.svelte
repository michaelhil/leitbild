<script lang="ts">
  interface Props {
    readonly value: unknown
  }

  let { value }: Props = $props()

  const isObject = (candidate: unknown): candidate is Readonly<Record<string, unknown>> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)

  const entries = (candidate: unknown): ReadonlyArray<readonly [string, unknown]> => {
    if (Array.isArray(candidate)) return candidate.map((item, index) => [String(index), item] as const)
    if (isObject(candidate)) return Object.entries(candidate)
    return []
  }

  const collectionLabel = (candidate: unknown): string => {
    const count = entries(candidate).length
    return Array.isArray(candidate) ? `Array(${count})` : `Object(${count})`
  }

  const primitiveClass = (candidate: unknown): string => {
    if (candidate === null) return 'null'
    return typeof candidate
  }

  const formatPrimitive = (candidate: unknown): string => {
    if (candidate === undefined) return 'undefined'
    if (typeof candidate === 'bigint') return `${candidate}n`
    const serialized = JSON.stringify(candidate)
    return serialized ?? String(candidate)
  }

  const rootEntries = $derived(entries(value))
</script>

{#snippet node(candidate: unknown, key: string, arrayItem: boolean)}
  {@const children = entries(candidate)}
  {#if children.length > 0}
    <details class="json-branch" open>
      <summary>
        <span class:json-index={arrayItem} class:json-key={!arrayItem}>{arrayItem ? `[${key}]` : JSON.stringify(key)}</span><span class="json-punctuation">:</span>
        <span class="json-collection">{collectionLabel(candidate)}</span>
      </summary>
      <div class="json-children">
        {#each children as [childKey, child] (childKey)}
          {@render node(child, childKey, Array.isArray(candidate))}
        {/each}
      </div>
    </details>
  {:else}
    <div class="json-leaf">
      <span class:json-index={arrayItem} class:json-key={!arrayItem}>{arrayItem ? `[${key}]` : JSON.stringify(key)}</span><span class="json-punctuation">:</span>
      <span class={`json-value json-${primitiveClass(candidate)}`}>{Array.isArray(candidate) ? '[]' : isObject(candidate) ? '{}' : formatPrimitive(candidate)}</span>
    </div>
  {/if}
{/snippet}

<div class="json-tree">
  {#if rootEntries.length > 0}
    {#each rootEntries as [key, child] (key)}
      {@render node(child, key, Array.isArray(value))}
    {/each}
  {:else}
    <span class={`json-value json-${primitiveClass(value)}`}>{Array.isArray(value) ? '[]' : isObject(value) ? '{}' : formatPrimitive(value)}</span>
  {/if}
</div>
