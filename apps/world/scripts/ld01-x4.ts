/** TEST-ONLY LD-01 analysis (lane PHYS2, plan r4 X4): the close-out judge of
 * an H1, S1, S2 or R1 case receipt from TURB's `turb_gov_run`
 * (tests/turb_gov.rs). Nothing here is registered in a Pack, the Runtime Hub
 * or the deployer.
 *
 * Reads the pinned `ld01-r4-x4-cases` (RP-pin-x4-r4) and
 * `ld01-operator-budgets` (RP-pin-ogb-r2) blocks, refusing unless their
 * canonical-JSON sha256 equals the pin; `ld01-ou-predicates` r6 from its wiki root and
 * the plant blocks from the head's wiki root; one case receipt and its
 * `ld01-cost` output. It judges, as the pinned lines state:
 * - held: the case's span (3,600 s) reached with no failure, the drive the case names;
 * - mustNot (S, R): U2's list, from the run's instants (trip, relief, CMT, PRHR, bypass kinks);
 * - transient (S, R): U2's PZR pressure, PZR level and SG level bands at every frame;
 * - settled: H1 U1's bands over the whole span and U1's drift ceilings over
 *   the last 1,800 s; S1, S2, R1 U1's cited bands from the change's end +
 *   settle_s to the end (settledAfterLoadChange), with Tavg about the rods' Tref;
 * - steadyWhereNoBand: GEN.WT within 2 % of the held request, each SG
 *   pressure's settled change within 2 % of its mean (no U band);
 * - S2's start: the start receipt's last 1,800 s, GEN.WT within U1's ±2 %
 *   about its request and the governor's setpoint at it;
 * - numerical (R11-3a): the converged level of the series, as ld01-r4-x1-cases;
 * - cost: ld01-cost's worst 0.5 s window ≤ 0.7 and steady ≤ 0.1 (B-prod recorded).
 * A line it cannot evaluate fails; a field the receipt lacks is reported by name.
 *
 * Receipt fields beyond turb_gov's x43-6 receipts (TURB to record):
 * `x4_frames` [{t_s, pzr_roof_pa, pzr_level_m, sg_level_m: [A, B]}] at every
 * 0.1 s frame (the plant quantities PZR.PT, PZR.LT and SG NR acquire), and
 * `families.E_refinement` (the R11-3a series, as s3_cases records it).
 *
 * Usage: bun scripts/ld01-x4.ts --page <operator-grade-budgets.md> --predicates <wiki root holding
 *   ld01-ou-predicates r6> --wiki <the head's wiki root (plant blocks)>
 *   --case H1|S1|S2|R1 --cost <cost.json> [--start <S2 start-state receipt>] <receipt.json>
 * Prints one JSON verdict. */
import {readFileSync} from 'node:fs'
import {canonical, fenced, sha256, BUDGETS_PIN} from './ld01-x1'
import {readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'

export const X4_PIN = {fence: 'ld01-r4-x4-cases', pin: 'RP-pin-x4-r4', sha256: 'd8ab0dc634f5cf3b2d957ffccdbf9ff1b8a7c24c3eb8cf824482804cbef45ee9'}
type J = any
type Line = {id: string, verdict: 'pass' | 'fail' | 'recorded' | 'not evaluable', evidence?: J}

function pinned(text: string, pin: {fence: string, pin: string, sha256: string}): J {
 const b = fenced(text, pin.fence), got = sha256(canonical(b))
 if (got !== pin.sha256) throw new Error(`${pin.fence}: declared sha256 ${got}, ${pin.pin} pins ${pin.sha256}`)
 return b
}
function wikiBlock(root: string, fence: string): J {
 const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [] })
 const hits = walk(root).filter(p => readFileSync(p, 'utf8').includes('```' + fence + '\n'))
 if (hits.length !== 1) throw new Error(`${fence}: ${hits.length} pages hold it`)
 return fenced(readFileSync(hits[0]!, 'utf8'), fence)
}
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN
const MW = 1e6

/** The held load (fraction of the full-power request) and the start's, per case. */
export const LOADS: Record<string, {start: number, held: number}> = {H1: {start: 1, held: 1}, S1: {start: 1, held: 0.9}, S2: {start: 0.9, held: 1}, R1: {start: 1, held: 0.8}}

