// E-NUC (plan r4) T0 judge: compares the replica-grouped operator's zero-time dump with the unreduced one's
// (water-ffi/tests/nuc_t0.rs on both trees, the same saved state converted exactly).
// Usage: bun ld01-nuc-t0.ts <joined-packet.json> <baseline-dump.json> <reduced-dump.json> <receipt.json> [<members.json>]
//
// PASS RULE (fixed before the first judged run; this file's sha256 goes in the receipt):
//  R1 labels: every coordinate outside the grouped blocks keeps its label and order; every grouped coordinate's
//     label names its representative and member count, and the members are the packet's exact replica groups.
//     v2 (E-NUC phase B): with <members.json> (water-ffi nuc_t0_members), the member lists of every grouped
//     coordinate, nuclear and solid, partition the baseline labels, and a nuclear list equals the packet's group.
//  R2b (v2) every member's baseline rows equal its representative's, at both points, within the R2 bound.
//  v3: when the reduced heat and fuel-temperature ports are the solids' half classes (fewer than the carriers),
//     R3 and R5 compare each port with every member carrier (the members of its U_clad coordinate, in the
//     baseline's carrier order); the totals compare as before. (v2's first phase-B run compared them index by
//     index across different lengths: a judge defect, recorded in t0-B-1.)
//  R2 rows, at (y, y') and at (y, 0): |r_red - r_base(rep)| <= 1e-9 (1 + |r_base(rep)|) in solver units.
//  R3 heats per carrier (fuel_w, coolant_w) and the totals (event, released, stored rate):
//     |q_red - q_base| <= 1e-12 max(|q_base|, 1 W).
//  R4 regional reactivities: |rho_red - rho_base| <= 1e-13.
//  R5 the carriers' feedback temperatures: |T_red - T_base| <= 1e-12 T_base.
//  R6 Jacobian (cj 1e3): for every reduced row i and column c, J_red[i][c] = sum over the members a of c of
//     J_base[rep(i)][a] within 1e-9 (1 + sum |J_base[rep(i)][a]|), and no lumped baseline nonzero is missing
//     from the reduced pattern.
// The baseline's own replica spread (members' rows against their representative's) is reported, not judged.
import { createHash } from "node:crypto";

const [packetPath, basePath, redPath, receiptPath, membersPath] = Bun.argv.slice(2);
if (await Bun.file(receiptPath).exists()) throw new Error("receipts are never overwritten");
const self = await Bun.file(import.meta.path).text();
const p = await Bun.file(packetPath).json();
const base = await Bun.file(basePath).json();
const red = await Bun.file(redPath).json();
const f = (h: string) => { const b = new DataView(new ArrayBuffer(8)); b.setBigUint64(0, BigInt("0x" + h)); return b.getFloat64(0); };
const F = (v: string[]) => v.map(f);

// Exact replica groups of the packet, first appearance order (as Nuclear::new).
const src = p.hot.source, meta = p.feedback_metadata, A = src.materials.length, R = src.regions.length;
const keyOf = (a: number) => {
  const ks = src.supports.map((s: any, k: number) => [s, k]).filter(([s]: any) => s.material === a).sort((x: any, y: any) => x[0].region - y[0].region);
  const e = p.hot.energy.carriers[a];
  return JSON.stringify([ks.map(([s, k]: any) => [s.region, meta.supports[k].production_reference_per_s, meta.supports[k].exposure_per_population_s_m2, meta.supports[k].fuel_importance, src.inputs.emission_fractions[k]]),
    meta.materials[a], src.materials[a], src.inputs.outside_fractions[a], e.fissile_atoms, e.fertile_atoms, e.poison_atoms, e.stores_j, src.prepared_state.slice(R + 6 * a, R + 6 * a + 6)]);
};
const index = new Map<string, number>(); const members: number[][] = [];
for (let a = 0; a < A; a++) { const k = keyOf(a); if (!index.has(k)) { index.set(k, members.length); members.push([]); } members[index.get(k)!].push(a); }
const ids = p.hot.energy.carriers.map((c: any) => c.id);

