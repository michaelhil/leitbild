<script lang="ts">
  import MarkTag from './MarkTag.svelte'
  import type { Glance } from './orientation.ts'

  // What this plan is about, on the first screen: limits, protected items with their World state at read
  // time, preconditions, orders, crews and promises.
  let { sections }: { sections: readonly Glance[] } = $props()
  const tone = (shape: string) => shape === '■' ? 'rule' : shape === '△' ? 'assumption' : shape === '?' ? 'unknown' : shape === '◉' ? 'world' : 'plain'
</script>

<section class="glance" aria-labelledby="glance-title">
  <h2 id="glance-title">This plan at a glance</h2>
  {#each sections as section (section.title)}
    <h3>{section.title}</h3>
    <ul>
      {#each section.lines as line, index (index)}
        <li>
          {#if line.mark}<MarkTag mark={line.mark} tone={tone(line.mark.shape)} />{/if} {line.text}
          {#each line.world as world (world)}<small><MarkTag mark={{ shape: '◉', word: 'World' }} tone="world" /> {world}</small>{/each}
        </li>
      {/each}
    </ul>
  {/each}
</section>
