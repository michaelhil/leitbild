import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import tools from './web.ts'

const ctx = { callerId: 'test-id', callerName: 'TestAgent' }

const toolMap = Object.fromEntries(tools.map(t => [t.name, t]))

describe('web_search', () => {
  let savedBrave: string | undefined
  let savedSerper: string | undefined

  beforeAll(() => {
    savedBrave = process.env.BRAVE_API_KEY
    savedSerper = process.env.SERPER_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.SERPER_API_KEY
  })

  afterAll(() => {
    if (savedBrave !== undefined) {
      process.env.BRAVE_API_KEY = savedBrave
    }
    if (savedSerper !== undefined) {
      process.env.SERPER_API_KEY = savedSerper
    }
  })

  test('returns error when no API key is set', async () => {
    const webSearch = toolMap['web_search']
    expect(webSearch).toBeDefined()
    const result = await webSearch!.execute({ query: 'test query' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('BRAVE_API_KEY')
    expect(result.error).toContain('SERPER_API_KEY')
  })

  test('returns error for missing query parameter', async () => {
    const webSearch = toolMap['web_search']
    const result = await webSearch!.execute({}, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('fetch_url', () => {
  // Exercise the real HTTP reader without depending on a public site's latency.
  let server: ReturnType<typeof Bun.serve>
  let url: string

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/unavailable') {
          return new Response('Unavailable', { status: 503, statusText: 'Service Unavailable' })
        }
        return new Response('<html><head><title>Reader example</title><style>hidden-style</style></head><body><h1>Example</h1><p>Readable content.</p><script>hidden-script</script></body></html>', {
          headers: { 'Content-Type': 'text/html' },
        })
      },
    })
    url = new URL('/page', server.url).href
  })

  afterAll(() => { server.stop(true) })

  test('fetches a page and returns its title and text content', async () => {
    const fetchUrl = toolMap['fetch_url']
    expect(fetchUrl).toBeDefined()

    const result = await fetchUrl!.execute({ url }, ctx)
    expect(result.success).toBe(true)

    const data = result.data as { title: string; text: string; url: string; chars: number }
    expect(data.title).toBe('Reader example')
    expect(data.text).toBe('Reader example Example Readable content.')
    expect(data.url).toBe(url)
    expect(typeof data.chars).toBe('number')
    expect(data.chars).toBeGreaterThan(0)
    expect(data.chars).toBe(data.text.length)
  })

  test('returns error for missing url parameter', async () => {
    const fetchUrl = toolMap['fetch_url']
    const result = await fetchUrl!.execute({}, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('strips HTML tags from fetched content', async () => {
    const fetchUrl = toolMap['fetch_url']
    const result = await fetchUrl!.execute({ url }, ctx)
    expect(result.success).toBe(true)
    const data = result.data as { text: string }
    // Should not contain any HTML tags
    expect(data.text).not.toMatch(/<[^>]+>/)
    expect(data.text).not.toContain('hidden-style')
    expect(data.text).not.toContain('hidden-script')
  })

  test('reports unsuccessful HTTP responses rather than treating them as content', async () => {
    const result = await toolMap['fetch_url']!.execute({ url: new URL('/unavailable', server.url).href }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBe('HTTP 503: Service Unavailable')
  })
})
