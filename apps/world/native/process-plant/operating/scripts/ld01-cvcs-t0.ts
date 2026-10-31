// Plan r4 X4.2 (lane NUC): the CVCS owner's zero-time judge, over one dump of tests/cvcs_t0.rs.
// Usage: bun ld01-cvcs-t0.ts <dump.json> <out.json>
//
// RULE v2 (fixed before the second judged dump; this file's sha256 goes in the output). v1 (sha256 9e69c71f...,
// dump t0-1) probed G10's exact-absence coordinates (each leg cell's vapor mass at exactly zero), which have
// no difference derivative on either side, and failed R4 on them alone: a judge defect, recorded.
// v2 excludes them from R4 as G10 does (their analytic columns are R3's comparison) and requires each such
// column to be refused on both sides, so the exclusion cannot hide a defined derivative.
//  R1 layout: 14 CVCS coordinates, every one differential, multiplicity 1 (a single), row scale = scale.
//  R2 tracked point: at the CVCS rates consistent with the state, every controller rate (level and
//     loop-average lags, both flow lags, integrals and stems) is at most 1e-9 in solver units
//     (physical rate / scale): the controller starts at its own steady point.
//  R3 assemblies: every entry with its row or column in the CVCS block agrees between the block and
//     the colored assembly within 1e-8 of its column's largest entry.
//  R4 derivative: on every probed column (each CVCS coordinate; each coordinate of COLD.A, of the leg
//     cells and of the PZR cell), the block assembly agrees with G10's one-sided Richardson difference
//     on the judged rows (the CVCS rows and COLD.A's rows) within 1e-6 max(1, |fd|_inf), on at least
//     one side (a continuous clamp corner within one step has its one-sided derivative on the other).
//  R5 account: every identity closes within the S2 gates' identityRelative 1e-9 (the CVCS tanks' mass
//     and absorber, the primary's mass and absorber, the unit's energy among them).
//  PASS iff R1-R5.
import { createHash } from "node:crypto";

const [dumpPath, outPath] = Bun.argv.slice(2);
if (!dumpPath || !outPath) throw new Error("usage: ld01-cvcs-t0.ts <dump> <out>");
if (await Bun.file(outPath).exists()) throw new Error("never overwritten");
const sha = async (p: string) => createHash("sha256").update(await Bun.file(p).text()).digest("hex");
const d = await Bun.file(dumpPath).json();

const L = d.layout;
const r1 = {
  count: L.labels.length,
  differential: L.differential.every((v: boolean) => v),
  singles: L.multiplicity.every((m: number) => m === 1),
  rowScales: L.scales.every((s: number, i: number) => s === L.row_scales[i]),
};
const R1 = r1.count === 14 && r1.differential && r1.singles && r1.rowScales;

const control = d.coordinates_and_rates.slice(6);
const r2 = control.map((c: any[], k: number) => ({ label: c[0], value: c[1], solver_rate: c[2] / L.scales[6 + k] }));
const r2max = Math.max(...r2.map((c: any) => Math.abs(c.solver_rate)));
const R2 = r2max <= 1e-9;

const r3 = d.assembly.cvcs;
const R3 = r3.max_rel <= 1e-8;

const absent = d.difference_columns.filter((c: any) => c.exact_absence === true);
const absentRefused = absent.every((c: any) => Object.values(c.sides).every((v: any) => v.refused));
const r4 = d.difference_columns.filter((c: any) => c.exact_absence === false).map((c: any) => {
  const sides = Object.entries(c.sides).map(([side, v]: [string, any]) => {
    if (v.refused) return { side, refused: v.refused, pass: false };
    const bound = 1e-6 * Math.max(1, v.fd_norm);
    return { side, diff: v.judged_rows.max_abs_diff, bound, pass: v.judged_rows.max_abs_diff <= bound, row: v.judged_rows.row };
  });
  return { label: c.label, column: c.column, sides, pass: sides.some((s: any) => s.pass) };
});
const R4 = r4.length > 0 && r4.every((c: any) => c.pass) && absentRefused
  && d.difference_columns.every((c: any) => typeof c.exact_absence === "boolean");
const worst4 = r4.flatMap((c: any) => c.sides.filter((s: any) => !s.refused).map((s: any) => ({ label: c.label, column: c.column, ...s, ratio: s.diff / s.bound })))
  .sort((a: any, b: any) => b.ratio - a.ratio).slice(0, 5);

const ids = d.account.identities;
const r5 = Object.entries(ids).map(([name, v]: [string, any]) => ({ name, relative: v.relative, pass: v.relative <= 1e-9 }));
const R5 = r5.every((i) => i.pass) && r5.some((i) => i.name === "cvcs_mass") && r5.some((i) => i.name === "cvcs_boron");

const out = {
  kind: "plan r4 X4.2 CVCS zero-time judgement", judge_sha256: await sha(import.meta.path), dump: dumpPath, dump_sha256: await sha(dumpPath),
  state: d.state, packet: d.packet, t_s: d.t_s,
  R1: { pass: R1, ...r1 },
  R2: { pass: R2, max_solver_rate: r2max, rates: r2 },
  R3: { pass: R3, ...r3, all_entries: d.assembly.all },
  R4: { pass: R4, columns: r4.length, failed: r4.filter((c: any) => !c.pass), worst: worst4,
    exact_absence: { columns: absent.map((c: any) => [c.label, c.column]), all_refused_both_sides: absentRefused } },
  R5: { pass: R5, identities: r5 },
  modes: d.modes,
  flows_and_stocks: d.coordinates_and_rates.map((c: any[]) => ({ label: c[0], value: c[1], rate: c[2] })),
  pass: R1 && R2 && R3 && R4 && R5,
};
await Bun.write(outPath, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ pass: out.pass, R1, R2: [R2, r2max], R3: [R3, r3.max_rel], R4: [R4, worst4[0]], R5: [R5, Math.max(...r5.map((i) => i.relative))] }));
