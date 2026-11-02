/** TEST-ONLY LD-01 analysis (lane PHYS2): the judge of the stuck-cluster C2
 * case (C2S, `ld01-r4-c2-stuck-case` r1, RP-pin-c2s-r1). Nothing here is
 * registered in a Pack, the Runtime Hub or the deployer.
 *
 * Refuses unless the C2S lines, X1's case lines (RP-pin-x1-r6) and the
 * operator budgets (RP-pin-ogb-r2) equal their pins. X1's C2 lines are judged
 * by ld01-x1.ts's own `judge` (the judge of record, unchanged) with X2.S4
 * left out, as the C2S `base` states; then the C2S lines:
 * - XS.S4: the 51 other clusters seated, the last within 2.5 s after the
 *   holding loss; the stuck cluster not seated;
 * - XS.S5: the stuck cluster's travel at every frame within 0.001 m of its start;
 * - XS.B1: exactly one nuclear B1 entry, at the last seat's instant, of
 *   ld01-stuck-worth's term_dk exactly;
 * - XS.SD: no accepted state not subcritical at or after the B1 instant,
 *   for every P1 factor (rule I's last_not_subcritical_s);
 * - XS.R1: recorded: the term beside the DCD-scaled stuck worth.
 * Receipt paths (WORLD3's c2s dry run): run.stuck_cluster.{travel_m, seats,
 * b1, stuck_worth}, run.rule_i.hot_standby_margins.last_not_subcritical_s,
 * timeline.zero_s. A line it cannot evaluate fails.
 *
 * Usage: bun scripts/ld01-c2s.ts --page <operator-grade-budgets.md> --wiki <LD-01 wiki root> <receipt.json>... */
