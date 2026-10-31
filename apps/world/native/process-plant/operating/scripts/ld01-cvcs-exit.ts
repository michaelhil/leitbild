// Plan r4 X4.2 (lane NUC): the CVCS exit judge, the wiki's "CVCS exit rule (pinned before the runs)"
// (claude/ld01-r4-cvcs-wiki c0010d0, inventory-and-chemistry.md), with its cost gate.
// Usage: bun ld01-cvcs-exit.ts <ld01-cost.ts> hold|c2 <CVCS receipt> <base receipt (same case without the CVCS)> <out.json>
//
// RULE v2 (lead 1 Nov: a new X4 system is gated on the per-unit budget, its added cost reported; the wiki's revised
// cost row, claude/ld01-r4-cvcs-wiki-r4c 200d516). v1 (87c65e28...) judged "not above base"; its runs stay recorded.
// RULE (fixed before the first judged run; this file's sha256 and ld01-cost.ts's go in the output):
//  Reads run.cvcs_frames (per frame [t, the CVCS block's physical coordinates]: labels CVCS.LT.lag at 6,
//  CVCS.CHARGE.FT.lag at 8 and CVCS.LETDOWN.FT.lag at 12 (v2's 16-coordinate layout),
//  CVCS.TAVG.lag at 7, BLEND.M at 0, RECEIVER.M at 4), the section's program and band, run.failure,
//  run.start_state.t_s, run.timeline.zero_s. L_set(T) is the program: linear between its points,
//  constant outside them. The level error of a frame is |L - L_set(T)| of its lagged level and loop average.
//  hold: no failure; the last frame at or after start + 600 s; every frame's level error <= band_m (0.1 m).
//  c2:   no failure; the last frame at or after zero + 600 s; the last frame at or after zero + 600 s has a
//        level error <= band_m; the net makeup over the run, charged less let down
//        = -(dM_BLEND + dM_RECEIVER) (no source transfer in either run), is > 0.
//  Both: cost by ld01-cost: the CVCS run's steady (last 10 s) <= 0.1 and its worst 0.5 s window <= 0.7 (the
//        per-unit budget); the base run's (the same case on the same head without the CVCS) is reported beside it.
//  PASS iff every check of the kind holds.
import { createHash } from "node:crypto";

const [costPath, kind, changePath, basePath, outPath] = Bun.argv.slice(2);
if (!costPath || !["hold", "c2"].includes(kind ?? "") || !changePath || !basePath || !outPath)
  throw new Error("usage: ld01-cvcs-exit.ts <ld01-cost.ts> hold|c2 <cvcs receipt> <base receipt> <out>");
if (await Bun.file(outPath).exists()) throw new Error("never overwritten");
const EPS = 1e-6;
const sha = async (p: string) => createHash("sha256").update(await Bun.file(p).text()).digest("hex");
const cost = (p: string) => JSON.parse(Bun.spawnSync(["bun", costPath, p]).stdout.toString());
const run = async (p: string) => { const d = await Bun.file(p).json(); return d.run ?? d; };
const r = await run(changePath), b = await run(basePath);
const cf = r.cvcs_frames;
if (!cf) throw new Error("the CVCS receipt has no cvcs_frames");
const { program, controller } = cf.section;
const band = controller.band_m;
const setpoint = (t: number) => {
  const a = program.noLoad, f = program.fullPower;
  const x = Math.min(1, Math.max(0, (t - a.loopAverage_K) / (f.loopAverage_K - a.loopAverage_K)));
  return a.level_m + (f.level_m - a.level_m) * x;
};
const frames = cf.frames.map(([t, x]: [number, number[]]) => ({ t, level: x[6], tavg: x[7], setpoint: setpoint(x[7]), error: Math.abs(x[6] - setpoint(x[7])),
  blend: x[0], receiver: x[4], charge_ft: x[8], letdown_ft: x[12] }));
const start = r.start_state.t_s, zero = r.timeline.zero_s;
const last = frames[frames.length - 1];
const checks: Record<string, any> = { no_failure: r.failure == null };
if (kind === "hold") {
  checks.span_ok = last.t >= start + 600 - EPS;
  const worst = frames.reduce((w: any, f: any) => (f.error > w.error ? f : w), frames[0]);
  checks.level_on_program = frames.every((f: any) => f.error <= band);
  checks.worst_level_error = worst;
} else {
  checks.span_ok = last.t >= zero + 600 - EPS;
  const after = frames.find((f: any) => f.t >= zero + 600 - EPS);
  checks.frame_after_600_s = after ?? null;
  checks.level_on_program_at_600_s = !!after && after.error <= band;
  const first = frames[0];
  checks.net_makeup_kg = -((last.blend - first.blend) + (last.receiver - first.receiver));
  checks.charged_kg = first.blend - last.blend;
  checks.let_down_kg = last.receiver - first.receiver;
  checks.shrink_made_up = checks.net_makeup_kg > 0;
}
const kc = cost(changePath), kb = cost(basePath);
checks.steady_within_budget = kc.steady_last_10_s <= 0.1;
checks.worst_within_budget = kc.worst_0_5_s.rate <= 0.7;
checks.added_cost = { worst_0_5_s: kc.worst_0_5_s.rate - kb.worst_0_5_s.rate, steady_last_10_s: kc.steady_last_10_s - kb.steady_last_10_s,
  average: kc.average - kb.average };
const levels = frames.map((f: any) => f.level), errors = frames.map((f: any) => f.error);
const pass = Object.values(checks).every((v) => typeof v !== "boolean" || v);
const out = {
  kind: `plan r4 X4.2 CVCS exit judgement (${kind})`, judge_sha256: await sha(import.meta.path), cost_sha256: await sha(costPath),
  change: changePath, change_sha256: await sha(changePath), base: basePath, base_sha256: await sha(basePath),
  checks, pass,
  report: { level_min_max_m: [Math.min(...levels), Math.max(...levels)], level_error_max_m: Math.max(...errors), last_frame: last,
    cost: { change: kc, base: kb } },
};
await Bun.write(outPath, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ kind, pass, checks: Object.fromEntries(Object.entries(checks).filter(([, v]) => typeof v !== "object")),
  worst: [kc.worst_0_5_s.rate, kb.worst_0_5_s.rate], steady: kc.steady_last_10_s }));
