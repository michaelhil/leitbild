/** Offline verification of the LD-01 water-origin label; not a runtime or sensor. */
export type WaterStock = { water_kg: number; primaryOrigin_kg: number }

export function checkStock(stock: WaterStock): void {
  const { water_kg: water, primaryOrigin_kg: origin } = stock
  if (!Number.isFinite(water) || !Number.isFinite(origin) || water < 0 || origin < 0 || origin > water) {
    throw Error('Origin-labelled water must be a nonnegative subset of actual water')
  }
}

/** One frozen donor parcel. Phase change uses the same donor rule as transport. */
export function transferWater(donor: WaterStock, recipient: WaterStock, water_kg: number) {
  checkStock(donor)
  checkStock(recipient)
  if (!Number.isFinite(water_kg) || water_kg < 0 || water_kg > donor.water_kg) throw Error('Invalid donor parcel')
  const primaryOrigin_kg = water_kg === 0 ? 0
    : water_kg === donor.water_kg ? donor.primaryOrigin_kg
      : water_kg * (donor.primaryOrigin_kg / donor.water_kg)
  const from = { water_kg: donor.water_kg - water_kg, primaryOrigin_kg: donor.primaryOrigin_kg - primaryOrigin_kg }
  const to = { water_kg: recipient.water_kg + water_kg, primaryOrigin_kg: recipient.primaryOrigin_kg + primaryOrigin_kg }
  checkStock(from)
  checkStock(to)
  return { donor: from, recipient: to, parcel: { water_kg, primaryOrigin_kg } }
}

/** No-water fraction is unavailable, not zero, and is not an instrument reading. */
export function originFraction(stock: WaterStock): number | null {
  checkStock(stock)
  return stock.water_kg === 0 ? null : stock.primaryOrigin_kg / stock.water_kg
}

export function runWaterProvenanceChecks() {
  const checks: string[] = []
  const near = (name: string, actual: number, expected: number, tolerance = 1e-10) => {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) throw Error(`${name}: ${actual} != ${expected}`)
    checks.push(name)
  }
  const primary = { water_kg: 1000, primaryOrigin_kg: 1000 }
  const secondary = { water_kg: 1000, primaryOrigin_kg: 0 }
  const leak = transferWater(primary, secondary, 100)
  near('rupture transports origin with real donor water', leak.recipient.primaryOrigin_kg, 100)
  near('origin is not total secondary concentration', originFraction(leak.recipient)!, 1 / 11)
  const evaporate = transferWater(leak.recipient, { water_kg: 0, primaryOrigin_kg: 0 }, 110)
  near('evaporated water retains origin unlike nonvolatile absorber', evaporate.parcel.primaryOrigin_kg, 10)
  const condense = transferWater(evaporate.recipient, { water_kg: 0, primaryOrigin_kg: 0 }, 110)
  near('complete condensation retains steam origin', condense.recipient.primaryOrigin_kg, 10)
  const reverse = transferWater(evaporate.donor, leak.donor, 99)
  near('reverse uses diluted secondary donor', reverse.parcel.primaryOrigin_kg, 9)
  near('roundtrip does not relabel reverse water as original primary', reverse.recipient.primaryOrigin_kg, 909)
  near('all-system origin budget', reverse.donor.primaryOrigin_kg + reverse.recipient.primaryOrigin_kg + condense.recipient.primaryOrigin_kg, 1000)
  near('all-system carrier budget', reverse.donor.water_kg + reverse.recipient.water_kg + condense.recipient.water_kg, 2000)
  const drain = transferWater(condense.recipient, { water_kg: 0, primaryOrigin_kg: 0 }, 110)
  near('dryout leaves no origin residue', drain.donor.primaryOrigin_kg, 0)
  if (originFraction(drain.donor) !== null) throw Error('Dry fraction must be unavailable')
  checks.push('dry fraction is unavailable')
  const refill = transferWater({ water_kg: 20, primaryOrigin_kg: 0 }, drain.donor, 20)
  near('fresh refill does not inherit emptied owner origin', refill.recipient.primaryOrigin_kg, 0)
  const copy = structuredClone(reverse)
  near('copy retains origin', copy.recipient.primaryOrigin_kg, reverse.recipient.primaryOrigin_kg)
  const noFlow = transferWater(refill.donor, copy.recipient, 0)
  near('zero flow from empty donor needs no division', noFlow.parcel.primaryOrigin_kg, 0)
  // Two simultaneously opposed gross streams do not vanish with their zero net water flow.
  const a = { water_kg: 100, primaryOrigin_kg: 100 }, b = { water_kg: 100, primaryOrigin_kg: 0 }
  const ab = transferWater(a, { water_kg: 0, primaryOrigin_kg: 0 }, 10)
  const ba = transferWater(b, { water_kg: 0, primaryOrigin_kg: 0 }, 10)
  const afterA = { water_kg: ab.donor.water_kg + ba.parcel.water_kg, primaryOrigin_kg: ab.donor.primaryOrigin_kg + ba.parcel.primaryOrigin_kg }
  near('zero-net exchange retains material mixing', afterA.primaryOrigin_kg, 90)
  // A finite pipe fixture transports parcels; no observation-only delay is inserted.
  const pipe = [{ water_kg: 1, primaryOrigin_kg: 0 }, { water_kg: 1, primaryOrigin_kg: 0 }]
  const outlet: WaterStock[] = []
  for (let i = 0; i < 3; i++) {
    outlet.push(pipe.shift()!)
    pipe.push({ water_kg: 1, primaryOrigin_kg: 1 })
  }
  near('retained unlabelled line water arrives first', outlet[0]!.primaryOrigin_kg + outlet[1]!.primaryOrigin_kg, 0)
  near('label arrives only after physical line displacement', outlet[2]!.primaryOrigin_kg, 1)
  near('line plus outlet labels conserve three inlet parcels', [...pipe, ...outlet].reduce((s, x) => s + x.primaryOrigin_kg, 0), 3)
  // Independent analytic mixed-volume limit; each frozen donor step converges without clipping.
  const errors = [100, 200].map(n => {
    let mixed = { water_kg: 1000, primaryOrigin_kg: 0 }
    let source = { water_kg: 1000, primaryOrigin_kg: 1000 }
    let exported = { water_kg: 0, primaryOrigin_kg: 0 }
    for (let i = 0; i < n; i++) {
      const out = transferWater(mixed, exported, 100 / n)
      const incoming = transferWater(source, out.donor, 100 / n)
      exported = out.recipient; source = incoming.donor; mixed = incoming.recipient
    }
    near(`mixed-volume origin budget ${n}`, source.primaryOrigin_kg + mixed.primaryOrigin_kg + exported.primaryOrigin_kg, 1000)
    return Math.abs(mixed.primaryOrigin_kg - 1000 * (1 - Math.exp(-.1)))
  })
  if (!(errors[1]! < errors[0]! && errors[0]! / errors[1]! > 1.9)) throw Error('Frozen-parcel refinement failed')
  checks.push('frozen-parcel refinement approaches independent mixed-volume solution')
  return { scope: 'Conserved origin labels and prescribed water-parcel histories only; no hydraulics, pressure trajectory, detector or live model', checks, mixedVolumeErrors_kg: errors }
}

if (import.meta.main) console.log(JSON.stringify(runWaterProvenanceChecks(), null, 2))
