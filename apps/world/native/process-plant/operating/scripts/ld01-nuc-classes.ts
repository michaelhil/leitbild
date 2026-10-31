// NUC census helper (plan r4, E-NUC): carrier replica classes of a joined packet and the within-class spread of a saved 18,708-coordinate state.
// Usage: bun ld01-nuc-classes.ts <joined-packet.json> <saved-state.json>
const [packetPath, statePath] = Bun.argv.slice(2);
const p = await Bun.file(packetPath).json();
const st = await Bun.file(statePath).json();
const src = p.hot.source, meta = p.feedback_metadata;
const R = src.regions.length, A = src.materials.length;
const sig: string[][] = Array.from({ length: A }, () => []);
src.supports.forEach((s: any, k: number) => {
  const m = meta.supports[k];
  sig[s.material].push(JSON.stringify([s.region, m.production_reference_per_s, m.exposure_per_population_s_m2, src.inputs.emission_fractions[k]]));
});
const mats = meta.materials, car = p.hot.energy.carriers;
const key = (a: number) => JSON.stringify([sig[a].sort(), mats[a].reference_fissile_atoms, mats[a].reference_xenon_atoms, mats[a].reference_samarium_atoms, car[a].fertile_atoms, src.inputs.outside_fractions[a]]);
const cls = new Map<string, number[]>();
for (let a = 0; a < A; a++) { const k = key(a); cls.set(k, [...(cls.get(k) ?? []), a]); }
console.log("regions", R, "carriers", A, "classes", cls.size, "sizes", [...cls.values()].map(v => v.length).join(","));
const off = 271; // network block size at STAGE (census: 193 cells + 74 faces + 4 rotors)
const y: number[] = st.y;
const idx = { C: (a: number, g: number) => off + R + 6 * a + g, M: (a: number, k: number) => off + R + 6 * A + 6 * a + k, E: (a: number, g: number) => off + R + 12 * A + 25 * a + g };
let worst: Record<string, number> = { C: 0, M: 0, E: 0 };
for (const members of cls.values()) {
  const a0 = members[0];
  for (const a of members.slice(1)) {
    for (const [f, n] of [["C", 6], ["M", 6], ["E", 25]] as const) for (let g = 0; g < n; g++) {
      const u = y[idx[f](a0, g)], v = y[idx[f](a, g)];
      const d = Math.abs(u - v) / Math.max(Math.abs(u), Math.abs(v), 1e-300);
      if (d > worst[f]) worst[f] = d;
    }
  }
}
console.log("worst within-class relative spread in the saved state", worst);
// Solids: per band 3 energies, then 3 surfaces per band (STAGE layout, solids offset = 271 + 14306).
const so = off + R + 37 * A;
let ws = { U: 0, T: 0 };
let distinctU = new Set<string>();
for (const members of cls.values()) {
  const a0 = members[0];
  for (const a of members) {
    distinctU.add(JSON.stringify([0,1,2].map(k => y[so + 3 * a + k])));
    for (let k = 0; k < 3; k++) {
      const du = Math.abs(y[so + 3 * a0 + k] - y[so + 3 * a + k]) / Math.abs(y[so + 3 * a0 + k]);
      const dt = Math.abs(y[so + 3 * A + 3 * a0 + k] - y[so + 3 * A + 3 * a + k]) / Math.abs(y[so + 3 * A + 3 * a0 + k]);
      ws.U = Math.max(ws.U, du); ws.T = Math.max(ws.T, dt);
    }
  }
}
console.log("solids within-class spread", ws, "distinct band energy triples", distinctU.size);
const he = so + 6 * A, pa = he + 193, sg = pa + 1351;
console.log("distinct helium", new Set(y.slice(he, pa)).size, "distinct passive", new Set(y.slice(pa, sg)).size, "sg metal", y.slice(sg, sg + 8).length);
const th = p.thermal ?? {};
console.log("thermal keys", Object.keys(th));