export type Plant = {pzrSetpoint_Pa: number, level: {fullPower: {loopAverage_K: number, level_m: number}, noLoad: {loopAverage_K: number, level_m: number}},
 nr: {span_m: [number, number]}}

/** The PZR level program at a loop-average Tavg (ld01-pzr-level-program, linear between its two points). */
export const programLevel = (p: Plant['level'], tavg: number) => {
 const {fullPower: f, noLoad: n} = p
 const x = Math.min(Math.max(tavg, n.loopAverage_K), f.loopAverage_K)
 return n.level_m + (f.level_m - n.level_m) * (x - n.loopAverage_K) / (f.loopAverage_K - n.loopAverage_K)
}

export function judge(key: string, r: J, cost: J, cases: J, budgets: J, predicates: J, plant: Plant, start?: J): J {
 const spec = cases.cases?.[key], load = LOADS[key]
 if (!spec || !load) throw new Error(`case ${key} is not an X4 load case this judge reads`)
 const lines: Line[] = [], t0 = r.t0_s as number, span = spec.span_s as number
 const u1 = predicates.predicates.U1, u2 = predicates.predicates.U2
 const series = (r.series ?? []) as J[], rods = (r.rod_series ?? []) as J[], frames = r.x4_frames as J[] | undefined
 // Held, and the drive the case names.
 const steps = (r.steps ?? []) as {at_s: number, fraction: number}[]
 const finalFraction = steps.length ? steps[steps.length - 1]!.fraction : 1
 const drive = key === 'H1' ? steps.length === 0 && r.ramp == null
  : key === 'R1' ? steps.length === 240 && steps.every((s, i) => Math.abs(s.fraction - (1 - 0.05 * (i + 1) / 60)) < 1e-12 && Math.abs(s.at_s - (steps[0]!.at_s + i)) < 1e-9)
  : steps.length === 1 && Math.abs(finalFraction - load.held / load.start) < 1e-12
 lines.push({id: 'held', verdict: r.failure == null && span >= 3600 && r.span_s >= span && Math.abs(r.reached_s - (t0 + r.span_s)) < 1e-9 ? 'pass' : 'fail',
  evidence: {failure: r.failure, span_s: r.span_s, reached_s: r.reached_s, t0_s: t0, case_span_s: span}})
 lines.push({id: 'drive', verdict: drive ? 'pass' : 'fail', evidence: {case_drive: spec.drive, steps: steps.length, first: steps[0] ?? null, last: steps[steps.length - 1] ?? null, ramp: r.ramp ?? null}})
 // The change's end (case clock, from t0) and the settled window.
 const changeEnd = key === 'H1' ? 0 : steps.length ? steps[steps.length - 1]!.at_s : NaN
 const settle = key === 'H1' ? 0 : u2.settle_s as number
 const from = t0 + changeEnd + settle, end = t0 + r.span_s
 const win = <T extends {t_s: number}>(xs: T[], a: number, b = end) => xs.filter(x => x.t_s >= a - 1e-9 && x.t_s <= b + 1e-9)
 // Must-nots (U2), for the load changes.
 if (key !== 'H1') {
  const bad = ((r.run?.instants ?? []) as J[]).filter(e => ((e.kinds ?? []) as string[]).some(k => /trip|hold|relief|crack|safety|CMT|PRHR|bypass/i.test(k)))
  // A bypass opening is a located kink crossing (the band is armed from the TRIP on, so at power
  // none); the series' bypass flow is its algebraic value, recorded beside.
  const dump = ((r.run?.instants ?? []) as J[]).filter(e => /bypass/i.test(JSON.stringify(e)))
  lines.push({id: 'mustNot', verdict: bad.length || dump.length ? 'fail' : 'pass', evidence: {list: u2.mustNot.list, instants: bad.slice(0, 20), bypass_instants: dump.length,
   bypass_abs_max_kg_s: Math.max(0, ...series.map(f => Math.abs(f.bypass_kg_s)))}})
 }
 // Frame quantities the receipt must record.
 const missing = frames == null ? ['x4_frames'] : []
 const sgLevel = (f: J, i: number) => f.sg_level_m?.[i] as number
 if (key !== 'H1') {
  if (missing.length) lines.push({id: 'transient', verdict: 'not evaluable', evidence: {missing}})
  else {
   const b = u2.bands, pt = b.pt1, sp = plant.pzrSetpoint_Pa
   const worst = {pt: Math.max(...frames!.map(f => Math.abs(f.pzr_roof_pa - sp))), ptMax: Math.max(...frames!.map(f => f.pzr_roof_pa)),
    lvl: [Math.min(...frames!.map(f => f.pzr_level_m)), Math.max(...frames!.map(f => f.pzr_level_m))],
    sg: [Math.min(...frames!.flatMap(f => [sgLevel(f, 0), sgLevel(f, 1)])), Math.max(...frames!.flatMap(f => [sgLevel(f, 0), sgLevel(f, 1)]))]}
   const ok = worst.pt <= pt.band_MPa * MW && worst.ptMax < pt.below_MPa * MW && worst.lvl[0]! >= b.pzrLevel_m.within[0] && worst.lvl[1]! <= b.pzrLevel_m.within[1]
    && worst.sg[0]! >= b.sgLevel_m.within[0] && worst.sg[1]! <= b.sgLevel_m.within[1]
   lines.push({id: 'transient', verdict: ok ? 'pass' : 'fail', evidence: {worst, bands: b}})
  }
 }
 // Settled: U1's cited bands over the window.
 const fullRequest = (r.request0_W as number) / load.start, heldRequest = fullRequest * load.held
 const rw = win(rods, from), sw = win(series, from)
 const tavgOf = (f: J) => f.tavg_raw_k as number, trefOf = (f: J) => f.decision?.tref_k as number
 const tavgCenter = (f: J) => key === 'H1' ? u1.bands.Tavg.center_K as number : trefOf(f)
 const tavgDev = rw.filter(f => f.decision).map(f => tavgOf(f) - tavgCenter(f))
 const power = rw.map(f => f.evidence.nuclear as number)
 lines.push({id: 'settled.corePower', verdict: power.length && power.every(p => Math.abs(p - load.held) <= 0.02) ? 'pass' : 'fail',
  evidence: {band: u1.bands.corePower.band, held_fraction: load.held, range: power.length ? [Math.min(...power), Math.max(...power)] : null, reading: 'P_n (fission rate over the hot reference), ±0.02 of the held load'}})
 lines.push({id: 'settled.Tavg', verdict: tavgDev.length && tavgDev.every(d => d <= u1.bands.Tavg.plus_K && d >= -u1.bands.Tavg.minus_K) ? 'pass' : 'fail',
  evidence: {about: key === 'H1' ? 'U1 center' : "the rods' Tref", range: tavgDev.length ? [Math.min(...tavgDev), Math.max(...tavgDev)] : null,
   band: [-u1.bands.Tavg.minus_K, u1.bands.Tavg.plus_K], label: 'plant value (loop average), no TT channel yet'}})
 if (missing.length) lines.push({id: 'settled.primary', verdict: 'not evaluable', evidence: {missing}})
 else {
  const fw = win(frames!, from), sp = plant.pzrSetpoint_Pa
  const nearestTavg = (t: number) => tavgOf(rods.reduce((a, b) => Math.abs(b.t_s - t) < Math.abs(a.t_s - t) ? b : a))
  const pt = fw.map(f => f.pzr_roof_pa - sp), lvl = fw.map(f => f.pzr_level_m - programLevel(plant.level, nearestTavg(f.t_s)))
  const sgSet = plant.nr.span_m[0] + u1.bands.sgLevel.setpoint_NR * (plant.nr.span_m[1] - plant.nr.span_m[0])
  const sg = fw.flatMap(f => [sgLevel(f, 0) - sgSet, sgLevel(f, 1) - sgSet])
  const absMax = (v: number[]) => Math.max(...v.map(Math.abs))
  lines.push({id: 'settled.pzrPressure', verdict: fw.length && absMax(pt) <= u1.bands.pzrPressure.band_MPa * MW ? 'pass' : 'fail', evidence: {max_abs_pa: absMax(pt), band_pa: u1.bands.pzrPressure.band_MPa * MW}})
  lines.push({id: 'settled.pzrLevel', verdict: fw.length && absMax(lvl) <= u1.bands.pzrLevel.band_m ? 'pass' : 'fail', evidence: {max_abs_m: absMax(lvl), band_m: u1.bands.pzrLevel.band_m, about: 'ld01-pzr-level-program at the loop-average Tavg'}})
  lines.push({id: 'settled.sgLevel', verdict: fw.length && absMax(sg) <= u1.bands.sgLevel.band_m ? 'pass' : 'fail', evidence: {max_abs_m: absMax(sg), band_m: u1.bands.sgLevel.band_m, setpoint_m: sgSet}})
 }
 // H1: U1's drift ceilings over the last window_s (the change of the last 60 s
 // mean from the first 60 s mean, per hour).
 if (key === 'H1') {
  const dc = u1.bands.driftCeilings, a = end - dc.window_s, h = dc.window_s / 3600
  const drift = <T extends {t_s: number}>(xs: T[], v: (x: T) => number) => {
   const w = win(xs, a); return (mean(win(w, end - 60).map(v)) - mean(w.filter(x => x.t_s <= a + 60 + 1e-9).map(v))) / h }
  const rows: [string, number, number][] = [['corePower_percent_per_h', 100 * drift(rods, f => f.evidence.nuclear), dc.corePower_percent_per_h],
   ['Tavg_K_per_h', drift(rods, tavgOf), dc.Tavg_K_per_h]]
  if (!missing.length) rows.push(['pt1_MPa_per_h', drift(frames!, f => f.pzr_roof_pa) / MW, dc.pt1_MPa_per_h], ['pzrLevel_m_per_h', drift(frames!, f => f.pzr_level_m), dc.pzrLevel_m_per_h])
  lines.push({id: 'settled.drift', verdict: !missing.length && rows.every(([, x, b]) => Math.abs(x) <= b) ? 'pass' : missing.length ? 'not evaluable' : 'fail',
   evidence: {rows: rows.map(([k, x, b]) => ({k, drift: x, ceiling: b})), missing, method: 'last 60 s mean minus first 60 s mean of the window, per hour'}})
 }
 // Where no U band: GEN.WT about the held request, SG pressure settled (±2 %).
 const f2 = cases.budgets.steadyWhereNoBand as number
 const wt = sw.map(f => f.watt_W as number)
 lines.push({id: 'steady.genWatt', verdict: wt.length && wt.every(w => Math.abs(w - heldRequest) <= f2 * heldRequest) ? 'pass' : 'fail', evidence: {held_request_W: heldRequest, range_W: wt.length ? [Math.min(...wt), Math.max(...wt)] : null, fraction: f2}})
 const sgp = [0, 1].map(i => { const w = sw.map(f => f.sg_pressure_Pa[i] as number), first = mean(w.slice(0, 600)), last = mean(w.slice(-600)); return {first, last, change: last - first} })
 lines.push({id: 'steady.sgPressure', verdict: sw.length && sgp.every(s => Math.abs(s.change) <= f2 * s.last) ? 'pass' : 'fail', evidence: {sg: sgp, reading: 'first and last 60 s means of the settled window, within 2 %'}})
 // S2's start state: power and the governor, not rod motion (lead, 1 Nov).
 if (key === 'S2') {
  if (!start) lines.push({id: 'start', verdict: 'not evaluable', evidence: 'no --start receipt'})
  else {
   const s = start.series as J[], e = start.t0_s + start.span_s, last = s.filter(f => f.t_s >= e - 1800 - 1e-9)
   const req = (start.request0_W as number) * ((start.steps?.at(-1)?.fraction) ?? 1)
   const ok = last.length > 0 && last.every(f => Math.abs(f.watt_W - req) <= 0.02 * fullRequest && Math.abs(f.setpoint_W - req) <= 1e-9 * req)
   lines.push({id: 'start', verdict: ok ? 'pass' : 'fail', evidence: {label: spec.start.label, request_W: req, watt_range_W: last.length ? [Math.min(...last.map(f => f.watt_W)), Math.max(...last.map(f => f.watt_W))] : null, setpoint_at_request: last.every(f => Math.abs(f.setpoint_W - req) <= 1e-9 * req)}})
  }
 }
 // Numerical (R11-3a): as ld01-r4-x1-cases references.
 const comparisons = (r.families?.E_refinement?.comparisons ?? null) as J[] | null
 if (!comparisons) lines.push({id: 'numerical', verdict: 'not evaluable', evidence: {missing: ['families.E_refinement'], rule: cases.budgets.numerical}})
 else {
  const nb = budgets.numerical, levels = [10, 30, 100].map(k => `rtol/${k}`), byName = (n: string) => comparisons.find(c => c.reference === n)
  const done = (n: string) => { const c = byName(n); return c != null && c.reference_failure == null && c.e0?.evaluable === true && t0 + c.e0?.to_s >= end - 1e-9 }
  const rows = (e0: J, fraction: number) => [['pzr_roof_max_abs_pa', e0?.pzr_roof_max_abs_pa, nb.pzrPressure_Pa.budget_Pa], ['pzr_level_m', e0?.metrics?.pzr_level_m?.value, nb.pzrLevel_m.budget_m],
   ['sg_liquid_m3', e0?.metrics?.sg_liquid_m3?.value, nb.sgNrLevel_m.asLiquidVolume_m3], ['sg_pressure_pa', e0?.metrics?.sg_pressure_pa?.value, nb.sgPressure_Pa.budget_Pa],
   ['core_power_relative', e0?.metrics?.core_power_relative?.value, nb.corePowerRelative.budget]].map(([k, x, b]) => ({metric: k, value: x ?? null, bound: fraction * (b as number), pass: e0?.evaluable === true && typeof x === 'number' && x <= fraction * (b as number)}))
  const i = levels.map(done).lastIndexOf(true), conv = levels[i], looser = levels[i - 1]
  if (conv == null || looser == null || !done(looser)) lines.push({id: 'numerical', verdict: 'fail', evidence: {levels: levels.map(n => ({n, done: done(n)}))}})
  else {
   const pair = (r.families.E_refinement.series ?? []).find((x: J) => x.looser === looser && x.tighter === conv)
   const c = rows(pair?.e0, 0.25), v = rows(byName(conv)?.e0, 1)
   lines.push({id: 'numerical', verdict: c.every(x => x.pass) && v.every(x => x.pass) ? 'pass' : 'fail', evidence: {converged: conv, against: looser, convergence: c, run_vs_converged: v}})
  }
 }
 // Cost (ld01-cost).
 const worst = cost?.worst_0_5_s?.rate, steady = cost?.steady
 lines.push({id: 'cost', verdict: typeof worst === 'number' && typeof steady === 'number' ? (worst <= 0.7 && steady <= 0.1 ? 'pass' : 'fail') : 'not evaluable',
  evidence: {worst_0_5_s: worst ?? null, steady: steady ?? null, b_prod: typeof worst === 'number' ? worst <= 0.25 && steady <= 0.05 : null}})
 const verdict = lines.every(l => l.verdict === 'pass' || l.verdict === 'recorded') ? 'X4 pass' : 'X4 fail'
 return {case: key, verdict, cases: X4_PIN, budgets: BUDGETS_PIN, predicates: {revision: predicates.revision, sha256: sha256(canonical(predicates))}, lines}
}

