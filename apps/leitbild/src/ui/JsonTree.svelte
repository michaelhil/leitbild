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

  const updateChildToggle = (branch: HTMLDetailsElement): void => {
    const control = branch.querySelector<HTMLButtonElement>(':scope > summary > .json-children-toggle')
    if (!control) return
    const childBranches = immediateChildBranches(branch)
    const allOpen = childBranches.every(child => child.open)
    const action = allOpen ? 'Collapse' : 'Expand'
    control.textContent = allOpen ? '▲' : '▼'
    control.title = `${action} immediate child collections`
    control.setAttribute('aria-label', `${action} immediate child collections`)
  }

  const syncParentChildToggle = (event: Event): void => {
    const branch = event.currentTarget as HTMLDetailsElement
    const parentBranch = branch.parentElement?.closest<HTMLDetailsElement>('.json-branch')
    if (parentBranch) updateChildToggle(parentBranch)
  }

  const toggleImmediateChildren = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const control = event.currentTarget as HTMLButtonElement
    const branch = control.closest<HTMLDetailsElement>('.json-branch')
    if (!branch) return
    const childBranches = immediateChildBranches(branch)
    const open = childBranches.some(child => !child.open)
    for (const child of childBranches) child.open = open
    updateChildToggle(branch)
  }

  const rootEntries = $derived(entries(value))
</script>

{#snippet node(candidate: unknown, key: string, arrayItem: boolean)}
  {@const children = entries(candidate)}
  {@const identifier = objectIdentifier(candidate)}
  {@const hasChildBranches = children.some(([, child]) => entries(child).length > 0)}
  {#if children.length > 0}
    <details class="json-branch" open ontoggle={syncParentChildToggle}>
      <summary>
        <span class:json-index={arrayItem} class:json-key={!arrayItem}>{arrayItem ? `[${key}]` : JSON.stringify(key)}</span><span class="json-punctuation">:</span>
        <span class="json-collection">{collectionLabel(candidate)}</span>
        {#if identifier !== null}<span class="json-object-id" title={identifier}>// {identifier}</span>{/if}
        {#if hasChildBranches}<button class="json-children-toggle" type="button" title="Collapse immediate child collections" aria-label="Collapse immediate child collections" onclick={toggleImmediateChildren}>▲</button>{/if}
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
