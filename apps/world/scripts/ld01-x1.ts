/** TEST-ONLY LD-01 analysis (lane PHYS, plan r4 X1): the operator-grade judge
 * of a C2, C3 or C5 case receipt. Nothing here is registered in a Pack, the
 * Runtime Hub or the deployer.
 *
 * Reads the pinned `ld01-operator-budgets` and `ld01-r4-x1-cases` blocks
 * (refusing unless their canonical-JSON sha256 equals the pin), the plant
 * blocks the steady references name (from the wiki root), and one gated case
 * receipt run with LD01_PHYS_OPERATOR_FRAMES=1. It judges:
 * - held: the span reached with no failure, labelled end or rule-I exit;
 * - numerical: E0 against R2 (R11-3a's converged reference) within the budgets, R1 reported;
 * - steady: the last 300 s held at the controller's reference or settled;
 * - directions, sequence and must-nots as the cases block lists them.
 * A line it cannot evaluate fails. Cost is ld01-cost's, not judged here.
 *
 * Usage: bun scripts/ld01-x1.ts --page <operator-grade-budgets.md> --wiki <LD-01 wiki root> <receipt.json>...
 * Prints one JSON verdict per receipt. */
import {readFileSync, readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'

export const BUDGETS_PIN = {fence: 'ld01-operator-budgets', pin: 'RP-pin-ogb-r2', sha256: '9def9c2b5bf7d90ea565a8e8d18c077bdb57acda82aa3a997dfc6f4857c736bf'}
export const CASES_PIN = {fence: 'ld01-r4-x1-cases', pin: 'RP-pin-x1-r1', sha256: '4b54cea339b9289ad70a59703bb8b67c3e023f9a6cf4211bfd7a464c90d14ee3'}

type J = any
/** The harness's canonical JSON (s2_harness::guards::canonical): sorted keys, no spaces. */
export function canonical(v: J): string {
 if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
 if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
 return JSON.stringify(v)
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export function fenced(text: string, fence: string): J {
 const m = text.match(new RegExp('```' + fence + '\\n([\\s\\S]*?)\\n```'))
 if (!m) throw new Error(`no ${fence} block`)
 return JSON.parse(m[1])
}
function pinned(text: string, pin: {fence: string, pin: string, sha256: string}): J {
 const b = fenced(text, pin.fence), got = sha256(canonical(b))
 if (got !== pin.sha256) throw new Error(`${pin.fence}: declared sha256 ${got}, ${pin.pin} pins ${pin.sha256 || '(unset)'}`)
 return b
}
function wikiBlock(root: string, fence: string): J {
 const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [] })
 const hits = walk(root).filter(p => readFileSync(p, 'utf8').includes('```' + fence + '\n'))
 if (hits.length !== 1) throw new Error(`${fence}: ${hits.length} pages hold it`)
 return fenced(readFileSync(hits[0], 'utf8'), fence)
}

type Line = {id: string, verdict: 'pass' | 'fail' | 'recorded' | 'not evaluable', evidence?: J}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
const within = (t: number | null | undefined, w: [number, number], tol = 1e-6) => t != null && t >= w[0] - tol && t <= w[1] + tol