if (import.meta.main) {
 const a = process.argv.slice(2), opt = (k: string, need = true): string | undefined => { const i = a.indexOf(k), v = a[i + 1]; if (i < 0 || v == null) { if (need) throw new Error(`${k} required`); return undefined } a.splice(i, 2); return v }
 const page = readFileSync(opt('--page')!, 'utf8'), predRoot = opt('--predicates')!, root = opt('--wiki')!, key = opt('--case')!, costPath = opt('--cost')!, startPath = opt('--start', false)
 const cases = pinned(page, X4_PIN), budgets = pinned(page, BUDGETS_PIN), predicates = wikiBlock(predRoot, 'ld01-ou-predicates')
 if (String(predicates.revision) !== String(cases.bands.revision).replace(/^r/, '')) throw new Error(`ld01-ou-predicates revision ${predicates.revision}, the lines read ${cases.bands.revision}`)
 const program = wikiBlock(root, 'ld01-pzr-level-program'), nr = wikiBlock(root, 'ld01-sg-level-channels')
 const plant: Plant = {pzrSetpoint_Pa: wikiBlock(root, 'ld01-pzr-pressure-control').setpoint_Pa, level: program, nr: {span_m: nr.nrSpan_m}}
 const [receiptPath, ...rest] = a
 if (!receiptPath || rest.length) throw new Error('one receipt')
 const text = readFileSync(receiptPath, 'utf8')
 console.log(JSON.stringify({receipt: receiptPath, receipt_sha256: sha256(text), cost: costPath,
  ...judge(key, JSON.parse(text), JSON.parse(readFileSync(costPath, 'utf8')), cases, budgets, predicates, plant, startPath ? JSON.parse(readFileSync(startPath, 'utf8')) : undefined)}))
}
