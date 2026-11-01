/** TEST-ONLY LD-01 analysis (lane PHYS3, plan r4 X4): the judge of the trip
 * cases T1-T5 held 3,600 s at hot standby, as `ld01-r4-x4-cases` r4
 * (RP-pin-x4-r4) states them. Nothing here is registered in a Pack, the
 * Runtime Hub or the deployer.
 *
 * Refuses unless the X4 lines, X1's case lines (RP-pin-x1-r6), the operator
 * budgets (RP-pin-ogb-r2) and, for T4, the C2S lines (RP-pin-c2s-r1) equal
 * their pins, and `ld01-ou-predicates` is the revision the X4 lines read. Each
 * case is judged on one s3_cases receipt held to its span (3,600 s):
 * - drive: the receipt runs the case's event (T1 C2, T2 a manual reactor
 *   trip, T3 C3, T4 C2 with the stuck cluster, T5 C5);
 * - "X1 lines": ld01-x1.ts's `judge` with X1's held span set to the case's
 *   span, so held, numerical (R11-3a over the whole span) and the last-300 s
 *   steady lines read the 3,600 s run. T1 C2's lines, T3 C3's, T5 C5's (X5.P1-
 *   X5.P3 over the run's own last 300 s); T4 ld01-c2s.ts's lines;
 * - T2, "as T1 with the turbine trip 5.0-5.3 s after the holding loss": C2's
 *   lines with X2.S1 replaced by T2.S1 (LD01.PROT.TG.TRIP accepted in I1-I3
 *   5.0-5.3 s after the holding loss, X3.S3's rule). C2's breaker and transfer
 *   windows (X2.S2, X2.S3) and its SG pressure direction are timed from C2's
 *   turbine trip (its zero); here from the turbine trip's breaker request
 *   ("GCB OPEN requested by the turbine trip"). Reading, labelled;
 * - U3: the hot-standby bands (Tavg per loop and their mean, SG pressure,
 *   PZR pressure, PZR level) at every frame from +600 s to the end, and the
 *   always-limits at every frame of the receipt;
 * - T4: subcritical at every frame-judged admission after the last seat
 *   (rule I's last_not_subcritical_s before it, every P1 factor; OU-D's U3
 *   reading), the counts recorded;
 * - cost: ld01-cost's worst 0.5 s window <= 0.7 and steady <= 0.1 (B-prod recorded).
 * A line it cannot evaluate fails.
 *
 * Usage: bun scripts/ld01-x4t.ts --page <operator-grade-budgets.md> --predicates <wiki root holding
 *   ld01-ou-predicates r6> --wiki <the head's wiki root (plant blocks)> --case T1|T2|T3|T4|T5
 *   --cost <ld01-cost output json> <receipt.json>
 * Prints one JSON verdict. */
