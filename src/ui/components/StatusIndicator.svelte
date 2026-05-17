<script lang="ts">
  import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-svelte'
  import type { PackObjectStatusIndicator, PackObjectStatusTone } from '../../core/packs/protocol.ts'
  import StatusDot from './StatusDot.svelte'

  export let tone: PackObjectStatusTone
  export let label: string
  export let indicator: PackObjectStatusIndicator

  const arrowIcon = () => {
    if (indicator.direction === 'left') return ArrowLeft
    if (indicator.direction === 'up') return ArrowUp
    if (indicator.direction === 'down') return ArrowDown
    return ArrowRight
  }
</script>

{#if indicator.shape === 'arrow'}
  <span
    class="status-indicator arrow"
    class:pulse={indicator.pulse === true}
    data-tone={tone}
    title={label}
    aria-label={label}
    role="status"
  >
    <svelte:component this={arrowIcon()} size={15} strokeWidth={2.4} />
  </span>
{:else}
  <span class="status-indicator dot" class:pulse={indicator.pulse === true}>
    <StatusDot {tone} {label} />
    {#if indicator.innerTone}
      <span class="status-inner-dot" data-tone={indicator.innerTone}></span>
    {/if}
  </span>
{/if}
