<script lang="ts">
  import { runOnMount } from '../../../ui/svelte-lifecycle.svelte.ts'
  import type { ExternalRecord } from '../model.ts'
  const { media }: { media: NonNullable<ExternalRecord['media']> } = $props()
  let requested = $state(false)
  let video = $state<HTMLVideoElement | null>(null)
  let error = $state('')
  function youtubeEmbed(url: string): string | null {
    const parsed = new URL(url)
    const id = parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : ['www.youtube.com', 'youtube.com'].includes(parsed.hostname) ? parsed.searchParams.get('v') ?? parsed.pathname.match(/^\/(?:embed|live|shorts)\/([^/]+)/)?.[1] : null
    return id && /^[\w-]{11}$/.test(id) ? 'https://www.youtube-nocookie.com/embed/' + id : null
  }
  $effect(() => {
    const element = video
    if (!requested || !element || media.format !== 'hls') return
    let active = true, destroy: (() => void) | undefined
    error = ''
    if (element.canPlayType('application/vnd.apple.mpegurl')) element.src = media.url
    else void import('hls.js').then(({ default: Hls }) => {
      if (!active) return
      if (!Hls.isSupported()) { error = 'HLS playback is not supported by this browser'; return }
      const player = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 30, backBufferLength: 0 })
      destroy = () => player.destroy()
      player.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) { error = 'Stream could not be played: ' + data.details; player.destroy() } })
      player.loadSource(media.url); player.attachMedia(element)
    }).catch(cause => { if (active) error = String(cause) })
    return () => { active = false; destroy?.(); element.removeAttribute('src'); element.load() }
  })
</script>
{#if !requested}<button onclick={() => requested = true}>Load media from provider</button><p>Playback contacts the provider directly. Availability, embedding permission and browser CORS rules apply.</p>
{:else if media.format === 'youtube'}
  {@const url = youtubeEmbed(media.url)}
  {#if url}<iframe title="External video" src={url} sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe>{:else}<p role="alert">Use a YouTube video, live or short URL with a video ID.</p>{/if}
{:else if media.format === 'audio'}<audio controls preload="none" src={media.url} onerror={() => error = 'Audio could not be loaded from the provider'}></audio>
{:else}
  <!-- Provider media has no locally supplied caption track. Native tracks, when supplied by the stream, remain available. -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} controls playsinline preload="none" src={media.format === 'video' ? media.url : undefined} onerror={() => error = 'Video could not be loaded from the provider'}></video>
{/if}
{#if requested}<button onclick={() => requested = false}>Unload media</button>{/if}
{#if error}<p role="alert">{error}</p>{/if}
<style>video,audio,iframe{width:100%;border:0}video,iframe{aspect-ratio:16/9;background:#000}p{font-size:12px;color:#94a3b8}[role=alert]{color:#f87171}button{padding:7px;color:inherit;background:transparent;border:1px solid #64748b;border-radius:5px}</style>
