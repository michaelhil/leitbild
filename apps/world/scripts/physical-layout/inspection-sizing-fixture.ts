// Manual browser proof only: real built embed, explicit delayed first sample,
// actual read-only paused-Run data. Never starts, resumes or edits a Run.
import { resolve, join, relative } from 'node:path'
import { z } from 'zod'
import { layoutInspectionEnvelope, layoutInspectionSampleMessage, layoutInspectionStateSchema } from '../../src/ui/physical-layout/inspection.ts'
import { layoutLiveExpectedSchema, layoutLiveResponseSchema } from '../../src/ui/physical-layout/read-model.ts'

const input = z.object({
  origin: z.string().url(), workspaceId: z.string().uuid(), expected: layoutLiveExpectedSchema,
  elementId: z.string().min(1), label: z.string().min(1),
}).strict().parse(await Bun.file(process.argv[2] ?? '').json())
const upstream = new URL(input.origin)
if (upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('Supply a plain origin without credentials, path, query or fragment')
if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname))) throw new Error('Use HTTPS or an isolated loopback stack')
const repositoryFlag = process.argv.indexOf('--repository')
const repository = repositoryFlag < 0 ? resolve(import.meta.dir, '../../../..') : resolve(process.argv[repositoryFlag + 1] ?? '')
const dist = join(repository, 'apps/world/src/ui/dist')
if (!await Bun.file(join(dist, 'embed.html')).exists()) throw new Error('Build the candidate World UI before starting this fixture')
const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: repository, stdout: 'pipe' })
const source = (await new Response(git.stdout).text()).trim()
if (await git.exited !== 0) throw new Error('Cannot identify candidate source')
const { runId: _runId, ...owner } = input.expected
const state = layoutInspectionStateSchema.parse({ ...owner, elementId: input.elementId, label: input.label, delivery: 'host', channel: crypto.randomUUID() })
const envelope = layoutInspectionEnvelope({ workspaceId: input.workspaceId, runId: input.expected.runId, state })
const frameUrl = `/workspaces/${encodeURIComponent(input.workspaceId)}/world/embed/physical-layout.inspection#view=${encodeURIComponent(JSON.stringify(envelope))}`
const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'inspection-sizing-fixture-client.ts')], target: 'browser', minify: false })
if (!build.success || build.outputs.length !== 1) throw new Error(`Fixture client build failed: ${build.logs.map(String).join('\n')}`)
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Inspection sizing protocol fixture</title><style>
body{margin:0;font:14px system-ui;color:#17252c;background:#eef0ed}header{padding:12px 16px;background:white;border-bottom:1px solid #cbd0cc}h1{font-size:18px;margin:0 0 8px}p{margin:6px 0}button{padding:10px;min-height:44px}main{display:flex;gap:20px;padding:12px 16px;align-items:flex-start}#room{position:relative;width:min(376px,calc(100vw - 32px));height:calc(100dvh - 170px);border:1px dashed #617568;background:#d9dfd8;flex:none}#room.compact{height:22dvh}iframe{position:absolute;border:0;background:white;box-sizing:border-box}#receipt{white-space:pre-wrap;font-size:12px;max-height:calc(100dvh - 200px);overflow:auto}#failure{color:#8b1c1c}aside{max-width:640px;min-width:0}@media(max-width:650px){main{display:block}aside{margin-top:12px}}
</style></head><body><header><h1>Inspection sizing protocol fixture</h1><p>Real candidate embed. Start with no owner data; deliver the first actual paused-Run reading only after the loading card has settled.</p><button id="deliver" disabled>Deliver first owner sample</button> <button id="shrink">Shrink available height</button> <button id="grow">Grow available height</button></header><main><section id="room" aria-label="Available inspection space"><iframe id="inspection" title="Actual inspection card"></iframe></section><aside><p id="sample-receipt">No sample delivered. No automatic polling.</p><p id="failure" role="alert"></p><h2>Visible sizing receipt</h2><pre id="receipt"></pre></aside></main><script type="module" src="/fixture/client.js"></script></body></html>`
let readPending = false, reads = 0
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  if (request.method === 'GET' && path === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  if (request.method === 'GET' && path === '/fixture/config') return Response.json({ state, frameUrl, source })
  if (request.method === 'GET' && path === '/fixture/client.js') return new Response(build.outputs[0]!, { headers: { 'Content-Type': 'text/javascript' } })
  if (request.method === 'POST' && path === '/fixture/sample') {
    if (readPending) return Response.json({ error: 'The previous explicit read is still pending' }, { status: 409 })
    readPending = true
    try {
      const route = `/api/workspaces/${encodeURIComponent(input.workspaceId)}/world/simulation-runs/${encodeURIComponent(input.expected.runId)}/displays/layout`
      const response = await fetch(new URL(route, upstream), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layoutObjectId: input.expected.layoutObjectId, expectedRevision: input.expected.revision }), signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`Read-only layout acquisition HTTP ${response.status}: ${await response.text()}`)
      const latest = layoutLiveResponseSchema.parse(await response.json()), receivedWallMs = Date.now()
      if (Object.entries(input.expected).some(([key, value]) => latest.scope[key as keyof typeof input.expected] !== value)) throw new Error('Owner sample does not match fixture scope')
      if (!latest.sample.at.paused) throw new Error('This proof requires an already paused Run; the fixture never changes playback')
      const message = layoutInspectionSampleMessage(state, { phase: 'live', latest, failure: null,
        stamp: { scope: input.expected, epoch: latest.scope.epoch, sequence: latest.scope.sequence, receivedWallMs } })
      reads++; console.log(`Explicit read-only owner sample ${reads}: ${latest.scope.epoch}/${latest.scope.sequence}, received ${receivedWallMs}`)
      return Response.json({ message, receivedWallMs })
    } catch (error) { return Response.json({ error: String(error) }, { status: 502 }) }
    finally { readPending = false }
  }
  if (request.method === 'GET' && path.startsWith('/workspaces/') && path.includes('/world/embed/')) return new Response(Bun.file(join(dist, 'embed.html')))
  if (request.method === 'GET' && path.startsWith('/assets/world/')) {
    const file = resolve(dist, '.' + path), within = relative(dist, file)
    if (within.startsWith('..') || !await Bun.file(file).exists()) return new Response('No candidate asset', { status: 404 })
    return new Response(Bun.file(file))
  }
  return new Response('Fixture route unavailable', { status: 404 })
} })
console.log(`Inspection sizing proof: http://127.0.0.1:${server.port}/; candidate ${source}`)
console.log('Only the Deliver button performs a read. No Run creation, playback, command, credential or model-provider path exists.')
const stop = (): void => { server.stop(true); process.exit(0) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
