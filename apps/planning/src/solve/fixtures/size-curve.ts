// Test support: or's size-curve subsets of twin v3 (R/or/inc1/size-curve.ts, per maint's size-curve spec of
// 11 Nov), rebuilt from the committed twin v3 fixture with or's generator unchanged, so a test needs no file
// from the review folder. Each subset's sha256 is or's recorded one (R/or/inc1/size/size-curve-hashes.txt):
// a mismatch means the subset is not or's frozen one.
import twinV3 from './twin-v3.json'

/* eslint-disable @typescript-eslint/no-explicit-any */
const v3: any = twinV3
export const SIZE_CURVE_SHA256 = {
  S33v3: '9f230591cce50320a0618d9538048c0b4aaa7db41dd045d60035d2474758ac1d',
  S60: '1cd07705eee18a30f72eaf72a9dd30f3b1036785e741812382e62ca210c919c0',
  S100: 'e3a9b022e1b74eacb4a681408770f5b5a5ae732504746d84bc3ec093843d6297',
  S130: '102b11ab385b041d27ea39f42d7d86b9e23ea0a78ec6a4b62e20cc78c8abd463',
} as const
export type SizeCurveName = keyof typeof SIZE_CURVE_SHA256

const ms = (id: string) => /\.(start|end)$/.test(id)
const rpm = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => `U1-RPM${String(lo + i).padStart(3, '0')}`)
const bop = (items: string[]) => v3.activities.map((a: { id: string }) => a.id).filter((id: string) => items.some(it => id.startsWith(`U1-${it}-`)))
const cl = (hi: number) => v3.activities.map((a: { id: string }) => a.id).filter((id: string) => { const m = /^U1-CL(\d\d)-/.exec(id); return m !== null && Number(m[1]) <= hi })
const trainA = v3.activities.map((a: { id: string }) => a.id).filter((id: string) => id.startsWith('U1-') && !/^U1-(CP|CTF|IAC|CWP|CL|RPM)/.test(id) && !ms(id))
const specs: Record<SizeCurveName, { jobs: string[]; crews: [number, number, number] }> = {
  S33v3: { jobs: trainA, crews: [2, 1, 1] },
  S60: { jobs: [...trainA, ...bop(['CTF1', 'CTF2']), ...cl(3), ...rpm(1, 2), ...rpm(30, 31), ...rpm(50, 50)], crews: [2, 1, 1] },
  S100: { jobs: [...trainA, ...bop(['CTF1', 'CTF2', 'CP2']), ...cl(6), ...rpm(1, 12), ...rpm(30, 37), ...rpm(50, 58)], crews: [3, 2, 1] },
  S130: { jobs: [...trainA, ...bop(['CTF1', 'CTF2', 'CP2', 'IAC1', 'CWP1']), ...cl(8), ...rpm(1, 17), ...rpm(30, 40), ...rpm(50, 62)], crews: [4, 2, 1] },
}

/** The bench instance of one subset, and its text's sha256 (to compare with SIZE_CURVE_SHA256). */
export const sizeCurveSubset = (name: SizeCurveName): { readonly bench: any; readonly sha256: string } => {
  const spec = specs[name]
  const jobs = new Set(spec.jobs)
  const mils = new Set(v3.activities.filter((a: { id: string }) => ms(a.id) && v3.links.some((l: { from: string; to: string }) => (l.from === a.id && jobs.has(l.to)) || (l.to === a.id && jobs.has(l.from)))).map((a: { id: string }) => a.id))
  const keep = (id: string) => jobs.has(id) || mils.has(id)
  const real = (id: string, side: 'open' | 'close'): string[] => ms(id) ? v3.links.filter((l: { from: string; to: string }) => (side === 'open' ? l.from === id : l.to === id)).map((l: { from: string; to: string }) => (side === 'open' ? l.to : l.from)) : [id]
  const spans = v3.spans.filter((s: { open: string; close: string }) => [...real(s.open, 'open'), ...real(s.close, 'close')].every(j => jobs.has(j)) && keep(s.open) && keep(s.close))
  const spanIds = new Set(spans.map((s: { id: string }) => s.id))
  const scale = (id: string, crews: number) => (r: { id: string; capacity: number[] }) => (r.id === id ? { ...r, capacity: r.capacity.map(c => (c > 0 ? crews : 0)) } : r)
  let resources = v3.resources.filter((r: { id: string }) => r.id !== 'wc-U2' && r.id !== 'test-U2')
  resources = resources.map(scale('mech-station', spec.crews[0])).map(scale('elec-station', spec.crews[1])).map(scale('ic-station', spec.crews[2]))
  const { ranges: _ranges, ...rest } = v3
  const bench = {
    ...rest, name: `gate-twin-v3-${name}`, resources,
    activities: v3.activities.filter((a: { id: string }) => keep(a.id)),
    links: v3.links.filter((l: { from: string; to: string }) => keep(l.from) && keep(l.to)),
    spans, groups: v3.groups.map((g: { spans: string[] }) => ({ ...g, spans: g.spans.filter(x => spanIds.has(x)) })).filter((g: { spans: string[] }) => g.spans.length > 0),
  }
  const text = JSON.stringify(bench)
  return { bench, sha256: new Bun.CryptoHasher('sha256').update(text).digest('hex') }
}
