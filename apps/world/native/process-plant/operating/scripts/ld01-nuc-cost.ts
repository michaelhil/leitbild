// E-NUC (plan r4) cost-and-equivalence judge for one case: base receipt against change receipt (ungated S3 previews,
// stock weights, MR-1 off, LD01_OU_FRAME_COST=1). Cost is PERF's ld01-cost (the plan's single measure), run as given.
// Usage: bun ld01-nuc-cost.ts <ld01-cost.ts> <base.json> <change.json> <out.json>
//
// RULE (fixed before the first judged run; this file's sha256 and ld01-cost.ts's go in the output):
//  - cost: worst_0_5_s and steady_last_10_s from ld01-cost; reported with their ratio base/change.
//  - held: run.timeline.end_s (simulated seconds held after zero); a failure of either run is reported.
//  - operator checks, PHYS's ld01-operator-budgets r1 (sha256 e16d9a20...; u/4 of the instrument):
//      at every common 0.1 s frame |dPZR roof| <= 40.3 kPa and |dSG pressure| <= 10.3 kPa;
//      threshold timing within 0.05 s: last rod seat, and every protection-log cause time;
//      the same 52 seats and the same protection causes in the same order.
//    Rod travel is reported, not judged (no LD-01 instrument reads it).
//  - LAND iff change worst <= base worst, change held >= base held and every operator check passes.
import { createHash } from "node:crypto";

const [costPath, basePath, changePath, outPath] = Bun.argv.slice(2);
if (await Bun.file(outPath).exists()) throw new Error("never overwritten");
const sha = async (p: string) => createHash("sha256").update(await Bun.file(p).text()).digest("hex");
const cost = (p: string) => JSON.parse(Bun.spawnSync(["bun", costPath, p]).stdout.toString());
const load = async (p: string) => { const d = await Bun.file(p).json(); return { d, r: d.run ?? d }; };
const base = await load(basePath), change = await load(changePath);
const cb = cost(basePath), cc = cost(changePath);
const frames = (r: any) => new Map<number, any>(r.frames.map((f: any) => [Math.round(f.t_s * 1e6), f]));
const fb = frames(base.r), fc = frames(change.r);
let dP = 0, dSG = 0, dRod = 0, common = 0;
for (const [t, b] of fb) {
  const c = fc.get(t); if (!c) continue; common++;
  dP = Math.max(dP, Math.abs(b.pzr_roof_pa - c.pzr_roof_pa));
  b.sg_pressure_pa.forEach((x: any, i: number) => { dSG = Math.max(dSG, Math.abs(x[1] - c.sg_pressure_pa[i][1])); });
  b.rod_travel_m.forEach((x: number, i: number) => { dRod = Math.max(dRod, Math.abs(x - c.rod_travel_m[i])); });
}
const tb = base.r.timeline, tc = change.r.timeline;
const causes = (r: any) => (r.timeline?.causes ?? []).map((c: any) => [c[1], c[2]]);
const kb = causes(base.r), kc = causes(change.r);
const sameCauses = kb.length === kc.length && kb.every((c: any, i: number) => c[0] === kc[i][0]);
const dCause = sameCauses ? Math.max(0, ...kb.map((c: any, i: number) => Math.abs(c[1] - kc[i][1]))) : Infinity;
const dSeat = Math.abs((tb.last_seat_s ?? NaN) - (tc.last_seat_s ?? NaN));
const checks = {
  pzr_roof_pa: { max: dP, bound: 40.3e3, pass: dP <= 40.3e3 },
  sg_pressure_pa: { max: dSG, bound: 10.3e3, pass: dSG <= 10.3e3 },
  last_seat_s: { diff: dSeat, bound: 0.05, pass: dSeat <= 0.05 },
  causes: { same: sameCauses, max_time_diff_s: dCause, bound: 0.05, pass: sameCauses && dCause <= 0.05 },
  seats: { base: tb.seats, change: tc.seats, pass: tb.seats === 52 && tc.seats === 52 },
  frames_compared: common,
};
const operator = Object.values(checks).every((c: any) => typeof c !== "object" || c.pass !== false);
const held = { base: tb.end_s, change: tc.end_s, failure: { base: base.r.failure ?? null, change: change.r.failure ?? null } };
const land = cc.worst_0_5_s.rate <= cb.worst_0_5_s.rate && tc.end_s >= tb.end_s && operator;
const out = {
  kind: "E-NUC cost judgement", case: base.d.case, judge_sha256: await sha(import.meta.path), cost_sha256: await sha(costPath),
  base: basePath, change: changePath,
  worst_0_5_s: { base: cb.worst_0_5_s, change: cc.worst_0_5_s, ratio: cb.worst_0_5_s.rate / cc.worst_0_5_s.rate },
  steady_last_10_s: { base: cb.steady_last_10_s, change: cc.steady_last_10_s, ratio: cb.steady_last_10_s / cc.steady_last_10_s },
  seat_window: { base: cb.seat_window, change: cc.seat_window },
  average: { base: cb.average, change: cc.average }, restarts: { base: cb.restarts, change: cc.restarts },
  peak_lag_s: { base: cb.peak_lag_s, change: cc.peak_lag_s },
  stock_totals: { base: base.r.stock_totals, change: change.r.stock_totals },
  held, operator_checks: checks, rod_travel_max_diff_m: dRod, operator, land,
};
await Bun.write(outPath, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ case: out.case, worst: [cb.worst_0_5_s.rate, cc.worst_0_5_s.rate], steady: [cb.steady_last_10_s, cc.steady_last_10_s], held: [tb.end_s, tc.end_s], operator, land }));
