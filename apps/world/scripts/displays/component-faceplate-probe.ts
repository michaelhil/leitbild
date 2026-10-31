import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Actual built, local Host/World UI. Read-only inspection and display navigation.
const url = process.argv[2], output = resolve(process.argv[3] ?? '')
if (!url || !process.argv[3] || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw Error('Own loopback Run URL and output directory required')
const testedRef = process.env.LEITBILD_LOADING_TESTED_COMMIT
if (!testedRef) throw Error('Set LEITBILD_LOADING_TESTED_COMMIT to the built app source')
const testedApp = Bun.spawnSync(['git', 'rev-parse', testedRef], { cwd: resolve(import.meta.dir, '../../../..') }).stdout.toString().trim()
if (!/^[0-9a-f]{40}$/.test(testedApp)) throw Error('The built app source must resolve locally')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'process-faceplates-'))
const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(output, 'chrome.log')) })
let socket: WebSocket | null = null, sequence = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>(), exceptions: unknown[] = [], steps: any[] = []
const call = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression: string) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result?.value }
const world = (body: string) => evaluate(`(()=>{const hostFrame=document.querySelector('iframe[src*="/world/runs/"]');if(!hostFrame?.contentWindow?.document)return null;const w=hostFrame.contentWindow,d=w.document;${body}})()`)
const display = (body: string) => world(`const frame=d.querySelector('.display-frame-layer:not(.hidden) iframe'),v=frame?.contentWindow,p=v?.document;${body}`)
const until = async (read: () => Promise<any>, label: string) => { const started = performance.now(); for (;;) { const value = await read(); if (value) return value; if (performance.now() - started > 45000) throw Error('Not ready: ' + label); await Bun.sleep(50) } }
const click = async (read: string) => {
  const point = await display(`const element=${read};if(!element)throw Error('Missing public target');element.scrollIntoView({block:'nearest',inline:'nearest'});return new Promise((resolve,reject)=>{const started=w.performance.now();let previous='',stable=0;const measure=()=>{if(!element.isConnected)return reject(Error('Public target was replaced'));const a=hostFrame.getBoundingClientRect(),b=frame.getBoundingClientRect(),c=element.getBoundingClientRect(),point={x:a.x+b.x+(c.x+c.width/2)*b.width/frame.clientWidth,y:a.y+b.y+(c.y+c.height/2)*b.height/frame.clientHeight},signature=JSON.stringify([point,c.width,c.height]);stable=signature===previous?stable+1:0;previous=signature;if(stable>=2)return resolve(point);if(w.performance.now()-started>5000)return reject(Error('Public target did not settle'));w.requestAnimationFrame(measure)};w.requestAnimationFrame(measure)})`)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
const clickWorld = async (read: string) => {
  const point = await world(`const element=${read};if(!element)throw Error('Missing public World target');const a=hostFrame.getBoundingClientRect(),b=element.getBoundingClientRect();return{x:a.x+b.x+b.width/2,y:a.y+b.y+b.height/2}`)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
const key = async (key: string, code = key) => { await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...(key === ' ' ? { windowsVirtualKeyCode: 32, text: ' ' } : key === 'Enter' ? { windowsVirtualKeyCode: 13, text: '\r' } : key === 'Escape' ? { windowsVirtualKeyCode: 27 } : {}) }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code }) }
const card = () => display(`const c=p?.querySelector('.faceplate:not(.pinned)');return c?{element:c.getAttribute('data-faceplate'),name:c.getAttribute('aria-label'),text:c.innerText,source:frame.src,focused:c.contains(p.activeElement),magnifiers:p.querySelectorAll('.magnifier,obi-search').length}:null`)
const shot = async (name: string) => { const r = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, name + '.png'), Buffer.from(r.data, 'base64')) }
try {
  let port = 0; const started = performance.now()
  for (;;) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {} if (port) break; if (chrome.exitCode !== null || performance.now() - started > 30000) throw Error('Chrome startup failed'); await Bun.sleep(50) }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
  socket.onmessage = event => { const m = JSON.parse(String(event.data)), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result) } else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails) }
  await call('Runtime.enable'); await call('Page.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await call('Page.navigate', { url })
  await until(() => world(`return !!d.querySelector('.maplibregl-canvas')&&!d.querySelector('.startup-modal-frame')`), 'real Run startup')
  await world(`d.querySelector('[aria-label="Open process display for Halden Unit 1"]').click()`)
  await until(() => display(`return !!p?.querySelector('.flow .device[role=button]')`), 'PWR process display')
  const initial = await display(`return{source:frame.src,title:p.querySelector('.vignette h1')?.textContent,magnifiers:p.querySelectorAll('.magnifier,obi-search').length,texts:[...p.querySelectorAll('.flow .text[data-item]')].map(t=>({id:t.dataset.item,title:t.title,text:t.innerText}))}`)
  if (initial.magnifiers !== 0) throw Error('Magnifier remains')
  const title = await display(`return p.querySelector('.flow .device[role=button]').title`)
  await click(`p.querySelector('.flow .device[role=button]')`)
  const bodyCard = await until(card, 'body faceplate'); steps.push({ action: 'pointer-symbol', ...bodyCard })
  if (bodyCard.source !== initial.source || !bodyCard.focused) throw Error('Body navigated or did not focus its card')
  await until(() => display(`return !!p.querySelector('.faceplate obc-readout-list-item')`), 'real faceplate readings')
  await shot('symbol-faceplate'); await key('Escape')
  await until(() => display(`return !p.querySelector('.faceplate:not(.pinned)')`), 'Esc closes the card')
  const afterEscape = await display(`return{source:frame.src,focusTitle:p.activeElement?.title}`); steps.push({ action: 'escape', ...afterEscape })
  await click(`[...p.querySelectorAll('.flow .text[data-item]')].find(t=>t.title===${JSON.stringify(title)})`)
  const textCard = await until(card, 'text faceplate'); steps.push({ action: 'pointer-text', ...textCard })
  if (textCard.element !== bodyCard.element || textCard.source !== initial.source) throw Error('Text inspected a different element or navigated')
  await key('Escape')
  await display(`p.querySelector('.flow .device[role=button]').focus()`); await key('Enter')
  const enterCard = await until(card, 'Enter faceplate'); steps.push({ action: 'enter', ...enterCard }); if (enterCard.element !== bodyCard.element || enterCard.source !== initial.source) throw Error('Enter differs from pointer')
  await key('Escape'); await display(`p.querySelector('.flow .device[role=button]').focus()`); await key(' ', 'Space')
  const spaceCard = await until(card, 'Space faceplate'); steps.push({ action: 'space', ...spaceCard }); if (spaceCard.element !== bodyCard.element || spaceCard.source !== initial.source) throw Error('Space differs from pointer')
  await key('Escape')
  await click(`p.querySelector('.flow .text[data-item="mainFeedwaterPumpA"] span')`)
  await until(() => display(`return p.querySelectorAll('.faceplate .related[aria-label="Members"] button').length===2`), 'actual group faceplate')
  const groupCard = await card(); steps.push({ action: 'group', ...groupCard }); if (groupCard.source !== initial.source) throw Error('Group navigated')
  await click(`p.querySelector('.faceplate .related[aria-label="Members"] button')`)
  await until(() => display(`return !p.querySelector('.faceplate .related[aria-label="Members"]')&&!!p.querySelector('.faceplate obc-readout-list-item')`), 'group member readings')
  await until(() => display(`return !!p.querySelector('.faceplate .actions')`), 'member-specific real Pack controls loaded')
  const memberCard = await card(); steps.push({ action: 'member', ...memberCard }); if (memberCard.source !== initial.source) throw Error('Member navigated')
  await key('Escape')
  await click(`p.querySelector('.flow .text[data-item="s7"] span')`)
  const continuation = await until(card, 'single continuation card'); steps.push({ action: 'single-continuation', ...continuation }); if (continuation.source !== initial.source) throw Error('Continuation navigated')
  await key('Escape')
  await click(`p.querySelector('.flow .text[data-item="s1"] span')`)
  await until(() => display(`return p.querySelectorAll('[data-chooser] button').length===2`), 'plural continuation chooser')
  if (!(await display(`return [...p.querySelectorAll('.flow .area')].some(element=>element.getAttribute('aria-expanded')==='true')`))) throw Error('Flow chooser does not expose expansion')
  await click(`p.querySelector('[data-chooser] button')`)
  const chosen = await until(card, 'chosen continuation card'); steps.push({ action: 'plural-continuation-choice', ...chosen }); if (chosen.source !== initial.source) throw Error('Chosen continuation navigated')
  await key('Escape'); await click(`p.querySelector('.flow .device[role=button]')`); await until(card, 'restore turbine card')
  await click(`p.querySelector('.faceplate obc-button.detail')`)
  const detail = await until(() => display(`return frame?.src!==${JSON.stringify(initial.source)}&&p?.querySelector('.vignette h1')?{source:frame.src,title:p.querySelector('.vignette h1').textContent}:null`), 'explicit Open detail')
  steps.push({ action: 'open-detail', ...detail }); await shot('explicit-detail')
  if (process.env.LEITBILD_FACEPLATE_GRID === '1') {
    await clickWorld(`d.querySelector('.display-window-position')`)
    await until(() => world(`return !!d.querySelector('.display-window-option')`), 'public display list')
    const choices = await world(`return [...d.querySelectorAll('.display-window-option')].map(e=>({title:e.querySelector('strong')?.textContent,caption:e.querySelector('small')?.textContent}))`)
    steps.push({ action: 'display-choices', choices })
    await clickWorld(`[...d.querySelectorAll('.display-window-option')].find(e=>e.querySelector('strong')?.textContent.includes('Norway grid'))`)
    await until(() => display(`return !!p?.querySelector('.network .area[role=button]')`), 'actual Grid network')
    const gridSource = await display(`return frame.src`)
    await click(`p.querySelector('.network .area[role=button]')`)
    await until(() => display(`return !!p.querySelector('.faceplate,[data-chooser]')`), 'Grid inspection or genuine target choice')
    if (await display(`return !!p.querySelector('[data-chooser]')`)) { if (!(await display(`return p.querySelector('.network .area[role=button]').getAttribute('aria-expanded')==='true'`))) throw Error('Network chooser does not expose expansion'); await click(`p.querySelector('[data-chooser] button')`) }
    const gridCard = await until(card, 'Grid component faceplate'); steps.push({ action: 'grid-pointer', ...gridCard })
    if (gridCard.source !== gridSource) throw Error('Grid body navigated directly')
    await until(() => display(`return !!p.querySelector('.faceplate obc-readout-list-item')`), 'real Grid readings'); await shot('grid-faceplate')
    await key('Escape'); await display(`p.querySelector('.network .area[role=button]').focus()`); await key('Enter')
    await until(() => display(`return !!p.querySelector('.faceplate,[data-chooser]')`), 'Grid keyboard inspection or choice')
    if (await display(`return !!p.querySelector('[data-chooser]')`)) { await until(() => display(`return p.activeElement?.matches('[data-chooser] button')`), 'keyboard chooser focus'); await key('Enter') }
    const gridKey = await until(card, 'Grid keyboard faceplate'); steps.push({ action: 'grid-enter', ...gridKey })
    if (gridKey.element !== gridCard.element || gridKey.source !== gridSource) throw Error('Grid keyboard differs')
    await click(`p.querySelector('.faceplate obc-button.detail')`)
    const gridDetail = await until(() => display(`return frame?.src!==${JSON.stringify(gridSource)}&&p?.querySelector('.vignette h1')?{source:frame.src,title:p.querySelector('.vignette h1').textContent}:null`), 'Grid explicit detail')
    steps.push({ action: 'grid-detail', ...gridDetail }); await shot('grid-detail')
  }
  if (exceptions.length) throw Error('Runtime exceptions')
  const modules = await display(`return [...v.performance.getEntriesByType('resource')].filter(entry=>entry.name.includes('/assets/world/')&&entry.name.split('?')[0].endsWith('.js')).map(entry=>entry.name)`)
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ testedApp, url, initial, steps, modules, exceptions, limits: ['Actual built local Host/World, isolated paused Run.', 'CDP pointer and keyboard events; no production hooks or model/command mutation.', 'Symbol/text/Enter/Space preserve current display; only explicit card Open detail navigates.'] }, null, 2))
  console.log(JSON.stringify({ output, element: bodyCard.element, detail: detail.title, steps: steps.length, exceptions }))
} catch (error) { try { await shot('failure'); const state = await world(`return{world:d.body.innerText,frames:[...d.querySelectorAll('.display-frame-layer iframe')].map(f=>({src:f.src,hidden:f.closest('.display-frame-layer').classList.contains('hidden'),text:f.contentDocument?.body.innerText}))}`); await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), state, steps, exceptions }, null, 2)) } catch {} throw error
} finally { socket?.close(); chrome.kill(); await chrome.exited; await rm(profile, { recursive: true, force: true }) }