import {readFileSync, readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {BUDGETS_PIN, CASES_PIN, canonical, fenced, judge as judgeX1, sha256} from './ld01-x1'
import {C2S_PIN, judge as judgeC2S} from './ld01-c2s'
import {X4_PIN} from './ld01-x4'

type J = any
type Line = {id: string, verdict: 'pass' | 'fail' | 'recorded' | 'not evaluable', evidence?: J}
const MPa = 1e6
/** "U3 hot-standby bands from +600 s to the end" (the T1 line). */
export const BANDS_AFTER_S = 600
const BASE: Record<string, string> = {T1: 'C2', T2: 'C2', T3: 'C3', T4: 'C2', T5: 'C5'}

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
const range = (v: number[]) => v.length ? [Math.min(...v), Math.max(...v)] : null

/** U3's hot-standby bands from zero + `after` to the end, and its always-limits at every frame. */
export function u3Lines(receipt: J, u3: J, after = BANDS_AFTER_S): Line[] {
 const run = receipt.run, zero = receipt.timeline.zero_s as number, from = zero + after, b = u3.hotStandbyBands
 const frames = (run.frames ?? []) as J[], settled = frames.filter(f => f.t_s >= from - 1e-9)
 const legs = run.feed_leg_temperatures_k, col = (n: string) => (legs?.columns ?? []).indexOf(n)
 const op = run.phys_operator_frames, lq = op ? Object.keys(op.frames?.[0]?.values ?? {}).find(q => q.startsWith('PzrLevel')) : undefined
 const lines: Line[] = []
 // Tavg: (Th + Tc)/2 per loop and their mean (tavgDefinition), about the no-load centre.
 if (legs == null || ['HOT.A', 'HOT.B', 'COLD.A', 'COLD.B'].some(n => col(n) < 0)) lines.push({id: 'U3.Tavg', verdict: 'not evaluable', evidence: {missing: 'run.feed_leg_temperatures_k HOT/COLD A/B'}})
 else {
  const rows = ((legs.rows ?? []) as [number, number[]][]).filter(([t]) => t >= from - 1e-9)
  const loop = (x: number[], l: string) => (x[col(`HOT.${l}`)]! + x[col(`COLD.${l}`)]!) / 2
  const dev = {A: rows.map(([, x]) => loop(x, 'A') - b.Tavg.center_K), B: rows.map(([, x]) => loop(x, 'B') - b.Tavg.center_K),
   mean: rows.map(([, x]) => (loop(x, 'A') + loop(x, 'B')) / 2 - b.Tavg.center_K)}
  const ok = rows.length > 0 && Object.values(dev).every(v => v.every(d => d <= b.Tavg.plus_K && d >= -b.Tavg.minus_K))
  lines.push({id: 'U3.Tavg', verdict: ok ? 'pass' : 'fail', evidence: {frames: rows.length, center_K: b.Tavg.center_K, band_K: [-b.Tavg.minus_K, b.Tavg.plus_K],
   deviation_K: {A: range(dev.A), B: range(dev.B), mean: range(dev.mean)}, label: 'plant value (loop average), no TT channel yet'}})
 }
 const sg = settled.flatMap(f => (f.sg_pressure_pa as [string, number][]).map(x => x[1]))
 lines.push({id: 'U3.sgPressure', verdict: settled.length && sg.every(p => p >= (b.sgPressure.center_MPa - b.sgPressure.minus_MPa) * MPa && p <= (b.sgPressure.center_MPa + b.sgPressure.plus_MPa) * MPa) ? 'pass' : 'fail',
  evidence: {range_pa: range(sg), band_pa: [(b.sgPressure.center_MPa - b.sgPressure.minus_MPa) * MPa, (b.sgPressure.center_MPa + b.sgPressure.plus_MPa) * MPa]}})
 const pt = settled.map(f => f.pzr_roof_pa as number)
 lines.push({id: 'U3.pzrPressure', verdict: settled.length && pt.every(p => Math.abs(p - b.pzrPressure.center_MPa * MPa) <= b.pzrPressure.band_MPa * MPa) ? 'pass' : 'fail',
  evidence: {range_pa: range(pt), center_pa: b.pzrPressure.center_MPa * MPa, band_pa: b.pzrPressure.band_MPa * MPa}})
 // PZR level: the J-CVCS band when the receipt ran the joined CVCS (it records cvcs_frames).
 const cvcs = run.cvcs_frames != null, band = cvcs ? b.pzrLevel.band_m_withJCVCS : b.pzrLevel.band_m_untilJCVCS
 if (!lq) lines.push({id: 'U3.pzrLevel', verdict: 'not evaluable', evidence: {missing: 'PzrLevel operator frames'}})
 else {
  const lv = (op.frames as J[]).filter(f => f.t_s >= from - 1e-9).map(f => f.values[lq] as number)
  lines.push({id: 'U3.pzrLevel', verdict: lv.length && lv.every(l => Math.abs(l - b.pzrLevel.center_m) <= band) ? 'pass' : 'fail',
   evidence: {range_m: range(lv), center_m: b.pzrLevel.center_m, band_m: band, cvcs_joined: cvcs, quantity: lq}})
 }
 // Always-limits, every frame.
 const sgAll = frames.flatMap(f => (f.sg_pressure_pa as [string, number][]).map(x => x[1])), ptAll = frames.map(f => f.pzr_roof_pa as number)
 lines.push({id: 'U3.always.sgPressure', verdict: frames.length && Math.max(...sgAll) < b.sgPressure.alwaysBelow_MPa * MPa ? 'pass' : 'fail', evidence: {max_pa: frames.length ? Math.max(...sgAll) : null, below_pa: b.sgPressure.alwaysBelow_MPa * MPa}})
 lines.push({id: 'U3.always.pzrPressure', verdict: frames.length && Math.min(...ptAll) > b.pzrPressure.alwaysAbove_MPa * MPa ? 'pass' : 'fail', evidence: {min_pa: frames.length ? Math.min(...ptAll) : null, above_pa: b.pzrPressure.alwaysAbove_MPa * MPa}})
 if (!lq) lines.push({id: 'U3.always.pzrLevel', verdict: 'not evaluable', evidence: {missing: 'PzrLevel operator frames'}})
 else {
  const all = (op.frames as J[]).map(f => f.values[lq] as number)
  lines.push({id: 'U3.always.pzrLevel', verdict: all.length && Math.min(...all) > b.pzrLevel.alwaysAbove_m ? 'pass' : 'fail', evidence: {min_m: all.length ? Math.min(...all) : null, above_m: b.pzrLevel.alwaysAbove_m}})
 }
 return lines
}

/** T2's turbine-trip-timed lines in place of C2's X2.S1-X2.S3 and SG pressure direction. */
function rodTripLines(receipt: J, x1Lines: Line[], c2: J): Line[] {
 const tl = receipt.timeline, zero = tl.zero_s as number, hold = tl.holding_lost_s as number | null
 const elec = (tl.electrical ?? []) as [number, string][], causes = (tl.causes ?? []) as [number, string, number][]
 const tr = elec.find(e => e[1] === 'GCB OPEN requested by the turbine trip')?.[0] ?? null
 const within = (t: number | null | undefined, w: [number, number]) => t != null && t >= w[0] - 1e-6 && t <= w[1] + 1e-6
 const shift = (w: [number, number]): [number, number] => tr == null ? [NaN, NaN] : [w[0] + tr, w[1] + tr]
 const spec = (id: string) => (c2.sequence as J[]).find(l => l.id === id)
 const acc = [0, 1, 2].map(d => causes.find(c => c[0] === d && c[1] === 'LD01.PROT.TG.TRIP')?.[2] ?? null)
 const reading = 'C2 times X2.S2, X2.S3 and the SG pressure rise from its turbine trip (zero); T2 from the turbine trip\'s breaker request (PHYS3 reading)'
 const gcb = elec.find(e => e[1] === 'GCB Open')?.[0], transfers = elec.filter(e => / transfer to Reserve complete$/.test(e[1]))
 const s2 = shift(spec('X2.S2').window_s), s3 = shift(spec('X2.S3').window_s)
 const sgAt = (t: number) => (receipt.run.frames as J[]).reduce((b: J, r: J) => Math.abs(r.t_s - t) < Math.abs(b.t_s - t) ? r : b).sg_pressure_pa.map((x: J) => x[1] as number)
 const after = (receipt.run.frames as J[]).filter(r => r.t_s >= zero), max = Math.max(...after.flatMap(r => r.sg_pressure_pa.map((x: J) => x[1])))
 const rose = tr != null && sgAt(zero + tr + 5).every((p: number, i: number) => p > sgAt(zero + tr)[i]!)
 return [
  {id: 'T2.S1', verdict: hold != null && acc.every(t => within(t == null ? null : t - hold, [5, 5.3])) ? 'pass' : 'fail',
   evidence: {what: 'LD01.PROT.TG.TRIP accepted in I1-I3 5.0-5.3 s after the holding loss (R12-A2; X3.S3\'s rule)', accepted: acc, holding_lost_s: hold}},
  {id: 'T2.S2', verdict: within(gcb, s2) ? 'pass' : 'fail', evidence: {what: spec('X2.S2').what, gcb_open_s: gcb ?? null, turbine_trip_request_s: tr, window_s: s2, reading}},
  {id: 'T2.S3', verdict: transfers.length === 2 && transfers.every(e => within(e[0], s3)) ? 'pass' : 'fail', evidence: {what: spec('X2.S3').what, transfers, turbine_trip_request_s: tr, window_s: s3, reading}},
  {id: 'T2.direction.sgPressure', verdict: rose && max < 7947559 ? 'pass' : 'fail', evidence: {turbine_trip_request_s: tr, at_request: tr == null ? null : sgAt(zero + tr), at_5_s: tr == null ? null : sgAt(zero + tr + 5), max_after: max, below: 7947559, reading}},
  ...x1Lines.filter(l => l.id !== 'direction.sgPressure')]
}

export function judge(key: string, receipt: J, cost: J, x4: J, x1: J, budgets: J, predicates: J, plant: J, c2s?: J, worth?: J): J {
 const spec = x4.cases?.[key], base = BASE[key]
 if (!spec || !base) throw new Error(`case ${key} is not an X4 trip case (T1-T5)`)
 const span = spec.span_s as number, held = {...x1, held_s: span}, run = receipt.run
 const cfg = run?.configuration?.case_configuration ?? receipt.configuration?.case_configuration
 const command = run?.configuration?.command ?? null
 const drive = key === 'T2' ? command === 'ManualReactorTrip' && cfg?.stuck !== true
  : key === 'T4' ? receipt.case === 'C2' && cfg?.stuck === true : receipt.case === base && cfg?.stuck !== true
 const lines: Line[] = [{id: 'drive', verdict: drive ? 'pass' : 'fail', evidence: {expects: key === 'T2' ? 'command ManualReactorTrip' : key === 'T4' ? 'C2 with the stuck cluster' : base,
  receipt_case: receipt.case ?? null, command, stuck: cfg?.stuck ?? null, what: spec.what}}]
 if (key === 'T4') {
  if (!c2s || !worth) throw new Error('T4 needs the C2S lines and ld01-stuck-worth')
  lines.push(...(judgeC2S(receipt, c2s, held, budgets, plant, worth).lines as Line[]))
  const m = run?.rule_i?.hot_standby_margins, seats = run?.stuck_cluster?.seats, zero = receipt.timeline.zero_s as number
  const lastSeat = seats?.others_last_seat_s == null ? null : zero + seats.others_last_seat_s
  const last = m?.last_not_subcritical_s as (number | null)[] | undefined
  lines.push({id: 'T4.subcritical', verdict: lastSeat != null && Array.isArray(last) && last.length === (m.factors ?? []).length && last.every(t => t == null || t < lastSeat - 1e-9) ? 'pass' : 'fail',
   evidence: {reading: 'every frame-judged admission after the last seat subcritical, every P1 factor (OU-D U3: margins after the last rod seats)', last_seat_s: lastSeat,
    factors: m?.factors ?? null, last_not_subcritical_s: last ?? null, not_subcritical: m?.not_subcritical ?? null, margin_evaluations: m?.margin_evaluations ?? null, smallest_margin_dk_k: m?.smallest_margin_dk_k ?? null}})
 } else if (key === 'T2') {
  const c2 = x1.cases.C2, without = {...held, cases: {C2: {...c2, sequence: (c2.sequence as J[]).filter(l => !['X2.S1', 'X2.S2', 'X2.S3'].includes(l.id))}}}
  lines.push(...rodTripLines(receipt, judgeX1({...receipt, case: 'C2'}, budgets, without, plant).lines as Line[], c2))
 } else lines.push(...(judgeX1(receipt, budgets, held, plant).lines as Line[]))
 lines.push(...u3Lines(receipt, predicates.predicates.U3))
 const worst = cost?.worst_0_5_s?.rate, steady = cost?.steady
 lines.push({id: 'cost', verdict: typeof worst === 'number' && typeof steady === 'number' ? (worst <= 0.7 && steady <= 0.1 ? 'pass' : 'fail') : 'not evaluable',
  evidence: {worst_0_5_s: worst ?? null, steady: steady ?? null, b_prod: typeof worst === 'number' ? worst <= 0.25 && steady <= 0.05 : null, cost_receipt: cost?.receipt ?? null}})
 const verdict = lines.every(l => l.verdict === 'pass' || l.verdict === 'recorded') ? 'X4 pass' : 'X4 fail'
 return {case: key, verdict, cases: X4_PIN, x1: CASES_PIN, budgets: BUDGETS_PIN, ...(key === 'T4' ? {c2s: C2S_PIN} : {}),
  predicates: {revision: predicates.revision, sha256: sha256(canonical(predicates))}, lines}
}

if (import.meta.main) {
 const a = process.argv.slice(2), opt = (k: string): string => { const i = a.indexOf(k), v = a[i + 1]; if (i < 0 || v == null) throw new Error(`${k} required`); a.splice(i, 2); return v }
 const page = readFileSync(opt('--page'), 'utf8'), predRoot = opt('--predicates'), root = opt('--wiki'), key = opt('--case'), costPath = opt('--cost')
 const x4 = pinned(page, X4_PIN), x1 = pinned(page, CASES_PIN), budgets = pinned(page, BUDGETS_PIN), predicates = wikiBlock(predRoot, 'ld01-ou-predicates')
 if (String(predicates.revision) !== String(x4.bands.revision).replace(/^r/, '')) throw new Error(`ld01-ou-predicates revision ${predicates.revision}, the lines read ${x4.bands.revision}`)
 const relief = (wikiBlock(root, 'ld01-sg-relief').valves as J[]).find(v => v.role === 'relief')
 const plant = {pzrSetpoint: wikiBlock(root, 'ld01-pzr-pressure-control').setpoint_Pa, noLoad: wikiBlock(root, 'ld01-bypass-no-load').noLoadPressure_Pa,
  reliefMid: (relief.reseatPressure_Pa + relief.crackPressure_Pa) / 2, pzrReliefOpening: wikiBlock(root, 'ld01-pzr-relief-device').openingPressure_Pa}
 const t4 = key === 'T4' ? {c2s: pinned(page, C2S_PIN), worth: wikiBlock(root, 'ld01-stuck-worth')} : {}
 const [receiptPath, ...rest] = a
 if (!receiptPath || rest.length) throw new Error('one receipt')
 const text = readFileSync(receiptPath, 'utf8')
 console.log(JSON.stringify({receipt: receiptPath, receipt_sha256: sha256(text), cost: costPath,
  ...judge(key, JSON.parse(text), JSON.parse(readFileSync(costPath, 'utf8')), x4, x1, budgets, predicates, plant, t4.c2s, t4.worth)}))
}
