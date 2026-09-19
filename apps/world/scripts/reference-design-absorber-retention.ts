/** Offline engineering reference for a fictional passive absorber tracer. Not plant runtime or real boron chemistry. */
export const absorberPartition = (carrierLiquid_kg:number, tracerEquivalent:number, capacity=.01) => {
  if (![carrierLiquid_kg,tracerEquivalent,capacity].every(Number.isFinite) || carrierLiquid_kg<0 || tracerEquivalent<0 || capacity<=0) throw new Error('Invalid absorber state')
  const dissolved=Math.min(tracerEquivalent,capacity*carrierLiquid_kg)
  return {dissolved,retained:tracerEquivalent-dissolved,liquidConcentration:carrierLiquid_kg===0?null:dissolved/carrierLiquid_kg}
}

/** Accepted finite donor parcel. Repartition is local; this is not a prescribed hydraulic flow. */
export const transferLiquid = (donor:{liquid:number,tracer:number},receiver:{liquid:number,tracer:number},liquid:number,capacity=.01) => {
  const from=absorberPartition(donor.liquid,donor.tracer,capacity)
  absorberPartition(receiver.liquid,receiver.tracer,capacity)
  if(!Number.isFinite(liquid)||liquid<0||liquid>donor.liquid)throw new Error('Liquid parcel exceeds donor')
  const tracer=liquid===0?0:liquid*from.liquidConcentration!
  return {donor:{liquid:donor.liquid-liquid,tracer:donor.tracer-tracer},receiver:{liquid:receiver.liquid+liquid,tracer:receiver.tracer+tracer},transportedTracer:tracer}
}

export const absorberComparison = () => {
  const initial={liquid:100,tracer:.2}
  const evaporating=[100,50,20,10,1,0].map(liquid=>({liquid,...absorberPartition(liquid,initial.tracer)}))
  const rewet=[0,1,10,20,100].map(liquid=>({liquid,...absorberPartition(liquid,initial.tracer)}))
  const transfer=transferLiquid({liquid:10,tracer:.2},{liquid:20,tracer:0},5)
  const reverse=transferLiquid(transfer.receiver,transfer.donor,5)
  const sensitivity=[.005,.01,.02].map(capacity=>({capacity,...absorberPartition(10,.2,capacity)}))
  return {scope:'passive carrier-normalized absorber equivalents; no chemical mass/energy, real solubility or neutron-worth qualification',initial,evaporating,rewet,transfer,reverse,sensitivity}
}

if(import.meta.main)console.log(JSON.stringify(absorberComparison(),null,2))