import {readFileSync, readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {BUDGETS_PIN, CASES_PIN, canonical, fenced, judge as judgeX1, sha256} from './ld01-x1'

export const C2S_PIN = {fence: 'ld01-r4-c2-stuck-case', pin: 'RP-pin-c2s-r1', sha256: 'f909732e9b5e87ce79ef75f5fd99fa9b0bc54547f8ef59816624b7d3c91e2347'}
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

export function judge(receipt: J, c2s: J, x1: J, budgets: J, plant: J, worth: J): J {
 if (receipt.case !== 'C2') throw new Error(`a C2S receipt runs case C2, not ${receipt.case}`)
 const run = receipt.run, sc = run?.stuck_cluster, zero = receipt.timeline.zero_s as number
 const config = run?.configuration?.case_configuration ?? receipt.configuration?.case_configuration
 const id = c2s.cluster.id as string
 // X1's C2 lines without X2.S4 (C2S's base).
 const base = {...x1, cases: {C2: {...x1.cases.C2, sequence: (x1.cases.C2.sequence as J[]).filter(l => l.id !== 'X2.S4')}}}
 const x1Verdict = judgeX1(receipt, budgets, base, plant)
 const lines: Line[] = [...(x1Verdict.lines as Line[])]
 lines.push({id: 'configuration', verdict: config?.single === id && config?.stuck === true && sc?.cluster === id ? 'pass' : 'fail',
  evidence: {case_configuration: config ?? null, stuck_cluster: sc?.cluster ?? null}})
 const has = (k: string, x: unknown) => x == null ? (lines.push({id: k, verdict: 'not evaluable', evidence: 'receipt field missing'}), false) : true
 const xs = Object.fromEntries((c2s.lines as J[]).map(l => [l.id, l]))
 // XS.S4.
 const seats = sc?.seats
 if (has('XS.S4', seats)) {
  const afterHold = seats.others_last_seat_s - (seats.holding_lost_s - zero)
  const stuckSeat = (seats.per_cluster as J[]).find(c => c.cluster === id)
  lines.push({id: 'XS.S4', verdict: seats.others_seated === 51 && seats.single_seated === false && (stuckSeat == null || stuckSeat.count === 0) && afterHold >= -1e-9 && afterHold <= 2.5 + 1e-9 ? 'pass' : 'fail',
   evidence: {others_seated: seats.others_seated, single_seated: seats.single_seated, last_seat_after_holding_loss_s: afterHold, what: xs['XS.S4'].what}})
 }
 // XS.S5.
 const travel = sc?.travel_m
 if (has('XS.S5', travel?.frames)) {
  const dev = Math.max(...(travel.frames as [number, number][]).map(([, y]) => Math.abs(y - travel.start_m)))
  const last = (travel.frames as [number, number][]).at(-1)?.[0] ?? null
  lines.push({id: 'XS.S5', verdict: dev <= 0.001 && last != null && last >= zero + receipt.timeline.end_s - 0.1 - 1e-9 ? 'pass' : 'fail',
   evidence: {start_m: travel.start_m, max_deviation_m: dev, frames: travel.frames.length, last_frame_s: last, tolerance_m: 0.001}})
 }
 // XS.B1.
 const b1 = (sc?.b1 ?? null) as J[] | null, lastSeat = seats ? zero + seats.others_last_seat_s : NaN
 if (has('XS.B1', b1)) {
  const e = b1!.filter(x => x.owner === 'nuclear' && x.B1)
  const ok = e.length === 1 && b1!.length === 1 && Math.abs(e[0].B1.t_s - lastSeat) <= 1e-9 && e[0].B1.stuck_worth_dk === worth.term_dk && sc.stuck_worth?.term_dk === worth.term_dk
  lines.push({id: 'XS.B1', verdict: ok ? 'pass' : 'fail', evidence: {entries: b1, last_seat_s: lastSeat, term_dk: worth.term_dk, declared: sc.stuck_worth ?? null}})
 }
 // XS.SD.
 const m = run?.rule_i?.hot_standby_margins
 if (has('XS.SD', m?.last_not_subcritical_s)) {
  const t1 = b1?.[0]?.B1?.t_s as number | undefined
  const ok = t1 != null && (m.last_not_subcritical_s as (number | null)[]).every(t => t == null || t < t1 - 1e-9)
  lines.push({id: 'XS.SD', verdict: ok ? 'pass' : 'fail', evidence: {factors: m.factors, last_not_subcritical_s: m.last_not_subcritical_s, b1_s: t1 ?? null,
   not_subcritical: m.not_subcritical, margin_evaluations: m.margin_evaluations, smallest_margin_dk_k: m.smallest_margin_dk_k}})
 }
 // XS.R1 (recorded).
 lines.push({id: 'XS.R1', verdict: 'recorded', evidence: {term_dk: worth.term_dk, dcd_scaled_dk: worth.ap1000StuckFraction * worth.allInWorth_dk,
  model_stuck_worth_fully_out_dk: worth.modelStuckWorth_dk, note: 'the model\'s own worth at the start pose is ROD x44-2\'s (0.091 %), not this receipt\'s'}})
 const verdict = lines.every(l => l.verdict === 'pass' || l.verdict === 'recorded') ? 'C2S pass' : 'C2S fail'
 return {case: 'C2S', verdict, c2s: C2S_PIN, x1: CASES_PIN, budgets: BUDGETS_PIN, lines}
}

if (import.meta.main) {
 const a = process.argv.slice(2), opt = (k: string): string => { const i = a.indexOf(k), v = a[i + 1]; if (i < 0 || v == null) throw new Error(`${k} required`); a.splice(i, 2); return v }
 const page = readFileSync(opt('--page'), 'utf8'), root = opt('--wiki')
 const c2s = pinned(page, C2S_PIN), x1 = pinned(page, CASES_PIN), budgets = pinned(page, BUDGETS_PIN)
 const relief = (wikiBlock(root, 'ld01-sg-relief').valves as J[]).find(v => v.role === 'relief')
 const plant = {pzrSetpoint: wikiBlock(root, 'ld01-pzr-pressure-control').setpoint_Pa, noLoad: wikiBlock(root, 'ld01-bypass-no-load').noLoadPressure_Pa,
  reliefMid: (relief.reseatPressure_Pa + relief.crackPressure_Pa) / 2, pzrReliefOpening: wikiBlock(root, 'ld01-pzr-relief-device').openingPressure_Pa}
 const worth = wikiBlock(root, 'ld01-stuck-worth')
 for (const r of a) { const text = readFileSync(r, 'utf8'); console.log(JSON.stringify({receipt: r, receipt_sha256: sha256(text), ...judge(JSON.parse(text), c2s, x1, budgets, plant, worth)})) }
}
