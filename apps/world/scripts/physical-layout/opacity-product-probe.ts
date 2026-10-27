import { nativeMapStartup } from '../../tests/browser/physical-scene/native-map-startup.ts'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const input = process.argv[2]; if (!input) throw Error('Usage: opacity-product-probe.ts qa-run.json [output]')
const info = await Bun.file(resolve(input)).json(), output = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'leitbild-opacity-product-'))
if (!['127.0.0.1', 'localhost'].includes(new URL(info.url).hostname)) throw Error('Functional proof requires an isolated loopback Run')
const worldRoot = process.env.LEITBILD_OPACITY_RENDERER_ROOT ?? resolve(import.meta.dir, '../..'), ownRoot = resolve(import.meta.dir, '../..')
await mkdir(output, { recursive: true })
const instrumentFiles = [join(worldRoot, 'tests/browser/physical-scene/native-map-loading-instrumentation.ts'), join(worldRoot, 'tests/browser/physical-scene/native-map-route-instrumentation.ts'), join(ownRoot, 'tests/browser/physical-scene/opacity-ui-instrumentation.ts')]
const parts: string[] = []
for (const path of instrumentFiles) { const bundle = await Bun.build({ entrypoints: [path], target: 'browser', format: 'iife' }); if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build functional observer'); parts.push(await bundle.outputs[0]!.text()) }
const instrumentation = `window.__nativeRouteTarget={elementId:'turbine'};\n${parts.join('\n')}`
const profile = await mkdtemp(join(tmpdir(), 'leitbild-opacity-ui-chrome-'))
const chrome = Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { stdout: 'ignore', stderr: Bun.file(join(output, 'chrome.log')) })
let socket: WebSocket | null = null, id = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>(), exceptions: unknown[] = [], steps: any[] = []
const call = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket!.send(JSON.stringify({ id: next, method, params })) })
const evaluate = async (expression: string) => { const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 90_000 }); if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails)); return value.result?.value }
const world = (body: string) => evaluate(`(()=>{const frame=document.querySelector('iframe[src*="/world/runs/"]'),w=frame.contentWindow,d=w.document,q=w.__opacityUiProof,n=w.__nativeMapLoadingProof,r=w.__nativeRouteProof;${body}})()`)
const until = async (body: string, label: string) => { const began = performance.now(); for (;;) { if (await world(body)) return; if (performance.now() - began > 90_000) throw Error(`Timed out: ${label}`); await Bun.sleep(50) } }
const state = () => world(`return {wall:d.querySelector('input[aria-label="Wall opacity"]')?.value,floor:d.querySelector('input[aria-label="Floor opacity"]')?.value,mode:d.querySelector('.modes [aria-pressed=true]')?.textContent?.trim(),level:d.querySelector('select[aria-label="Layout level"]')?.value,evidence:d.querySelector('.explorer-controls .evidence')?.textContent,jobs:q.jobs,draws:q.draws,sourceJobs:n.sources.length,geometryJobs:n.jobs.length,bspPending:n.bspPending,annotations:q.annotationFrames,badges:[...d.querySelectorAll('.layout-status')].map(e=>e.getAttribute('aria-label')),card:d.querySelector('.layout-inspection iframe')?.getAttribute('title'),active:d.activeElement?.tagName}`)
const record = async (name: string, extra: unknown = null) => { const full=await state(), compact={...full,jobs:full.jobs.map(({key,...job}:any)=>({...job,keySha256:createHash('sha256').update(key).digest('hex'),keyBytes:key.length})),draws:{count:full.draws.length,last:full.draws.at(-1),buffers:[...new Set(full.draws.map((draw:any)=>`${draw.buffer}:${draw.staticUploads}`))]},annotations:{count:full.annotations.length,last:full.annotations.at(-1)}}; const item={name,extra,state:compact};steps.push(item);await writeFile(join(output,'partial.json'),JSON.stringify({steps,exceptions},null,2));console.log(name);return full }
const settings = async () => { if (await world(`return Boolean(d.querySelector('.settings'))`)) return; await world(`const b=[...d.querySelectorAll('.explorer-controls button')].find(b=>b.textContent.trim()==='View');if(!b)throw Error('Missing layout View');b.click()`); await until(`return Boolean(d.querySelector('.settings'))`, 'View settings') }
const range = async (name: string, value: number) => { await settings(); await world(`const input=d.querySelector('input[aria-label=${JSON.stringify(name)}]');if(!input)throw Error('Missing range');input.value=${JSON.stringify(String(value))};input.dispatchEvent(new w.Event('input',{bubbles:true}))`); await until(`return d.querySelector('input[aria-label=${JSON.stringify(name)}]')?.value===${JSON.stringify(String(value))}`, name) }
const mode = async (requested: string) => { const label=requested==='2D'?'Plan':requested; await world(`const b=[...d.querySelectorAll('.modes button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing mode');b.click()`); await until(`return d.querySelector('.modes [aria-pressed=true]')?.textContent?.trim()===${JSON.stringify(label)}`, label) }
const floor = async (label: string) => { await world(`const input=d.querySelector('select[aria-label="Layout level"]'),option=[...input.options].find(o=>o.value===${JSON.stringify(label)}||o.textContent.toLowerCase().includes(${JSON.stringify(label.toLowerCase())}));if(!option)throw Error('Missing floor');input.value=option.value;input.dispatchEvent(new w.Event('change',{bubbles:true}))`); }
const scope = async (label: string) => {
  await world(`d.querySelector('.explorer-controls .scope').click()`); await until(`return Boolean(d.querySelector('.scopes input[type=search]'))`, 'area search')
  await world(`const input=d.querySelector('.scopes input[type=search]');input.value=${JSON.stringify(label)};input.dispatchEvent(new w.Event('input',{bubbles:true}))`)
  await until(`return [...d.querySelectorAll('.scopes button[title]')].some(b=>b.title.startsWith('Halden Unit 1 full plant /')&&b.title.split(' / ').at(-1)===${JSON.stringify(label)})`, label)
  await world(`[...d.querySelectorAll('.scopes button[title]')].find(b=>b.title.startsWith('Halden Unit 1 full plant /')&&b.title.split(' / ').at(-1)===${JSON.stringify(label)}).click()`)
  if (await world(`return Boolean(d.querySelector('[aria-label="Choose area floor"]'))`)) await world(`[...d.querySelector('[aria-label="Choose area floor"]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Show whole area in 3D').click()`)
}
const applied = () => until(`return q.jobs.some(j=>j.response==='prepared')&&!d.querySelector('.explorer-controls .evidence')?.textContent.includes('Preparing architecture transparency')&&!d.querySelector('.explorer-controls .evidence')?.textContent.includes('Architecture transparency unavailable')&&q.draws.length&&q.draws.at(-1).at>=Math.max(...q.jobs.filter(j=>j.response==='prepared').map(j=>j.finished))`, 'fractional result actually drawn in paused Run')
try {
  let port = 0
  for (let count = 0; count < 100 && !port; count++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; if (!port) await Bun.sleep(100) }
  if (!port) throw Error('Chrome did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject })
  socket.onmessage = event => { const message = JSON.parse(String(event.data)), value = pending.get(message.id); if (value) { pending.delete(message.id); message.error ? value.reject(message.error) : value.resolve(message.result) } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails) }
  await call('Runtime.enable'); await call('Page.enable'); await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 913, deviceScaleFactor: 1, mobile: false })
  await call('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation }); await call('Page.navigate', { url: info.url }); await call('Page.bringToFront')
  await evaluate(`(${nativeMapStartup.toString()})(true)`); await scope('Turbine hall and feedwater pump annex'); await mode('3D')
  await until(`return !n.pending&&!n.bspPending&&n.draws.some(item=>item.key.includes('[\"3d\"'))`, 'real focused 3D geometry')
  if (process.env.LEITBILD_OPACITY_UI_ONLY_ESCAPE === '1') {
    await world(`const b=[...d.querySelectorAll('.explorer-controls button')].find(b=>b.textContent.trim()==='Find');b.click()`)
    await until(`return Boolean(d.querySelector('.layout-components input[type=search]'))`, 'public equipment search')
    await world(`const input=d.querySelector('.layout-components input[type=search]');input.value='Turbine Generator';input.dispatchEvent(new w.Event('input',{bubbles:true}))`)
    await until(`return [...d.querySelectorAll('.component-row')].some(row=>row.querySelector('strong')?.textContent.trim()==='Turbine Generator')`, 'actual admitted component row')
    await world(`const row=[...d.querySelectorAll('.component-row')].find(row=>row.querySelector('strong')?.textContent.trim()==='Turbine Generator');row.querySelector('button[aria-label="Inspect Turbine Generator"]').click()`)
    await until(`const c=d.querySelector('.layout-inspection iframe')?.contentDocument;return Boolean(c?.querySelector('header[tabindex="0"]'))&&c.body.innerText.includes('Paused · readings fresh')`, 'mounted fresh shared Faceplate')
    await record('public-Find-Inspect-opens-ready-shared-Faceplate', await world(`const f=d.querySelector('.layout-inspection iframe'),c=f.contentDocument;return{title:f.title,src:f.src,text:c.body.innerText,focus:c.activeElement?.localName,childFocused:c.hasFocus()}`))
    await world(`const c=d.querySelector('.layout-inspection iframe'),child=c.contentWindow;child.addEventListener('keydown',e=>{q.inspectionKey={key:e.key,target:e.target?.localName,prevented:e.defaultPrevented,childFocused:c.contentDocument.hasFocus()};queueMicrotask(()=>q.inspectionKey.finalPrevented=e.defaultPrevented)},{capture:true});w.addEventListener('message',e=>{if(e.data?.type==='world:layout-inspection-close')q.inspectionClose={...e.data,origin:e.origin,fromCurrentFrame:e.source===child}})`)
    await call('Page.bringToFront'); await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await until(`return !d.querySelector('.layout-inspection iframe')`, 'Escape closes the actually mounted Faceplate')
    await record('native-Escape-closes-ready-iframe-and-restores-map-focus', await world(`return{key:q.inspectionKey,close:q.inspectionClose,focus:d.activeElement?.className}`))
  } else {
  await settings(); await record('opaque-start')
  await world(`q.hold=true`); await range('Wall opacity', .44); await range('Floor opacity', .32)
  await until(`return q.jobs.some(j=>j.held)&&d.querySelector('.evidence')?.textContent.includes('requested wall 44%, floor 32%')`, 'both pending values')
  await record('pending-two-slider-intent-preserved')
  await world(`const label=[...d.querySelectorAll('.settings label')].find(l=>l.textContent.trim()==='Roof structure');if(!label)throw Error('Missing declared roof layer');label.querySelector('input').click()`)
  await until(`return q.jobs.filter(j=>j.held).length>=2`, 'layer geometry owns its new pending cohort')
  await record('pending-layer-change-preserves-both-sliders')
  await floor('operating'); await until(`return q.jobs.filter(j=>j.held).length>=3`, 'new floor owns a new pending cohort')
  await settings(); if (await world(`return d.querySelector('input[aria-label="Wall opacity"]')?.value!=='0.44'||d.querySelector('input[aria-label="Floor opacity"]')?.value!=='0.32'`)) throw Error('Floor edit lost requested opacity')
  await record('pending-floor-change-preserves-intent'); await scope('Turbine hall'); await settings()
  if (await world(`return d.querySelector('input[aria-label="Wall opacity"]')?.value!=='0.44'||d.querySelector('input[aria-label="Floor opacity"]')?.value!=='0.32'`)) throw Error('Scope edit lost requested opacity')
  await record('pending-scope-change-preserves-both-sliders'); const released = await world(`return q.release()`); await applied(); await record('paused-worker-completion-drawn', released)
  const warm = await state()
  for (const value of [.35, .45, .55, .65]) { await range('Wall opacity', value); await world(`return new Promise(resolve=>w.requestAnimationFrame(()=>resolve()))`) }
  const afterWarm = await record('warm-slider-job-vbo-reuse')
  if (afterWarm.jobs.length !== warm.jobs.length) throw Error('Warm opacity edits rescanned architecture')
  const warmBuffers = new Set(warm.draws.map((draw: any) => `${draw.buffer}:${draw.staticUploads}`)); if (afterWarm.draws.slice(warm.draws.length).some((draw: any) => !warmBuffers.has(`${draw.buffer}:${draw.staticUploads}`))) throw Error('Warm opacity edits uploaded new geometry')
  await world(`q.failNext=true`); await floor('lower'); await until(`return d.querySelector('.evidence')?.textContent.includes('Architecture transparency unavailable')`, 'controlled failure visible')
  const failed = await record('explicit-failure-retains-opaque-model'); if (!failed.evidence.includes('showing wall') || !failed.evidence.includes('Controlled isolated')) throw Error('Failure was not explicit')
  await world(`const b=d.querySelector('button[aria-label^="Retry physical layout:"]');if(!b)throw Error('Missing Retry');b.click()`); await applied(); await record('real-scoped-Retry-recovers')
  await world(`q.hold=true`); await floor('operating'); await until(`return q.jobs.at(-1)?.held&&!q.jobs.at(-1)?.posted`, 'pending cancel target')
  await mode('2D'); await world(`return q.release()`); await until(`return !d.querySelector('.evidence')?.textContent.includes('Preparing architecture transparency')`, 'Plan needs no BSP')
  await record('Plan-cancels-stale-pending-cohort'); await mode('3D'); await applied(); await record('fresh-3D-after-cancel')
  await scope('Turbine hall and feedwater pump annex'); await applied(); await settings()
  await world(`const input=[...d.querySelectorAll('.settings label')].find(l=>l.textContent.trim()==='Roof structure')?.querySelector('input');if(input?.checked)input.click()`)
  await range('Wall opacity', .4); await range('Floor opacity', .4); await applied(); await world(`d.querySelector('[aria-label="Close view settings"]').click()`)
  await world(`const b=[...d.querySelectorAll('.explorer-controls button')].find(b=>b.textContent.trim()==='Home');b?.click()`)
  const image = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, 'fractional-hall.png'), Buffer.from(image.data, 'base64'))
  await record('fractional-hall-visual')
  // A real component hit is found from the admitted mesh and actual uploaded
  // matrix, then confirmed by its PUBLIC hover label before any dwell claim.
  await world(`const b=[...d.querySelectorAll('.explorer-controls button')].find(b=>b.textContent.trim()==='Find');b.click()`)
  await until(`return Boolean(d.querySelector('.layout-components input[type=search]'))`, 'Find equipment field')
  await world(`d.querySelector('.maplibregl-canvas').focus()`)
  const candidates = await world(`return r.projected()`)
  let equipmentPoint: { x: number; y: number } | null = null
  for (const point of candidates) {
    const hostPoint = await evaluate(`(()=>{const b=document.querySelector('iframe[src*="/world/runs/"]').getBoundingClientRect();return{x:b.x+${point.x},y:b.y+${point.y}}})()`)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hostPoint.x, y: hostPoint.y, buttons: 0 }); await Bun.sleep(150)
    if (await world(`return d.querySelector('.layout-hover-label strong')?.textContent===r.object?.label`)) { equipmentPoint = hostPoint; break }
    if (await world(`return Boolean(d.querySelector('.layout-inspection iframe'))`)) break
  }
  if (!equipmentPoint) throw Error('No actual turbine hover target could be established')
  await world(`d.querySelector('.layout-components input[type=search]').focus()`)
  await call('Input.insertText', { text: 'turbine' }); await Bun.sleep(2300)
  if (await world(`return Boolean(d.querySelector('.layout-inspection iframe'))||d.activeElement?.getAttribute('type')!=='search'||!d.activeElement?.value.includes('turbine')`)) throw Error('Resting-pointer dwell stole keyboard focus')
  await record('keyboard-focus-cancels-resting-pointer-dwell')
  await world(`d.querySelector('[aria-label="Close equipment search"]').click()`)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1420, y: 900, buttons: 0 }); await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...equipmentPoint, buttons: 0 })
  await until(`return Boolean(d.querySelector('.layout-inspection iframe'))`, 'fresh explicit hover dwell')
  await until(`const c=d.querySelector('.layout-inspection iframe')?.contentDocument;return Boolean(c?.querySelector('header[tabindex="0"]'))&&c.body.innerText.includes('Paused · readings fresh')`, 'actual mounted and fresh Faceplate, not only iframe insertion')
  const card = await world(`const f=d.querySelector('.layout-inspection iframe');return{title:f.title,src:f.src,text:f.contentDocument?.body.innerText}`)
  await record('fresh-hover-can-still-open-existing-faceplate', card)
  await world(`const c=d.querySelector('.layout-inspection iframe'),child=c.contentWindow;child.addEventListener('keydown',e=>{q.inspectionKey={key:e.key,target:e.target?.localName,prevented:e.defaultPrevented,childFocused:c.contentDocument.hasFocus()};queueMicrotask(()=>q.inspectionKey.finalPrevented=e.defaultPrevented)},{capture:true});w.addEventListener('message',e=>{if(e.data?.type==='world:layout-inspection-close')q.inspectionClose={...e.data,origin:e.origin,fromCurrentFrame:e.source===child}},{once:false})`)
  await call('Page.bringToFront'); await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await until(`return !d.querySelector('.layout-inspection iframe')`, 'Escape closes faceplate')
  await record('Escape-closes-mounted-faceplate', await world(`return{key:q.inspectionKey,close:q.inspectionClose,focus:d.activeElement?.className}`))
  }
  const result = { passed: exceptions.length === 0, scope:process.env.LEITBILD_OPACITY_UI_ONLY_ESCAPE==='1'?'mounted-ready-Faceplate-Escape':'opacity-UI-sequence',testedAppCommit: process.env.LEITBILD_LOADING_TESTED_COMMIT, url: info.url, steps, exceptions, instrumentation: Object.fromEntries(await Promise.all(instrumentFiles.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))) }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ output, passed: result.passed, steps: steps.map(step => step.name), exceptions }))
  if (!result.passed) process.exitCode = 1
} catch (error) { await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), steps, exceptions }, null, 2)); console.error(error); process.exitCode = 1 }
finally { socket?.close(); chrome.kill(); await chrome.exited; await rm(profile, { recursive: true, force: true }) }