// Label maps: reduced index -> representative baseline index; baseline index -> reduced index.
const bl: string[] = base.labels, rl: string[] = red.labels;
const bIndex = new Map(bl.map((l, i) => [l, i]));
const repOf: number[] = new Array(rl.length); const redOf: number[] = new Array(bl.length).fill(-1);
const failures: string[] = [];
const grouped = /^(C|fissile|fertile|I-135|Xe-135|Pm-149|Sm-149|E|U_fuel|U_clad|T_fuel_surface|T_clad_inner|T_clad_outer|U_helium|U_passive)\[(.+)x(\d+)\](.*)$/;
const nuclearKinds = new Set(["C", "fissile", "fertile", "I-135", "Xe-135", "Pm-149", "Sm-149", "E"]);
const listed: Record<string, string[]> | null = membersPath ? await Bun.file(membersPath).json() : null;
rl.forEach((l, i) => {
  const m = grouped.exec(l);
  if (m && listed) {
    const list = listed[l];
    if (!list || list.length !== Number(m[3])) { failures.push(`R1 members of ${l}`); return; }
    if (nuclearKinds.has(m[1])) {
      const g = members.findIndex(ms => ms[0] === ids.indexOf(m[2]));
      if (g < 0 || JSON.stringify(members[g].map(a => `${m[1]}[${ids[a]}]${m[4]}`)) !== JSON.stringify(list)) { failures.push(`R1 nuclear group ${l}`); return; }
    }
    for (const ml of list) { const j = bIndex.get(ml); if (j === undefined) failures.push(`R1 member ${ml}`); else if (redOf[j] >= 0) failures.push(`R1 member twice ${ml}`); else redOf[j] = i; }
    repOf[i] = bIndex.get(list[0])!;
    return;
  }
  if (!m) { const j = bIndex.get(l); if (j === undefined) failures.push(`R1 label ${l}`); else { repOf[i] = j; redOf[j] = i; } return; }
  const [, kind, rep, count, rest] = m; const a0 = ids.indexOf(rep); const g = members.findIndex(ms => ms[0] === a0);
  if (g < 0 || members[g].length !== Number(count)) { failures.push(`R1 group ${l}`); return; }
  for (const a of members[g]) { const j = bIndex.get(`${kind}[${ids[a]}]${rest}`); if (j === undefined) failures.push(`R1 member ${kind}[${ids[a]}]${rest}`); else redOf[j] = i; }
  repOf[i] = bIndex.get(`${kind}[${rep}]${rest}`)!;
});
if (redOf.some(v => v < 0)) failures.push(`R1 ${redOf.filter(v => v < 0).length} baseline coordinates unmapped`);
// Order outside the grouped blocks.
const plain = rl.map((l, i) => [l, i] as const).filter(([l]) => !grouped.test(l));
for (let k = 1; k < plain.length; k++) if (repOf[plain[k][1]] <= repOf[plain[k - 1][1]]) { failures.push(`R1 order at ${plain[k][0]}`); break; }

