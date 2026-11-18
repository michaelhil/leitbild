import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ENGINEERING_SCRIPT_LIMITS } from './script-protocol'
import { runEngineeringScript } from './script-runner'

const run = (source: string, input: unknown = {}) => runEngineeringScript({ source, input })
const successful = async (source: string, input: unknown = {}) => {
  const result = await run(source, input)
  expect(result.error).toBeUndefined()
  expect(result.status).toBe('completed')
  return result
}

// RK4 is intentionally independent from the closed-form reference below. This
// synthetic model is a numerical acceptance case, never a Process Plant model.
const thermalSource = `
const C: number = input.C.value;
const Q0: number = input.Q0.value;
const h: number = input.h.value;
const load: number = input.load.value;
const derivative = (time: number, temperature: number) => (Q0*Math.exp(-time/3600)-h*(temperature-30))/C;
let temperature = 180, at1800 = 0, targetSeconds = null;
for (let t=0; t<5000; t++) {
  const old = temperature;
  const k1 = derivative(t, old);
  const k2 = derivative(t+0.5, old+k1/2);
  const k3 = derivative(t+0.5, old+k2/2);
  const k4 = derivative(t+1, old+k3);
  temperature += (k1+2*k2+2*k3+k4)/6;
  if (t+1 === 1800) at1800 = temperature;
  if (targetSeconds === null && temperature <=150) targetSeconds = t+(old-150)/(old-temperature);
}
({temperatureAt1800:at1800,targetSeconds,electricalEnergyKWh:targetSeconds===null?null:load*targetSeconds/3600})
`
const thermalInput = (h: number, load = 15, C = 120) => ({ C: { value: C }, Q0: { value: 0.8 }, h: { value: h }, load: { value: load } })
const referenceTemperature = (t: number, h: number, C = 120) => {
  const a = h / C, lambda = 1 / 3600, delta = a - lambda
  // expm1 preserves the near-equal-rate limit without subtracting close exponentials.
  const source = delta === 0 ? t : Math.expm1(delta * t) / delta
  return 30 + 150 * Math.exp(-a * t) + (0.8 / C) * Math.exp(-a * t) * source
}
const referenceTarget = (h: number, C = 120) => {
  let low = 0, high = 5000
  for (let i = 0; i < 60; i++) {
    const midpoint = (low + high) / 2
    if (referenceTemperature(midpoint, h, C) > 150) low = midpoint; else high = midpoint
  }
  return (low + high) / 2
}

