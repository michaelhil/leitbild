<script module lang="ts">
  export type StatusTone = 'ready' | 'working' | 'error' | 'idle'
</script>

<script lang="ts">
  interface Props {
    readonly tone: StatusTone
    readonly label: string
  }

  let { tone, label }: Props = $props()
</script>

<span
  class="status-dot"
  class:ready={tone === 'ready'}
  class:working={tone === 'working'}
  class:error={tone === 'error'}
  class:idle={tone === 'idle'}
  data-tone={tone}
  title={label}
  aria-label={label}
  role="status"
></span>