/** One receipt's X1 verdict. */
export function judge(receipt: J, budgets: J, cases: J, plant: {pzrSetpoint: number, noLoad: number, reliefMid: number}): J {
 const key = receipt.case as string, spec = cases.cases?.[key]
 if (!spec) throw new Error(`case ${key} is not an X1 case`)
 const tl = receipt.timeline, run = receipt.run, zero = tl.zero_s as number
 const lines: Line[] = []
 // Held.
 const held = run.failure == null && run.labelled_end == null && run.rule_i?.exit == null && tl.end_s >= cases.held_s - 1e-9
 lines.push({id: 'held', verdict: held ? 'pass' : 'fail', evidence: {failure: run.failure, labelled_end: run.labelled_end, rule_i_exit: run.rule_i?.exit ?? null, end_after_zero_s: tl.end_s, held_s: cases.held_s}})
 // Numerical: E0 against R2, which must complete the span; R1 reported (R4-X1-REF).
 const nb = budgets.numerical, op = run.phys_operator_frames
 const loopNominals: number[] = op ? Object.values(op.observed?.references ?? {}).map((r: J) => r?.nominal_kg_s).filter((x: J) => typeof x === 'number') : []
 const comparisons = (receipt.families?.E_refinement?.comparisons ?? []) as J[]
 const done = (c: J) => c.reference_failure == null && c.e0?.evaluable === true && c.e0?.to_s >= cases.held_s - 1e-9
 const completed = comparisons.filter(c => done(c))
 const numeric = completed.map(c => {
  const m = c.e0.metrics, v = (k: string) => m?.[k]?.value
  const loopBudget = loopNominals.length ? nb.loopFlowFractionOfNominal.budget * Math.min(...loopNominals) : NaN
  const checks: [string, number | undefined, number][] = [
   ['pzr_roof_max_abs_pa', c.e0.pzr_roof_max_abs_pa, nb.pzrPressure_Pa.budget_Pa],
   ['pzr_level_m', v('pzr_level_m'), nb.pzrLevel_m.budget_m],
   ['sg_liquid_m3', v('sg_liquid_m3'), nb.sgNrLevel_m.asLiquidVolume_m3],
   ['sg_pressure_pa', v('sg_pressure_pa'), nb.sgPressure_Pa.budget_Pa],
   ['loop_flow_kg_s', v('loop_flow_kg_s'), loopBudget],
   ['core_power_relative', v('core_power_relative'), nb.corePowerRelative.budget]]
  const rows = checks.map(([k, x, b]) => ({metric: k, value: x ?? null, budget: b, pass: typeof x === 'number' && Number.isFinite(b) && x <= b}))
  return {reference: c.reference, rows, pass: rows.every(r => r.pass)}
 })
 const r2 = numeric.find(n => n.reference === 'R2')
 lines.push({id: 'numerical', verdict: r2 ? (r2.pass ? 'pass' : 'fail') : 'not evaluable',
  evidence: {references_completed: completed.map(c => c.reference), references_failed: comparisons.filter(c => !completed.includes(c)).map(c => ({reference: c.reference, failure: c.reference_failure, to_s: c.e0?.to_s})), numeric}})
 // Steady over the last window.
 const w = budgets.steady.window_s, f = budgets.steady.fraction, end = zero + tl.end_s
 const frames = (run.frames as J[]).filter(r => r.t_s >= end - w - 1e-9)
 const sgNamed = budgets.steady.heldAtReference.sgPressure_Pa[key] as string
 const sgRef = sgNamed?.startsWith('ld01-bypass-no-load') ? plant.noLoad : sgNamed?.startsWith('ld01-sg-relief') ? plant.reliefMid : NaN
 const pt = mean(frames.map(r => r.pzr_roof_pa))
 const sg = (run.frames[0].sg_pressure_pa as J[]).map((_: J, i: number) => mean(frames.map(r => r.sg_pressure_pa[i][1])))
 lines.push({id: 'steady.pzrPressure', verdict: Math.abs(pt - plant.pzrSetpoint) <= f * plant.pzrSetpoint ? 'pass' : 'fail', evidence: {mean_pa: pt, reference_pa: plant.pzrSetpoint}})
 lines.push({id: 'steady.sgPressure', verdict: sg.every(p => Math.abs(p - sgRef) <= f * sgRef) ? 'pass' : 'fail', evidence: {mean_pa: sg, reference_pa: sgRef, reference: sgNamed}})
 if (!op) lines.push({id: 'steady.settled', verdict: 'not evaluable', evidence: 'no phys_operator_frames (LD01_PHYS_OPERATOR_FRAMES=1)'})
 else {
  const of = (op.frames as J[]).filter(r => r.t_s >= end - w - 1e-9), first = of.filter(r => r.t_s <= of[0].t_s + 60 + 1e-9), last = of.filter(r => r.t_s >= end - 60 - 1e-9)
  const scale = (q: string) => q.startsWith('PzrLevel') ? 14 : q.startsWith('SgCollapsedLevel') ? 5 : q.startsWith('LoopFlow') || q.startsWith('Proxy') ? 1 : null
  for (const q of Object.keys(of[0]?.values ?? {})) {
   const s = scale(q); if (s == null) continue
   const d = mean(last.map(r => r.values[q])) - mean(first.map(r => r.values[q]))
   lines.push({id: `steady.settled ${q}`, verdict: Math.abs(d) <= f * s ? 'pass' : 'fail', evidence: {change: d, bound: f * s}})
  }
 }
 // Sequence, may and must-not lines.
 const causes = (tl.causes as [number, string, number][]), hold = tl.holding_lost_s as number | null
 const accepted = (fn: string) => [0, 1, 2].map(d => causes.find(c => c[0] === d && c[1] === fn)?.[2] ?? null)
 const allAt = (fn: string, w: [number, number], from = 0) => { const a = accepted(fn); return {accepted: a, pass: a.every(t => within(t == null ? null : t - from, w))} }
 const elec = (tl.electrical ?? []) as [number, string][]
 const requests = (run.divisions as J[]).flatMap((d, i) => (d.requests ?? []).map((r: J) => ({division: i, ...r, t_case_s: r.t_s - zero})))
 const reliefs = (tl.sg_relief as [string, string, number, number][]).filter(r => r[1] === 'Crack' && r[2] === 1)
 const seats = {seats: tl.seats, last_seat_s: tl.last_seat_s, holding_lost_s: hold}
 const seated = (w: [number, number]) => tl.seats === 52 && hold != null && within(tl.last_seat_s - hold, w)
 const ev: Record<string, (l: J) => Line> = {
  'X2.S1': l => { const a = allAt('LD01.PROT.TG.TRIP', l.window_s); return {id: l.id, verdict: a.pass && within(hold, l.window_s) ? 'pass' : 'fail', evidence: {...a, holding_lost_s: hold}} },
  'X2.S2': l => { const t = elec.find(e => e[1] === 'GCB Open')?.[0]; return {id: l.id, verdict: within(t, l.window_s) ? 'pass' : 'fail', evidence: {gcb_open_s: t ?? null}} },
  'X2.S3': l => { const t = elec.filter(e => / transfer to Reserve complete$/.test(e[1])); return {id: l.id, verdict: t.length === 2 && t.every(e => within(e[0], l.window_s)) ? 'pass' : 'fail', evidence: {transfers: t}} },
  'X2.N1': l => ({id: l.id, verdict: reliefs.length === 0 ? 'pass' : 'fail', evidence: {cracks: reliefs}}),
  'X2.N2': l => { const r = requests.filter(x => x.request === 'PRHR'); return {id: l.id, verdict: r.length ? 'fail' : 'pass', evidence: r} },
  'X2.N3': l => { const r = requests.filter(x => x.request === 'CMT injection'); return {id: l.id, verdict: r.length ? 'fail' : 'pass', evidence: r} },
  'X2.N4': l => { const c = causes.filter(c => c[1] === 'LD01.PROT.PZR.HIGH_PRESSURE'); return {id: l.id, verdict: c.length || tl.pzr_relief_openings.length ? 'fail' : 'pass', evidence: {c, openings: tl.pzr_relief_openings}} },
  'X2.N5': l => { const c = causes.filter(c => c[1] === 'LD01.PROT.PZR.LOW_PRESSURE'); return {id: l.id, verdict: c.length ? 'fail' : 'pass', evidence: c} },
  'X2.N6': l => { const c = causes.filter(c => /LOW_FLOW|UNDERSPEED/.test(c[1])); return {id: l.id, verdict: c.length ? 'fail' : 'pass', evidence: c} },
  'X3.S1': l => { const a = accepted('LD01.PROT.RCS.A1.UNDERSPEED'), first = Math.min(...causes.map(c => c[2]))
   return {id: l.id, verdict: a.every(t => t != null && t === first) && hold != null && a.every(t => Math.abs((t as number) - hold) < 1e-6) ? 'pass' : 'fail', evidence: {accepted: a, first_cause_s: first, holding_lost_s: hold}} },
  'X3.S3': l => { const a = hold == null ? null : allAt('LD01.PROT.TG.TRIP', l.afterHoldingLoss_s, hold); return {id: l.id, verdict: a?.pass ? 'pass' : 'fail', evidence: a} },
  'X3.M1': l => ({id: l.id, verdict: 'recorded', evidence: causes.filter(c => c[1] === 'LD01.PROT.RCS.A.LOW_FLOW')}),
  'X3.N1': l => { const a = accepted('LD01.PROT.RCS.A1.UNDERSPEED').filter((t): t is number => t != null), t1 = a.length ? Math.min(...a) : Infinity
   const before = causes.filter(c => c[2] < t1 - 1e-9); return {id: l.id, verdict: before.length ? 'fail' : 'pass', evidence: before} },
  'X3.N2': l => { const c = causes.filter(c => c[1] === 'LD01.PROT.RCS.B.LOW_FLOW' || /RCS\.B[12]\.UNDERSPEED/.test(c[1])); return {id: l.id, verdict: c.length ? 'fail' : 'pass', evidence: c} },
  'X5.S1': l => { const o1 = (run.lines ?? receipt.lines ?? []).find((x: J) => x.id === 'C5.O1'); return {id: l.id, verdict: o1 ? (o1.verdict === 'pass' ? 'pass' : 'fail') : 'not evaluable', evidence: o1?.evidence ?? null} },
  'X5.S2': l => { const e = elec.find(x => /LD01\.TG\.GEN\.FIELD\.SUPPLY_LOSS/.test(x[1])); return {id: l.id, verdict: within(e?.[0], l.window_s) ? 'pass' : 'fail', evidence: e ?? null} },
  'X5.S3': l => { const t = elec.find(x => /LD01\.TG\.GEN\.FIELD\.SUPPLY_LOSS/.test(x[1]))?.[0]; const a = t == null ? null : allAt('LD01.PROT.TG.TRIP', l.afterTurbineTripRequest_s, t)
   return {id: l.id, verdict: a?.pass && hold != null && Math.abs(hold - Math.min(...(a.accepted as number[]))) < 1e-6 ? 'pass' : 'fail', evidence: {request_s: t ?? null, ...a, holding_lost_s: hold}} },
  'X5.S4': l => { const o2 = (receipt.lines ?? []).find((x: J) => x.id === 'C5.O2'); const r = o2?.evidence?.routing_record_s as [string, number][] | undefined
   return {id: l.id, verdict: r ? (r.length === 6 && r.every(x => within(x[1], l.window_s)) ? 'pass' : 'fail') : 'not evaluable', evidence: r ?? null} },
  'X5.N2': l => { const n2 = (receipt.lines ?? []).find((x: J) => x.id === 'C5.N2'); return {id: l.id, verdict: n2 ? (n2.verdict === 'pass' ? 'pass' : 'fail') : 'not evaluable', evidence: n2?.evidence ?? null} },
  'X5.N3': l => { const s = (tl.sg_relief as J[]).filter(r => /RELIEF\.2$/.test(r[0]) && r[1] === 'Crack' && r[2] === 1); return {id: l.id, verdict: s.length ? 'fail' : 'pass', evidence: s} },
 }
 const same: Record<string, string> = {'X3.S2': 'seat', 'X2.S4': 'seat', 'X5.S5': 'seat', 'X3.N3': 'X2.N3', 'X3.N4': 'X2.N2', 'X3.N5': 'pzrRelief', 'X3.N6': 'X2.N1', 'X5.N1': 'X2.N3',
  'X5.M1': 'rec', 'X5.M2': 'rec', 'X5.M3': 'rec', 'X5.M4': 'rec'}
 for (const l of [...(spec.sequence ?? []), ...(spec.may ?? []), ...(spec.mustNot ?? [])]) {
  const alias = same[l.id]
  if (ev[l.id]) lines.push(ev[l.id](l))
  else if (alias === 'seat') lines.push({id: l.id, verdict: seated(l.afterHoldingLoss_s) ? 'pass' : 'fail', evidence: seats})
  else if (alias === 'pzrRelief') lines.push({id: l.id, verdict: tl.pzr_relief_openings.length ? 'fail' : 'pass', evidence: tl.pzr_relief_openings})
  else if (alias === 'rec') lines.push({id: l.id, verdict: 'recorded', evidence: {causes: causes.filter(c => c[2] > (hold ?? Infinity)), requests, reliefs, pzr_relief_openings: tl.pzr_relief_openings}})
  else if (alias && ev[alias]) lines.push({...ev[alias](l), id: l.id})
  else lines.push({id: l.id, verdict: 'not evaluable', evidence: 'no evaluator'})
 }
 const verdict = lines.every(l => l.verdict === 'pass' || l.verdict === 'recorded') ? 'X1 pass' : 'X1 fail'
 return {case: key, verdict, budgets: BUDGETS_PIN, cases: CASES_PIN, lines}
}

if (import.meta.main) {
 const a = process.argv.slice(2), opt = (k: string) => { const i = a.indexOf(k); if (i < 0) throw new Error(`${k} required`); const v = a[i + 1]; a.splice(i, 2); return v }
 const page = readFileSync(opt('--page'), 'utf8'), root = opt('--wiki')
 const budgets = pinned(page, BUDGETS_PIN), cases = pinned(page, CASES_PIN)
 const relief = (wikiBlock(root, 'ld01-sg-relief').valves as J[]).find(v => v.role === 'relief')
 const plant = {pzrSetpoint: wikiBlock(root, 'ld01-pzr-pressure-control').setpoint_Pa, noLoad: wikiBlock(root, 'ld01-bypass-no-load').noLoadPressure_Pa,
  reliefMid: (relief.reseatPressure_Pa + relief.crackPressure_Pa) / 2}
 for (const r of a) console.log(JSON.stringify({receipt: r, receipt_sha256: sha256(readFileSync(r, 'utf8')), ...judge(JSON.parse(readFileSync(r, 'utf8')), budgets, cases, plant)}))
}
