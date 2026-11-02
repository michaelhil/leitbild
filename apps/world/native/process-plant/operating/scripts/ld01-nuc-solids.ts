// NUC census helper (plan r4, E-NUC): are carriers of one nuclear class also identical in their solids parameters, and the FA-level classes.
// Usage: bun ld01-nuc-solids.ts <joined-packet.json>
const [packetPath] = Bun.argv.slice(2);
const p = await Bun.file(packetPath).json();
const src = p.hot.source, meta = p.feedback_metadata, t = p.thermal;
const A = src.materials.length;
const sig: string[][] = Array.from({ length: A }, () => []);
src.supports.forEach((s: any, k: number) => { const m = meta.supports[k]; sig[s.material].push(JSON.stringify([s.region, m.production_reference_per_s, m.exposure_per_population_s_m2, src.inputs.emission_fractions[k], m.fuel_importance])); });
const strip = (o: any) => JSON.stringify(o, (k, v) => (k === "id" || k.endsWith("_id") || k.endsWith("_ids") || k === "helium") ? undefined : v);
const contacts: string[][] = Array.from({ length: A }, () => []);
for (const c of t.core_contacts) contacts[c.band].push(JSON.stringify([c.water, c.area_m2, c.hydraulic_diameter_m, c.flow_area_m2]));
const carrierKey = (a: number) => JSON.stringify([sig[a].sort(), meta.materials[a], strip(p.hot.energy.carriers[a]), strip(t.fuel_bands[a]), contacts[a].sort()]);
const classes = new Map<string, number[]>();
for (let a = 0; a < A; a++) { const k = carrierKey(a); classes.set(k, [...(classes.get(k) ?? []), a]); }
console.log("carrier classes incl. band+contacts", classes.size);
const cOf = new Array(A); [...classes.values()].forEach((m, c) => m.forEach(a => cOf[a] = c));
// FA level: the two halves' classes, helium, passive stores of the FA and their contacts.
const fa = (id: string) => id.split("/")[0];
const byFa = new Map<string, any>();
t.fuel_bands.forEach((b: any, a: number) => { const f = fa(b.id); const e = byFa.get(f) ?? { halves: [], passive: [] }; e.halves.push([b.id.split("/").slice(1).join("/"), cOf[a]]); byFa.set(f, e); });
t.helium.forEach((h: any) => byFa.get(fa(h.id)).helium = strip(h));
const pc = new Map<string, string[]>();
for (const c of t.passive_contacts) pc.set(c.store_id, [...(pc.get(c.store_id) ?? []), strip(c)]);
const nonFa: string[] = [];
t.passive_stores.forEach((s: any) => { const e = byFa.get(fa(s.id)); const v = JSON.stringify([s.id.split("/").slice(1).join("/"), strip(s), (pc.get(s.id) ?? []).sort()]); if (e) e.passive.push(v); else nonFa.push(s.id); });
const faClasses = new Map<string, number>();
for (const e of byFa.values()) { e.passive.sort(); const k = JSON.stringify(e); faClasses.set(k, (faClasses.get(k) ?? 0) + 1); }
console.log("FA", byFa.size, "FA classes", faClasses.size, "sizes", [...faClasses.values()].join(","), "passive stores outside an FA", nonFa.length, "plenum contacts", t.plenum_contacts.length);
console.log("passive stores per FA", [...byFa.values()][0].passive.length);