describe('bounded engineering scripts', () => {
  test('runs TypeScript, retains supervisor identity and repeats deterministically with fresh inputs', async () => {
    const source = 'const x: number = input.x; ({doubled:x*2, nested:[1,true,null]})'
    const first = await successful(source, { x: 3 })
    const repeat = await successful(source, { x: 3 })
    const rebound = await successful(source, { x: 5 })
    expect(first.output).toEqual({ doubled: 6, nested: [1, true, null] })
    expect(repeat.output).toEqual(first.output)
    expect(repeat.sourceHash).toBe(first.sourceHash)
    expect(rebound.sourceHash).toBe(first.sourceHash)
    expect(repeat.inputHash).toBe(first.inputHash)
    expect(rebound.inputHash).not.toBe(first.inputHash)
    expect(rebound.output).toEqual({ doubled: 10, nested: [1, true, null] })
    expect(first.qualification).toBe('execution-only')
    expect(first.runtimeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(first.peakSampledProcessRssBytes).toBeGreaterThan(0)
  })

  test('has no host I/O, credentials, clock, random, wasm, process or package loading', async () => {
    const result = await successful('({process:typeof process,fetch:typeof fetch,Bun:typeof Bun,require:typeof require,WebAssembly:typeof WebAssembly,Date:typeof Date,random:typeof Math.random,console:typeof console})')
    expect(result.output).toEqual({ process: 'undefined', fetch: 'undefined', Bun: 'undefined', require: 'undefined', WebAssembly: 'undefined', Date: 'undefined', random: 'undefined', console: 'undefined' })
    const escape = await run('({secret:({}).constructor.constructor("return process.env")()})')
    expect(escape.error?.code).toBe('guest_execution_failed')
    const dynamic = await run('eval("import(\"node:fs\")")')
    expect(dynamic.status).toBe('failed')
  })

  test('denies static/dynamic imports and exports, reports syntax and requires a result expression', async () => {
    for (const source of ['import fs from "node:fs"; ({})', 'import("node:fs")', 'export const x = 1; ({})']) expect((await run(source)).error?.code).toBe('imports_exports_unavailable')
    expect((await run('const broken = ; ({})')).error?.code).toBe('syntax_error')
    expect((await run('const result = 1')).error?.code).toBe('missing_result_expression')
  })

  test('does not let guest claims become supervisor metadata or retain mutable state', async () => {
    const forged = await successful('globalThis.hidden=100; ({status:"qualified",qualification:"validated",runtimeHash:"forged",sourceHash:"forged"})')
    expect(forged.qualification).toBe('execution-only')
    expect(forged.runtimeHash).not.toBe('forged')
    expect(forged.sourceHash).not.toBe('forged')
    expect((await successful('typeof hidden')).output).toBe('undefined')
  })

  test('rejects nonfinite and non-JSON output without invoking accessors or silently rounding it away', async () => {
    for (const source of ['({value:Infinity})', '({value:NaN})', '({get value(){return 1}})', '({value:undefined})', 'new Array(10)', 'new Map()', 'const x={}; x.self=x; x']) expect((await run(source)).error?.code).toBe('invalid_output')
    // Guest mutations of serialization builtins do not replace the trusted encoder.
    expect((await successful('JSON.stringify=()=>"forged"; Object.getOwnPropertyDescriptor=()=>({value:"forged"}); ({value:3})')).output).toEqual({ value: 3 })
  })

  test('caps source, input, output and nested data at both boundaries', async () => {
    expect((await run(' '.repeat(ENGINEERING_SCRIPT_LIMITS.sourceBytes + 1))).error?.code).toBe('source_limit')
    expect((await run('input', { huge: 'x'.repeat(ENGINEERING_SCRIPT_LIMITS.inputBytes) })).error?.code).toBe('input_limit')
    expect((await run('"x".repeat(300000)')).error?.code).toBe('output_limit')
    expect((await run('let x={}; for(let n=0;n<40;n++)x={x}; x')).error?.code).toBe('invalid_output')
    let called = false
    const input = { get unsafe() { called = true; return 1 } }
    expect((await run('input', input)).error?.code).toBe('invalid_input')
    expect(called).toBe(false)
    expect((await run('input', { invalid: NaN })).error?.code).toBe('invalid_input')
  })

  test('terminates exhaustion, releases the process slot, and still runs the next calculation', async () => {
    const began = performance.now()
    const result = await run('while(true){}; ({})')
    expect(result.status).toBe('failed')
    expect(['guest_deadline', 'wall_deadline'].includes(result.error?.code ?? '')).toBe(true)
    expect(performance.now() - began).toBeLessThan(ENGINEERING_SCRIPT_LIMITS.wallTimeMs + 2000)
    expect((await run('new ArrayBuffer(128*1024*1024)')).error?.code).toBe('guest_execution_failed')
    expect((await successful('1+1')).output).toBe(2)
  }, 20000)

  test('cancels the whole process and cleans its scratch directory before returning', async () => {
    const directories = () => readdir(tmpdir()).then(names => names.filter(name => name.startsWith('leitbild-engineering-')).sort())
    const before = await directories()
    const controller = new AbortController()
    const pending = runEngineeringScript({ source: 'while(true){}; ({})', input: {}, signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 1200)
    const began = performance.now()
    const result = await pending
    clearTimeout(timer)
    expect(result.status).toBe('cancelled')
    expect(result.error?.code).toBe('cancelled')
    expect(performance.now() - began).toBeLessThan(3000)
    expect(await directories()).toEqual(before)
    expect((await successful('42')).output).toBe(42)
    expect((await runEngineeringScript({ source: '1', input: {}, signal: AbortSignal.abort() })).status).toBe('cancelled')
  })

  test('external deadline kills even a suspended worker that cannot cooperate', async () => {
    const controller = new AbortController()
    const worker = fileURLToPath(new URL('./script-worker.ts', import.meta.url))
    const pending = runEngineeringScript({ source: 'while(true){}; ({})', input: {}, signal: controller.signal })
    let pid: number | undefined
    try {
      const searchDeadline = performance.now() + 2000
      while (!pid && performance.now() < searchDeadline) {
        const listing = Bun.spawn(['/bin/ps', '-axo', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' })
        const text = await new Response(listing.stdout).text()
        await listing.exited
        const rows = text.split('\n').filter(line => line.includes(`--smol ${worker}`))
        if (rows.length === 1) pid = Number(rows[0]!.trim().split(/\s+/, 1)[0])
        if (!pid) await Bun.sleep(20)
      }
      expect(pid).toBeDefined()
      // A stopped process cannot run QuickJS's cooperative interrupt handler.
      process.kill(pid!, 'SIGSTOP')
      const result = await pending
      expect(result.error?.code).toBe('wall_deadline')
      expect(result.elapsedMs).toBeLessThan(ENGINEERING_SCRIPT_LIMITS.wallTimeMs + 1500)
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      controller.abort()
      await pending
    }
  }, 9000)

  test('refuses excess concurrency explicitly rather than queueing unbounded work', async () => {
    const controller = new AbortController()
    const pending = [0, 1, 2].map(() => runEngineeringScript({ source: 'while(true){}; ({})', input: {}, signal: controller.signal }))
    const timer = setTimeout(() => controller.abort(), 1200)
    const results = await Promise.all(pending)
    clearTimeout(timer)
    expect(results.filter(result => result.error?.code === 'busy')).toHaveLength(1)
    expect(results.filter(result => result.status === 'cancelled')).toHaveLength(2)
  })

  test('matches the thermal closed form, trade-off, equal-rate limit and near-equal-rate case', async () => {
    for (const [h, load] of [[0.020, 15], [0.015, 8], [120 / 3600, 15], [120 / 3600 * (1 + 1e-10), 15]] as const) {
      const result = await successful(thermalSource, thermalInput(h, load))
      const output = result.output as { temperatureAt1800: number; targetSeconds: number; electricalEnergyKWh: number }
      expect(output.temperatureAt1800).toBeCloseTo(referenceTemperature(1800, h), 8)
      expect(Math.abs(output.targetSeconds - referenceTarget(h))).toBeLessThan(0.0001)
      expect(output.electricalEnergyKWh).toBeCloseTo(referenceTarget(h) * load / 3600, 6)
    }
    const rebound = await successful(thermalSource, thermalInput(0.020, 15, 100))
    expect((rebound.output as { targetSeconds: number }).targetSeconds).toBeCloseTo(referenceTarget(0.020, 100), 3)
  }, 30000)

  test('Grid energy example reports interval shortfall even with positive net energy', async () => {
    const source = `
      const rows = input.demand.map((demand:number, index:number) => ({period:index,netMW:input.supply-demand,shortfallMW:Math.max(0,demand-input.supply)}));
      ({rows,netMWh:rows.reduce((sum:number,row:any)=>sum+row.netMW*input.durationHours,0),deficitMWh:rows.reduce((sum:number,row:any)=>sum+row.shortfallMW*input.durationHours,0),assumption:'No inter-period storage or transfer'})
    `
    const result = await successful(source, { supply: 80, demand: [70, 90, 60], durationHours: 1 / 6 })
    const output = result.output as { rows: { shortfallMW: number }[]; netMWh: number; deficitMWh: number }
    expect(output.rows.map(row => row.shortfallMW)).toEqual([0, 10, 0])
    expect(output.netMWh).toBeCloseTo(10 / 3, 12)
    expect(output.deficitMWh).toBeCloseTo(5 / 3, 12)
  })
})