const owner = (l: string) => { const m = grouped.exec(l); return m ? (nuclearKinds.has(m[1]) ? "nuclear" : "solids") : /^N\[/.test(l) ? "nuclear" : "other"; };
const worst: Record<string, any> = {};
const book = (rule: string, d: number, scale: number, bound: number, where: string) => {
  const w = worst[rule] ?? (worst[rule] = { max_abs: 0, max_ratio_to_bound: 0, at: null, judged: 0 });
  w.judged++; if (Math.abs(d) > w.max_abs) w.max_abs = Math.abs(d);
  const ratio = Math.abs(d) / bound; if (ratio > w.max_ratio_to_bound) { w.max_ratio_to_bound = ratio; w.at = where; }
  if (!(Math.abs(d) <= bound)) failures.push(`${rule} ${where}: ${d} against ${bound} (scale ${scale})`);
};
const spread: Record<string, number> = {};
for (const point of ["at_state", "at_zero_rates"]) {
  const rb = F(base[point].rows), rr = F(red[point].rows);
  rr.forEach((v, i) => { const b = rb[repOf[i]]; book(`R2 rows ${point} ${owner(rl[i])}`, v - b, b, 1e-9 * (1 + Math.abs(b)), rl[i]); });
  rb.forEach((v, j) => { const b = rb[repOf[redOf[j]]]; const d = Math.abs(v - b) / (1 + Math.abs(b)); spread[point] = Math.max(spread[point] ?? 0, d);
    if (listed) book(`R2b member rows ${point}`, v - b, b, 1e-9 * (1 + Math.abs(b)), bl[j]); });
  // Port of each baseline carrier: itself, or (phase B) the solids half class holding it.
  const portOf = (n: number): number[] => {
    if (n === A) return [...Array(A).keys()];
    if (!listed) { failures.push("R3 ports without members"); return []; }
    const halves = rl.filter(l => /^U_clad\[/.test(l));
    const carrierOf = new Map(bl.filter(l => /^U_clad\[/.test(l)).map((l, a) => [l, a]));
    const out = new Array(A).fill(-1);
    halves.forEach((l, k) => (listed[l] ?? []).forEach(m => { const a = carrierOf.get(m); if (a !== undefined) out[a] = k; }));
    if (halves.length !== n || out.some(v => v < 0)) failures.push("R3 port map");
    return out;
  };
  for (const k of ["fuel_w", "coolant_w", "totals_w"]) { const b = F(base[point][k]), r = F(red[point][k]);
    const map = k === "totals_w" ? b.map((_, i) => i) : portOf(r.length);
    b.forEach((x, i) => book(`R3 ${k}`, r[map[i]] - x, x, 1e-12 * Math.max(Math.abs(x), 1), `${point}[${i}]`)); }
  { const b = F(base[point].reactivity), r = F(red[point].reactivity); b.forEach((x, i) => book("R4 reactivity", r[i] - x, x, 1e-13, `${point}[${i}]`)); }
  { const b = F(base[point].fuel_feedback_k), r = F(red[point].fuel_feedback_k); const map = portOf(r.length);
    b.forEach((x, i) => book("R5 fuel feedback", r[map[i]] - x, x, 1e-12 * x, `${point}[${i}]`)); }
}
// R6: Jacobian lumping.
const csc = (j: any) => ({ p: j.pointers as number[], i: j.indices as number[], v: F(j.values) });
const jb = csc(base.jacobian), jr = csc(red.jacobian);
if (base.jacobian.cj !== red.jacobian.cj) failures.push("R6 cj");
const lumped = new Map<number, { sum: number; abs: number }>(); // key = i_red * n + c_red over baseline rows that are representatives
const n = rl.length; const isRep = new Set(repOf);
const repRow = new Map(repOf.map((j, i) => [j, i]));
for (let a = 0; a < bl.length; a++) for (let k = jb.p[a]; k < jb.p[a + 1]; k++) {
  const row = jb.i[k]; if (!isRep.has(row)) continue;
  const key = repRow.get(row)! * n + redOf[a]; const e = lumped.get(key) ?? { sum: 0, abs: 0 }; e.sum += jb.v[k]; e.abs += Math.abs(jb.v[k]); lumped.set(key, e);
}
const seen = new Set<number>();
for (let c = 0; c < n; c++) for (let k = jr.p[c]; k < jr.p[c + 1]; k++) {
  const key = jr.i[k] * n + c; seen.add(key); const e = lumped.get(key) ?? { sum: 0, abs: 0 };
  book(`R6 jacobian ${owner(rl[jr.i[k]])} row`, jr.v[k] - e.sum, e.sum, 1e-9 * (1 + e.abs), `${rl[jr.i[k]]} / ${rl[c]}`);
}
let missing = 0; for (const [key, e] of lumped) if (!seen.has(key) && e.sum !== 0) { missing++; if (missing <= 5) failures.push(`R6 missing ${rl[Math.floor(key / n)]} / ${rl[key % n]} = ${e.sum}`); }

const receipt = {
  kind: "E-NUC T0 judgement", judge_sha256: createHash("sha256").update(self).digest("hex"),
  packet: packetPath, baseline: basePath, reduced: redPath,
  coordinates: [bl.length, rl.length], groups: members.length, group_sizes: members.map(m => m.length),
  jacobian_nonzeros: [jb.i.length, jr.i.length], worst, baseline_replica_spread: spread, missing_lumped_nonzeros: missing,
  failures: failures.slice(0, 50), failure_count: failures.length, verdict: failures.length === 0 ? "PASS" : "FAIL",
};
await Bun.write(receiptPath, JSON.stringify(receipt, null, 1));
console.log(JSON.stringify({ verdict: receipt.verdict, failure_count: failures.length, coordinates: receipt.coordinates, nnz: receipt.jacobian_nonzeros, judge: receipt.judge_sha256 }));
