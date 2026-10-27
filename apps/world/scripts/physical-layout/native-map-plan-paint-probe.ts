import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { nativeMapStartup } from '../../tests/browser/physical-scene/native-map-startup.ts'

// Read-only real-product paint equivalence. No production hooks or camera state
// mutations: scope, mode, Home and Live are exercised through their public UI.
const [url, output, tested] = process.argv.slice(2), ratio = Number(process.env.LEITBILD_PHYSICAL_PROBE_DPR ?? 1)
if (!url || !output || !tested || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || !(ratio > 0)) throw Error('Loopback URL, output, exact built commit and valid DPR required')
const out = resolve(output), repository = resolve(import.meta.dir, '../../../..'), appCommit = Bun.spawnSync(['git', 'rev-parse', tested], { cwd: repository }).stdout.toString().trim()
if (!/^[0-9a-f]{40}$/.test(appCommit)) throw Error('Built commit cannot be resolved')
await mkdir(out, { recursive: true })
const recording = `(()=>{const q={last:null,paints:0};window.__planPaintProof=q;const clear=CanvasRenderingContext2D.prototype.clearRect,fill=CanvasRenderingContext2D.prototype.fill,stroke=CanvasRenderingContext2D.prototype.stroke,text=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.clearRect=function(...a){if(this.canvas.classList.contains('layout-plan-annotations'))q.last={ordinal:++q.paints,transforms:new Set(),texts:[]};return Reflect.apply(clear,this,a)};for(const [name,original]of [['fill',fill],['stroke',stroke]])CanvasRenderingContext2D.prototype[name]=function(...a){if(this.canvas.classList.contains('layout-plan-annotations')&&q.last){const m=this.getTransform();q.last.transforms.add(JSON.stringify([m.a,m.b,m.c,m.d,m.e,m.f]))}return Reflect.apply(original,this,a)};CanvasRenderingContext2D.prototype.fillText=function(...a){if(this.canvas.classList.contains('layout-plan-annotations')&&q.last)q.last.texts.push(String(a[0]));return Reflect.apply(text,this,a)}})()`
const profile = await mkdtemp(join(tmpdir(), 'leitbild-plan-paint-')), chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--force-device-scale-factor=${ratio}`, 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(out, 'chrome.log')) })
let socket: WebSocket | null = null, sequence = 0, phase = 'startup'
const pending = new Map<number, { resolve: (value: any) => void; reject: (value: unknown) => void }>(), errors: unknown[] = []
const call = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression: string) => { const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 90000 }); if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails)); return response.result?.value }
const world = (body: string) => evaluate(`(async()=>{const w=document.querySelector('iframe[src*="/world/runs/"]').contentWindow,d=w.document;${body}})()`)
const until = async (body: string, label: string) => { const started = performance.now(); while (performance.now() - started < 60000) { if (await world(body)) return; await Bun.sleep(80) }; throw Error(`Missing ${label}`) }
const settings = async () => { await world(`const b=[...d.querySelectorAll('.action-row button')].find(b=>b.textContent.trim()==='View');if(b.getAttribute('aria-expanded')!=='true')b.click()`); await until(`return !!d.querySelector('.settings')`, 'View menu') }
const closeSettings = () => world(`d.querySelector('[aria-label="Close view settings"]')?.click()`)
const live = async (enabled: boolean) => { await settings(); await world(`const i=[...d.querySelectorAll('.settings label')].find(e=>e.textContent.trim().startsWith('Live status'))?.querySelector('input');if(!i)throw Error('No public Live status');if(i.checked!==${enabled}||i.indeterminate)i.click()`); await closeSettings() }
const home = async () => { await settings(); await world(`[...d.querySelectorAll('.settings button')].find(e=>e.textContent==='Home · source view').click()`); await closeSettings() }
const capture = async (name: string) => {
  let previous = '', equal = 0, value: any = null, started = performance.now()
  while (performance.now() - started < 60000) {
    value = await world(`const c=d.querySelector('.layout-plan-annotations');if(!c?.width||!c.height||d.fonts.status!=='loaded')return null;const image=c.getContext('2d').getImageData(0,0,c.width,c.height),digest=Array.from(new Uint8Array(await w.crypto.subtle.digest('SHA-256',image.data))).map(x=>x.toString(16).padStart(2,'0')).join(''),q=w.__planPaintProof;return{width:c.width,height:c.height,digest,paints:q.paints,transforms:[...q.last.transforms],texts:q.last.texts,mode:d.querySelector('.modes button[aria-pressed=true]')?.textContent,scope:d.querySelector('.scope')?.textContent,level:d.querySelector('select[aria-label="Layout level"]')?.value,evidence:d.querySelector('.evidence')?.textContent,nonempty:image.data.some((v,i)=>i%4===3&&v>0),font:d.fonts.status}`)
    const key = value ? JSON.stringify([value.digest, value.width, value.height, value.transforms, value.texts]) : ''
    if (key && key === previous) equal++; else { equal = 0; previous = key }
    if (equal >= 4) break
    await Bun.sleep(150)
  }
  if (equal < 4 || !value?.nonempty || value.mode?.trim() !== 'Plan') throw Error(`No stable native Plan ${name}`)
  const bytes = await world(`const c=d.querySelector('.layout-plan-annotations'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let raw='';for(let i=0;i<a.length;i+=32768)raw+=String.fromCharCode(...a.subarray(i,i+32768));return{png:c.toDataURL('image/png').split(',')[1],raw:w.btoa(raw)}`)
  await writeFile(join(out, `${name}.png`), Buffer.from(bytes.png, 'base64')); await writeFile(join(out, `${name}.rgba`), Buffer.from(bytes.raw, 'base64'))
  const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(out, `${name}-product.png`), Buffer.from(shot.data, 'base64'))
  await writeFile(join(out, `${name}.json`), JSON.stringify(value, null, 2)); return value
}
try {
  let port = 0; const started = performance.now(); while (!port && performance.now() - started < 45000) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; if (!port) await Bun.sleep(80) }
  if (!port) throw Error('Chrome did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }; socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
  socket.onmessage = event => { const value = JSON.parse(String(event.data)), task = pending.get(value.id); if (task) { pending.delete(value.id); value.error ? task.reject(value.error) : task.resolve(value.result) } else if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails) }
  await call('Runtime.enable'); await call('Page.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: ratio, mobile: false }); await call('Page.addScriptToEvaluateOnNewDocument', { source: recording }); await call('Page.navigate', { url }); const startup = await evaluate(`(${nativeMapStartup.toString()})(true)`)
  await world(`const b=[...d.querySelectorAll('.modes button')].find(e=>e.textContent==='Plan');if(b.getAttribute('aria-pressed')!=='true')b.click();d.querySelector('.scope').click()`); await until(`return [...d.querySelectorAll('.scopes button')].some(b=>b.textContent.trim()==='All available layouts')`, 'all layouts'); await world(`[...d.querySelectorAll('.scopes button')].find(b=>b.textContent.trim()==='All available layouts').click()`)
  await until(`return /5 layouts ready/.test(d.querySelector('.evidence')?.textContent??'')`, 'five admitted Plan layouts'); await live(false); await home(); phase = 'site'; const site = await capture('site-live-off')
  await world(`d.querySelector('.scope').click()`); await until(`return !!d.querySelector('.scopes input')`, 'scope search'); await world(`const i=d.querySelector('.scopes input');i.value='Turbine hall';i.dispatchEvent(new w.Event('input',{bubbles:true}))`)
  const area = 'Halden Unit 1 full plant / PWR unit / Turbine hall and feedwater pump annex'; await until(`return [...d.querySelectorAll('.choose-area')].some(b=>b.title===${JSON.stringify(area)})`, 'turbine area'); await world(`[...d.querySelectorAll('.choose-area')].find(b=>b.title===${JSON.stringify(area)}).click()`); await until(`return !!d.querySelector('select[aria-label="Layout level"]')`, 'floor'); await world(`const s=d.querySelector('select[aria-label="Layout level"]');s.value='operating';s.dispatchEvent(new w.Event('change',{bubbles:true}))`); await live(false); await home(); phase = 'operating'; const operating = await capture('operating-live-off')
  const receipt = { passed: errors.length === 0, url, appCommit, ratio, startup, captures: { site, operating }, errors, runnerSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), limits: ['Actual built Host/World with retained R5 source, public UI only, no Run or source mutation.', 'Functional settled Canvas pixels; no performance or frame-time claim. Live off suppresses changing live glyphs for exact reference comparison.'] }; await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ out, passed: receipt.passed, digests: [site.digest, operating.digest] })); if (!receipt.passed) process.exitCode = 1
} catch (error) { try { const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(out, 'failure.png'), Buffer.from(shot.data, 'base64')); await writeFile(join(out, 'failure.json'), JSON.stringify({ phase, error: String(error), errors }, null, 2)) } catch {} throw error }
finally { socket?.close(); chrome.kill(); await chrome.exited; await rm(profile, { recursive: true, force: true }) }
