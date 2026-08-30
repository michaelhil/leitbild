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

  const objectIdentifier = (candidate: unknown): string | null => {
    if (!isObject(candidate)) return null
    const identifier = candidate.id
    return typeof identifier === 'string' || typeof identifier === 'number'
      ? String(identifier)
      : null
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

  const immediateChildBranches = (branch: HTMLDetailsElement): ReadonlyArray<HTMLDetailsElement> => {
    const children = branch.querySelector<HTMLElement>(':scope > .json-children')
    if (!children) return []
    return Array.from(children.children).filter(
      (child): child is HTMLDetailsElement => child instanceof HTMLDetailsElement && child.classList.contains('json-branch'),
    )
  }

  const cycleBranch = (event: MouseEvent): void => {
    event.preventDefault()
    const summary = event.currentTarget as HTMLElement
    const branch = summary.parentElement
    if (!(branch instanceof HTMLDetailsElement)) return

    const childBranches = immediateChildBranches(branch)
    if (!branch.open) {
      branch.open = true
      for (const child of childBranches) child.open = true
      return
    }

    const allChildrenOpen = childBranches.length > 0 && childBranches.every(child => child.open)
    if (allChildrenOpen) {
      for (const child of childBranches) child.open = false
      return
    }

    branch.open = false
  }

  const rootEntries = $derived(entries(value))
</script>

{#snippet node(candidate: unknown, key: string, arrayItem: boolean)}
  {@const children = entries(candidate)}
  {@const identifier = objectIdentifier(candidate)}
  {#if children.length > 0}
    <details class="json-branch" open>
      <summary onclick={cycleBranch}>
        <span class:json-index={arrayItem} class:json-key={!arrayItem}>{arrayItem ? `[${key}]` : JSON.stringify(key)}</span><span class="json-punctuation">:</span>
        <span class="json-collection">{collectionLabel(candidate)}</span>
        {#if identifier !== null}<span class="json-object-id" title={identifier}>// {identifier}</span>{/if}
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
