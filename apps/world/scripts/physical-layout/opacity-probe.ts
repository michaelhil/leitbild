import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const root = join(import.meta.dir, '../..'), rendererRoot = process.env.LEITBILD_OPACITY_RENDERER_ROOT ?? root, output = process.env.LEITBILD_OPACITY_PROBE_DIR ?? await mkdtemp(join(tmpdir(), 'leitbild-opacity-proof-'))
await mkdir(output, { recursive: true })
const entry = join(root, 'tests/browser/physical-scene/opacity-probe.ts')
const bundle = await Bun.build({ entrypoints: [entry], outdir: join(output, 'dist'), target: 'browser', format: 'esm', naming: 'app.js', plugins: [{ name: 'frozen-renderer-under-test', setup(build) { build.onLoad({ filter: /opacity-probe\.ts$/ }, async args => args.path === entry ? { contents: (await readFile(args.path, 'utf8')).replaceAll("'../../../src/", `'${rendererRoot}/src/`), loader: 'ts' } : undefined) } }] })
if (!bundle.success) throw new AggregateError(bundle.logs, 'Opacity probe build failed')
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname === '/app.js' ? new Response(Bun.file(bundle.outputs[0]!.path)) : new Response('<!doctype html><canvas></canvas><pre></pre><script type="module" src="/app.js"></script>', { headers: { 'content-type': 'text/html' } }) })
const runs = []
try {
  for (const dpr of [1, 2]) {
    const profile = await mkdtemp(join(tmpdir(), 'leitbild-opacity-chrome-')), stderr = join(output, `chrome-${dpr}.log`)
    const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=700,700', `--force-device-scale-factor=${dpr}`, 'about:blank'], { stdout: 'ignore', stderr: Bun.file(stderr) })
    let socket: WebSocket | null = null
    try {
      let port = 0
      for (let count = 0; count < 80 && !port; count++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; if (!port) await Bun.sleep(100) }
      if (!port) throw Error('Isolated Chrome did not start')
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.port}/`)}`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }
      socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
      let id = 0
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>()
      socket.onmessage = event => { const message = JSON.parse(String(event.data)); const value = pending.get(message.id); if (!value) return; pending.delete(message.id); if (message.error) value.reject(message.error); else value.resolve(message.result) }
      const call = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket!.send(JSON.stringify({ id: next, method, params })) })
      const evaluated = await call('Runtime.evaluate', { expression: 'new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(window.opacityProbe){clearInterval(t);resolve(window.opacityProbe)}else if(++n>400){clearInterval(t);reject(Error("Opacity fixture did not complete"))}},25)})', awaitPromise: true, returnByValue: true, timeout: 30_000 })
      const result = evaluated.result?.value
      await writeFile(join(output, `receipt-dpr${dpr}.json`), JSON.stringify(result ?? evaluated, null, 2))
      const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, `dpr${dpr}.png`), Buffer.from(shot.data, 'base64'))
      if (!result) throw Error('Opacity fixture failed before producing a receipt')
      runs.push(result)
    } finally { socket?.close(); chrome.kill(); await chrome.exited; await rm(profile, { recursive: true, force: true }) }
  }
  const files = ['backend.ts', 'renderer.ts', 'render-pass.ts', 'architecture-backend.ts', 'architecture-bsp.ts', 'architecture-bsp-types.ts', 'architecture-cohort.ts', 'plan-projection.ts', 'preparation.ts', 'geometry.ts', 'surface-ownership.ts', 'picking.ts', 'render-buffers.ts', 'math.ts', 'gl-state.ts', 'architecture-opacity.ts'].map(file => `src/ui/map/physical-scene/${file}`)
  const fixtureFiles = ['tests/browser/physical-scene/opacity-probe.ts', 'scripts/physical-layout/opacity-probe.ts']
  const hashes = async (base: string, paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async file => [file, createHash('sha256').update(await readFile(join(base, file))).digest('hex')])))
  const provenance = { commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: rendererRoot }).stdout.toString().trim(), rendererRoot, files: await hashes(rendererRoot, files), fixtureCommit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(), fixtureFiles: await hashes(root, fixtureFiles) }
  await writeFile(join(output, 'summary.json'), JSON.stringify({ passed: runs.every(value => value.passed), provenance, runs }, null, 2))
  console.log(JSON.stringify({ output, passed: runs.every(value => value.passed), negativeCapability: runs.map(value => value.negativeCapability), runs: runs.map(value => ({ device: value.device, results: value.results, disposal: value.disposal })) }, null, 2))
  if (runs.some(value => !value.passed)) process.exitCode = 1
} finally { server.stop(true) }
