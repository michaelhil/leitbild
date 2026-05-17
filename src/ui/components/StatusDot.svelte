<script lang="ts" context="module">
  export type StatusTone = 'ready' | 'working' | 'error' | 'idle'
</script>

<script lang="ts">
  export let tone: StatusTone
  export let label: string
</script>

<span
  class="status-dot"
  class:ready={tone === 'ready'}
  class:working={tone === 'working'}
  class:error={tone === 'error'}
  class:idle={tone === 'idle'}
  title={label}
  aria-label={label}
  role="status"
></span>
