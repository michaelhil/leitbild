<script lang="ts">
  import type { JobBar, TimelineLayout } from './timeline-layout.ts'

  // Availability per function group (limit ▲ and guideline ◇ marks) with, under it, one row per equipment
  // item: its outage as a band and the jobs on it as bars. Then a row for each job on no equipment, and
  // the load per crew or tool with its off-shift time hatched. Every bar has its words for screen readers.
  let { layout, selected = null, onSelect }: { layout: TimelineLayout; selected?: string | null; onSelect: (job: string) => void } = $props()
  const style = (bar: { left: number; width: number }) => `left:${bar.left}%;width:${Math.max(bar.width, 0.4)}%`
  const label = (bar: JobBar) => `${bar.mark.word}: ${bar.text}${bar.locked ? ', start fixed' : ''}${bar.who ? `, ${bar.who}` : ''}`
  const levelHeight = 18
</script>

<div class="timeline" role="group" aria-label="Timeline">
  <div class="axis" aria-hidden="true">
    <span class="lane-label"></span>
    <span class="track">
      {#each layout.ticks as tick, index (index)}<span class="tick" style="left:{tick.left}%">{tick.label}</span>{/each}
      {#if layout.now}<span class="now" style="left:{layout.now.left}%">{layout.now.label}</span>{/if}
    </span>
  </div>

  {#if layout.availability.length > 0}
    <h3 class="lane-heading">Availability and jobs <small class="key" aria-hidden="true">◧ tag-out · ▬ work · ◆ test · ▲ limit · ◇ guideline</small></h3>
    {#each layout.availability as lane, laneIndex (laneIndex)}
      <p class="group-head"><strong>{lane.group}</strong> <span class="lane-summary">{lane.summary}</span></p>
      <div class="lane group-lane" class:breaks={lane.breaks !== null}>
        <span class="lane-label">First tag-out to last test</span>
        <span class="track">
          {#if lane.span}<span class="span-bar" class:over={lane.breaks === 'limit'} style={style(lane.span)} title={lane.span.text}><span class="sr-only">{lane.span.text}</span></span>{/if}
          {#if lane.span && lane.guidelineAt !== null}<span class="limit guideline" style="left:{lane.guidelineAt}%" title="Guideline"><span aria-hidden="true">◇</span><span class="sr-only">Guideline ends here</span></span>{/if}
          {#if lane.span && lane.limitAt !== null}<span class="limit hard" style="left:{lane.limitAt}%" title="Limit"><span aria-hidden="true">▲</span><span class="sr-only">Limit ends here</span></span>{/if}
        </span>
      </div>
      {#each lane.items as item, itemIndex (itemIndex)}
        <div class="lane item-lane" class:selected={item.jobs.some(bar => bar.key === selected)}>
          <span class="lane-label">{item.label}</span>
          <span class="track" style="height:{item.levels * levelHeight + 6}px">
            {#each item.segments as segment, index (index)}<span class="out-bar" style={style(segment)} title={segment.text}><span class="sr-only">{segment.text}</span></span>{/each}
            {#if item.segments.length === 0 && item.jobs.length === 0}<span class="sr-only">In service</span>{/if}
            {#each item.jobs as bar (bar.key)}
              <button type="button" class="job-bar kind-{bar.mark.word.toLowerCase()}" class:locked={bar.locked} class:current={bar.key === selected} style="{style(bar)};top:{3 + bar.level * levelHeight}px" title={bar.text} onclick={() => onSelect(bar.key)} aria-label={label(bar)}></button>
            {/each}
          </span>
        </div>
      {/each}
    {/each}
  {/if}

  {#if layout.otherJobs.length > 0}
    <h3 class="lane-heading">{layout.availability.length > 0 ? 'Other jobs' : 'Jobs'}</h3>
    {#each layout.otherJobs as bar (bar.key)}
      <div class="lane job-lane" class:selected={bar.key === selected}>
        <span class="lane-label"><span aria-hidden="true">{bar.mark.shape}</span> {bar.title}</span>
        <span class="track">
          <button type="button" class="job-bar kind-{bar.mark.word.toLowerCase()}" class:locked={bar.locked} class:current={bar.key === selected} style={style(bar)} title={bar.text} onclick={() => onSelect(bar.key)} aria-label={label(bar)}></button>
        </span>
      </div>
    {/each}
  {/if}

  <h3 class="lane-heading">Crews and tools</h3>
  {#each layout.loads as lane, laneIndex (laneIndex)}
    <div class="lane load-lane">
      <span class="lane-label"><strong>{lane.label}</strong><small>{lane.capacity} · {lane.summary}</small></span>
      <span class="track">
        {#each lane.offShift as gap, index (index)}<span class="off-shift" style={style(gap)}></span>{/each}
        {#each lane.segments as segment, index (index)}
          <span class="load-bar" class:over={segment.over} class:bought={segment.bought} style={style(segment)} title={segment.text}>{segment.count > 1 ? segment.count : ''}<span class="sr-only">{segment.text}</span></span>
        {/each}
      </span>
    </div>
  {/each}
</div>
