<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { marked, Renderer } from 'marked'
  import { markdownBody } from '@leitbild/knowledge/markdown'

  interface Heading { title: string; line: number; level: number; anchor: string }
  interface Entry { path: string; title: string; summary: string; headings: Heading[] }
  interface Document { path: string; title: string; revision: string; content: string; headings: Heading[] }
  let entries = $state<Entry[]>([])
  let matches = $state<{ path: string; title: string; snippet: string }[] | null>(null)
  let document = $state<Document | null>(null)
  let query = $state('')
  let error = $state('')
  let loading = $state(false)
  let html = $state('')
  let sourceBaseUrl = $state<string | undefined>(undefined)
  const groups = $derived([...new Set(entries.map(entry => entry.path.includes('/') ? entry.path.split('/')[0]! : 'Start'))])
  let requestId = 0
  const revisionSelector = new URLSearchParams(location.search).get('revision')
  const pageUrl = (path: string): string => `/wiki?path=${encodeURIComponent(path)}${revisionSelector ? `&revision=${encodeURIComponent(revisionSelector)}` : ''}`
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  const wikiLink = (href: string, current: string): string | null => {
    if (/^https?:\/\//i.test(href)) return href
    if (href.startsWith('source:')) return sourceBaseUrl ? `${sourceBaseUrl}${href.slice(7)}` : null
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null
    const target = new URL(href, `https://wiki.invalid/${current}`)
    return `${pageUrl(decodeURIComponent(target.pathname.slice(1)))}${target.hash}`
  }
  const render = (value: Document): string => {
    const renderer = new Renderer()
    const blocks = marked.lexer(markdownBody(value.content))
    const anchors = new WeakMap<object, string>()
    let headingIndex = 0
    for (const block of blocks) if (block.type === 'heading') anchors.set(block, value.headings[headingIndex++]!.anchor)
    renderer.html = ({ text }) => escape(text)
    renderer.heading = (token) => {
      // Document sections are top-level headings; quoted/list-contained headings
      // remain readable content and do not consume the document navigation index.
      const anchor = anchors.get(token)
      return `<h${token.depth}${anchor === undefined ? '' : ` id="${escape(anchor)}"`}>${renderer.parser.parseInline(token.tokens)}</h${token.depth}>`
    }
    renderer.link = ({ href, tokens }) => {
      const target = wikiLink(href, value.path)
      return target ? `<a href="${escape(target)}">${renderer.parser.parseInline(tokens)}</a>` : renderer.parser.parseInline(tokens)
    }
    renderer.image = ({ text }) => escape(text)
    return marked.parser(blocks, { renderer })
  }
  const get = async <T,>(url: string): Promise<T> => {
    const response = await fetch(url)
    const body = await response.json()
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Wiki request failed')
    return body as T
  }
  const open = async (path: string): Promise<void> => {
    const id = ++requestId
    loading = true; error = ''
    try {
      const revision = new URLSearchParams(location.search).get('revision')
      const value = await get<Document>(`/api/knowledge/read?path=${encodeURIComponent(path)}${revision ? `&revision=${encodeURIComponent(revision)}` : ''}`)
      if (id !== requestId) return
      document = value; html = render(value)
      await tick()
      if (location.hash) window.document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView()
    } catch (cause) { if (id === requestId) error = cause instanceof Error ? cause.message : String(cause) }
    finally { if (id === requestId) loading = false }
  }
  const search = async (): Promise<void> => {
    error = ''
    try { matches = query.trim() ? (await get<{ matches: NonNullable<typeof matches> }>(`/api/knowledge/search?query=${encodeURIComponent(query)}`)).matches : null }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
  }
  const reportIssue = (): void => {
    if (!document || !sourceBaseUrl) return
    const url = new URL(`${sourceBaseUrl.split('/blob/')[0]}/issues/new`)
    url.searchParams.set('title', `Wiki feedback: ${document.title}`)
    url.searchParams.set('body', `Document: ${document.path}\nKnowledge revision: ${document.revision}\nSection: ${location.hash || '(page)'}\n\nSelected text:\n${window.getSelection()?.toString() ?? ''}\n\nComment:\n`)
    window.open(url.href, '_blank', 'noopener')
  }
  onMount(() => {
    void get<{ documents: Entry[]; sourceBaseUrl?: string }>('/api/knowledge/index').then(async value => {
      entries = value.documents; sourceBaseUrl = value.sourceBaseUrl
      await open(new URLSearchParams(location.search).get('path') ?? 'index.md')
    }).catch(cause => { error = String(cause) })
  })
</script>

<svelte:head><title>{document?.title ?? 'Wiki'} · Leitbild</title></svelte:head>
<header class="wiki-header"><a href="/">Leitbild</a><span>Knowledge wiki</span></header>
<div class="wiki-layout">
  <aside>
    <form onsubmit={(event) => { event.preventDefault(); void search() }}>
      <input aria-label="Search wiki" bind:value={query} placeholder="Search knowledge…" /><button type="submit">Search</button>
    </form>
    <nav aria-label="Wiki pages">
      {#if matches !== null}
        {#each matches as entry}<a href={pageUrl(entry.path)}><strong>{entry.title}</strong><small>{entry.snippet}</small></a>{/each}
        {#if matches.length === 0}<p>No matching documents.</p>{/if}
      {:else}
        {#each groups as group}
          <details open={group === 'Start' || document?.path.startsWith(`${group}/`)}><summary>{group}</summary>
            {#each entries.filter(entry => (entry.path.includes('/') ? entry.path.split('/')[0] : 'Start') === group) as entry}
              <a class:selected={document?.path === entry.path} href={pageUrl(entry.path)}><strong>{entry.title}</strong><small>{entry.path}</small></a>
            {/each}
          </details>
        {/each}
      {/if}
    </nav>
  </aside>
  <main>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if loading}<p role="status">Loading document…</p>{/if}
    {#if document}
      <div class="provenance">Knowledge revision {document.revision.slice(0, 12)} · Reference material, not live state</div>
      {#if sourceBaseUrl}<button onclick={reportIssue}>Comment / report an issue</button>{/if}
      {#if !sourceBaseUrl}<p class="provenance">Immutable code links are unavailable for this local or uncommitted deployment. Inspect deployed source through the Assistant instead.</p>{/if}
      <article>{@html html}</article>
      <details><summary>On this page</summary>{#each document.headings as heading}<a class="heading-link" href={`#${heading.anchor}`}>{heading.title}</a>{/each}</details>
    {/if}
  </main>
</div>

<style>
  .wiki-header{display:flex;gap:1.2rem;padding:1rem 2rem;background:#17291e;color:#fff}.wiki-header a{color:inherit;font-weight:700;text-decoration:none}
  .wiki-layout{display:grid;grid-template-columns:minmax(220px,290px) minmax(0,1fr);max-width:1440px;margin:auto;min-height:90vh}
  aside{padding:1.2rem;border-right:1px solid #cdd6cd}form{display:flex;gap:.3rem}input{min-width:0;width:100%;padding:.6rem}button{padding:.5rem}
  nav{display:grid;gap:.3rem;margin-top:1rem}nav a{display:block;padding:.55rem;text-decoration:none;color:inherit;border-radius:.3rem}nav a:hover,.selected{background:#dce9df}small{display:block;color:#536759;font-size:.7rem;overflow-wrap:anywhere}
  main{padding:2rem;min-width:0}.provenance{font-size:.8rem;color:#526657}article{line-height:1.7;max-width:900px}article :global(pre){overflow:auto;padding:1rem;background:#e3e9e4}article :global(table){border-collapse:collapse}article :global(td),article :global(th){padding:.4rem;border:1px solid #b6c4b9}article :global(a){color:#245cb0}article :global(code){overflow-wrap:anywhere}.heading-link{display:block;padding:.25rem}
  @media(max-width:700px){.wiki-layout{display:block}aside{border-right:none;border-bottom:1px solid #cdd6cd}nav{max-height:180px;overflow:auto}main{padding:1rem}}
</style>
