// E-NUC: a saved r4 state (rods in the packet layout, sector-share bore groups) re-laid for a composition that declares
// cluster <single> single: the single's group splits into its other members and the single's own new group (appended,
// first appearance). Each group's water solver scale is its members' share, so both parts keep the group's solver values
// in y and y' exactly: the split appends a copy of the group's [M, U, B, p]. Refused when the single shares no group.
// Usage: bun ld01-nuc-split-single.ts <joined-packet.json> <state.json> <single> <rods offset> <out.json>
const [pp, sp, single, off, out] = Bun.argv.slice(2);
if (await Bun.file(out).exists()) throw new Error("never overwritten");
const p = await Bun.file(pp).json(), st = await Bun.file(sp).json();
const shares = p.rods.clusters.map((c: any) => JSON.stringify(c.sector_shares));
const first: number[] = []; const group = shares.map((s: string, c: number) => { const g = first.findIndex(f => shares[f] === s); if (g >= 0) return g; first.push(c); return first.length - 1; });
const s = Number(single), g = group[s], n = shares.length, G = first.length;
if (group.filter((x: number) => x === g).length < 2) throw new Error("the single has no group to leave");
const water = Number(off) + 4 * n, at = water + 4 * G;
const split = (v: any[]) => [...v.slice(0, at), ...v.slice(water + 4 * g, water + 4 * g + 4), ...v.slice(at)];
for (const k of ["y", "yp", "y_bits", "yp_bits"]) st[k] = split(st[k]);
st.split_single = { from: sp, single: s, group: g, appended_at: at, rule: "the single's bore group's [M, U, B, p] copied (solver values are per-member equal); members' clusters unchanged" };
await Bun.write(out, JSON.stringify(st));
console.log(JSON.stringify({ single: s, group: g, groups: G, length: st.y.length }));
