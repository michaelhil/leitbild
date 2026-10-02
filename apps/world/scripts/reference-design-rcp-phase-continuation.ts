/** Offline RCP distributed mechanical-source checks. No runtime/plant registration. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { signedLiquidPump } from './reference-design-hydraulics.ts'

const selection = z.object({
  passageVolume_m3: z.literal(8), passageDiameter_m: z.literal(.70),
  mixedDegradationDepth: z.literal(.5),
  mixedDegradationChallenges: z.tuple([z.literal(0), z.literal(.75)]),
  sourceWeight: z.literal('uniform-passage-length'),
  material: z.literal('native-common-velocity-steam-air-nitrogen'),
}).strict()
export const parseRcpPhase = (document: string) => {
  const blocks = [...document.matchAll(/^```reference-rcp-phase-continuation\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one RCP phase-continuation record')
  return selection.parse(JSON.parse(blocks[0]![1]!))
}
export type RcpPhase = z.infer<typeof selection>
export type LocalMaterial = { rho: number; alphaG: number; q: number }
export type Characteristic = { a: number; b: number; resistance: number }

/** Phase volume is occupancy, not a void inferred from water mass fraction. */
export const gasVolumeFraction = (liquid: number, sharedGas: number) => {
  const volumes = [liquid, sharedGas]
  if (volumes.some(v => !Number.isFinite(v) || v < 0) || volumes.reduce((a,b) => a+b,0) <= 0)
    throw new Error('Material volumes must be nonnegative with positive occupied volume')
  return sharedGas / (liquid+sharedGas)
}
export const localRcpSource = (material: LocalMaterial, omega: number, c: Characteristic, depth: number) => {
  const {rho, alphaG, q} = material
  if (![rho,alphaG,q,omega,c.a,c.b,c.resistance,depth].every(Number.isFinite) || rho <= 0 ||
      alphaG < 0 || alphaG > 1 || depth < 0 || depth >= 1 || c.a <= 0 || c.b < 0 || c.resistance < 0)
    throw new Error('Invalid local RCP state or coefficient')
  const G = 1 - 4 * depth * alphaG * (1-alphaG)
  const X = c.a * omega - c.b * Math.abs(q)
  const euler = G * rho * omega * X
  const exchangeTorque = G * rho * q * X
  const brakeTorque = q < 0 && omega > 0 ? Math.max(0,-2*exchangeTorque) : 0
  const loss = c.resistance * rho * q * Math.abs(q)
  const torque = exchangeTorque + brakeTorque
  const power = omega * torque
  const kineticPower = q * (euler-loss)
  const brakePower = omega * brakeTorque
  const internalProduction = brakePower + q * loss
  return {G,euler,exchangeTorque,brakeTorque,loss,rise:euler-loss,torque,power,
    kineticPower,brakePower,internalProduction}
}

/** Weights are ds/L. They partition this one physical passage, never extra inventory. */
export const distributedRcpSource = (regions: {weight: number; material: LocalMaterial}[],
  omega: number, c: Characteristic, depth: number, basis: RcpPhase) => {
  const weight = regions.reduce((a,r) => a+r.weight,0)
  if (regions.length === 0 || regions.some(r => !Number.isFinite(r.weight) || r.weight <= 0) ||
      Math.abs(weight-1) > 1e-14) throw new Error('Physical passage weights must sum to one')
  const A = Math.PI * basis.passageDiameter_m ** 2 / 4, L = basis.passageVolume_m3 / A
  const sources = regions.map(r => ({weight:r.weight,...localRcpSource(r.material,omega,c,depth)}))
  const sum = (key: 'torque'|'power'|'rise'|'internalProduction'|'kineticPower') =>
    sources.reduce((a,r) => a+r.weight*r[key],0)
  return {area_m2:A,length_m:L,force_N:A*sum('rise'),torque_Nm:sum('torque'),
    shaftPower_W:sum('power'),kineticPower_W:sum('kineticPower'),
    internalProduction_W:sum('internalProduction'),sources}
}

export function checkRcpPhase(basis: RcpPhase) {
  const checks = new Map<string,{name:string;count:number;value:number;scale:number}>()
  const retain = (name:string,value:number,scale:number) => {
    const old=checks.get(name),worse=!old || Math.abs(value)/Math.max(1,scale)>Math.abs(old.value)/Math.max(1,old.scale)
    checks.set(name,{name,count:(old?.count??0)+1,value:worse?value:old!.value,scale:worse?scale:old!.scale})
  }
  const check = (name:string,value:number,scale=1) => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e-12 * Math.max(1,scale))
      throw new Error(`${name}: failed value ${value}, scale ${scale}`)
    retain(name,value,scale)
  }
  const require = (name:string,condition:boolean) => { if(!condition)throw new Error(name);retain(name,0,1) }
  // Frozen algebraic reference density, NOT an independently claimed native station preparation.
  const rho0=900,m0=4424.539616,omega0=1500*2*Math.PI/60,fluid0=4.188754e6,dp0=600000,sigma=.2
  const q0=m0/rho0,e0=fluid0/m0,a=e0/((1-sigma)*omega0**2),b=sigma*a*omega0/q0
  const resistance=(rho0*e0-dp0)/(rho0*q0**2), c={a,b,resistance}
  require('frozen algebraic nominal has positive loss',resistance>0)
  const nominal=localRcpSource({rho:rho0,alphaG:0,q:q0},omega0,c,.5)
  check('nominal head',nominal.rise-dp0,dp0)
  check('nominal shaft-fluid power',nominal.power-fluid0,fluid0)
  let cases=0,maxNormalizedIdentity=0
  for(const depth of [basis.mixedDegradationDepth,...basis.mixedDegradationChallenges])
    for(const alphaG of [0,.1,.5,.9,1])for(const rho of [1,30,900])
      for(const q of [-1.5*q0,-1e-8,0,1e-8,1.5*q0])
        for(const omega of [-1.25*omega0,-1e-8,0,1e-8,1.25*omega0]) {
          const x=localRcpSource({rho,alphaG,q},omega,c,depth)
          const identity=x.power-q*x.euler-x.brakePower
          const scale=Math.max(1,Math.abs(x.power),Math.abs(q*x.euler),x.brakePower)
          check('local exchange identity',identity,scale)
          check('local total-minus-kinetic production',x.power-x.kineticPower-x.internalProduction,
            Math.max(scale,x.internalProduction))
          require('passive loss and braking positive',q*x.loss>=0&&x.brakePower>=0&&x.internalProduction>=0)
          require('positive full-void coupling',x.G>0&&x.G<=1)
          if(omega===0){ require('zero-speed shaft power exact',x.power===0);if(q!==0)require('flow starts rotor in flow direction',Math.sign(-x.torque)===Math.sign(q)) }
          if(q===0)require('zero-flow torque and power exact',x.torque===0&&x.power===0)
          if(q<0&&omega>0)require('reverse throughflow brakes positive rotor',x.torque>=0)
          if(q<0&&omega<0)require('reverse rotor permits fluid work recovery',x.power<=0)
          if(q>0&&omega<0)require('opposed rotation dissipates rotor work',x.power>=0)
          if(alphaG===0){
            const old=signedLiquidPump(rho,q,omega,a,b,resistance)
            for(const key of ['exchangeTorque','brakeTorque','torque','euler','loss','rise','power','brakePower'] as const)
              check('uniform liquid exact old '+key,x[key]-old[key],Math.max(1,Math.abs(old[key])))
          }
          maxNormalizedIdentity=Math.max(maxNormalizedIdentity,Math.abs(identity)/scale);cases++
        }
  const native={pressure_Pa:15200000,temperature_K:616.3674646053697,
    liquidDensity_kg_m3:599.8892719923972,vaporDensity_kg_m3:98.77556526811108}
  const Vl=4,Vg=4,Ml=native.liquidDensity_kg_m3*Vl,Mv=native.vaporDensity_kg_m3*Vg
  const alpha=gasVolumeFraction(Vl,Vg),quality=Mv/(Ml+Mv),rho=(Ml+Mv)/(Vl+Vg)
  require('native equal-volume void differs from mass quality',alpha===.5&&quality<.15&&quality>.14)
  const nativeSource=localRcpSource({rho,alphaG:alpha,q:q0},omega0,c,.5)
  check('native mapping uses volume void not mass quality',nativeSource.G-.5)
  // Both NC species occupy ONE gas volume. Caloric/EOS constants are the current material owner's.
  const nc={pressure_Pa:101325,temperature_K:300,sharedGasVolume_m3:8,airMassFraction:.5}
  const Rmix=.5*287+.5*296.8,rhoNC=nc.pressure_Pa/(Rmix*nc.temperature_K),Mnc=rhoNC*8
  const air=.5*Mnc,nitrogen=.5*Mnc,pa=air*287*300/8,pn=nitrogen*296.8*300/8
  check('NC partial pressures share one gas volume',pa+pn-nc.pressure_Pa,nc.pressure_Pa)
  require('pure NC requires no invented water',gasVolumeFraction(0,nc.sharedGasVolume_m3)===1)
  require('zero gas exact',gasVolumeFraction(8,0)===0)
  require('NC endpoint retains gas rotor torque',localRcpSource({rho:rhoNC,alphaG:1,q:q0},omega0,c,.5).torque!==0)
  const wetNC={pressure_Pa:101325,temperature_K:363.15,steamPressure_Pa:70181.76581517824,
    liquidDensity_kg_m3:965.3095895562478,steamDensity_kg_m3:.4238979446317199,Vl_m3:4,Vg_m3:4}
  const pnEach=(wetNC.pressure_Pa-wetNC.steamPressure_Pa)/2
  const wetAir=pnEach*4/(287*wetNC.temperature_K),wetNitrogen=pnEach*4/(296.8*wetNC.temperature_K)
  const wetSteam=wetNC.steamDensity_kg_m3*4,wetLiquid=wetNC.liquidDensity_kg_m3*4
  const wetRho=(wetAir+wetNitrogen+wetSteam+wetLiquid)/8
  require('all three gases share ONE Vg with invariant void',gasVolumeFraction(wetNC.Vl_m3,wetNC.Vg_m3)===alpha)
  check('all-gas partial-pressure sum',wetNC.steamPressure_Pa+wetAir*287*wetNC.temperature_K/4+
    wetNitrogen*296.8*wetNC.temperature_K/4-wetNC.pressure_Pa,wetNC.pressure_Pa)
  require('composition changes density not occupancy',wetRho!==rho && localRcpSource({rho:wetRho,alphaG:alpha,q:q0},omega0,c,.5).G===nativeSource.G)
  const materials=[{rho:850,alphaG:.1,q:q0},{rho:15,alphaG:.95,q:-.2*q0}]
  const one=distributedRcpSource(materials.map((material,i)=>({weight:i===0?.3:.7,material})),omega0,c,.5,basis)
  const split=distributedRcpSource(materials.flatMap((material,i)=>[.25,.75].map(f=>({weight:f*(i===0?.3:.7),material}))),omega0,c,.5,basis)
  for(const key of ['force_N','torque_Nm','shaftPower_W','kineticPower_W','internalProduction_W'] as const)
    check('same-material partition invariant '+key,one[key]-split[key],Math.max(1,Math.abs(one[key])))
  check('integrated one-rotor power',one.shaftPower_W-omega0*one.torque_Nm,Math.abs(one.shaftPower_W))
  check('integrated internal production',one.shaftPower_W-one.kineticPower_W-one.internalProduction_W,Math.abs(one.shaftPower_W))
  // Frozen imposed-flow material, not a flow/phase trajectory. Solve the actual linear braking torque
  // with midpoint rotor work; an external flow holder is outside this local reaction ledger.
  const J=(fluid0+fluid0*.01)*10/omega0**2,omegaStart=omega0,dt=.01
  const held={rho:30,alphaG:.5,q:-.2*q0}, G=1-4*.5*held.alphaG*(1-held.alphaG)
  const k=-G*held.rho*held.q*a,constant=G*held.rho*held.q*b*Math.abs(held.q)
  const deltaOmega=-dt*(k*omegaStart+constant)/(J+dt*k/2),omegaEnd=omegaStart+deltaOmega
  const omegaMid=omegaStart+deltaOmega/2,atMid=localRcpSource(held,omegaMid,c,.5)
  check('finite implicit rotor torque',J*deltaOmega+dt*atMid.torque,dt*Math.abs(atMid.torque))
  const fluidEnergy=dt*atMid.power,rotorChange=J*deltaOmega*(omegaStart+deltaOmega/2)
  check('finite rotor-plus-native-fluid reaction ledger',rotorChange+fluidEnergy,fluidEnergy)
  return {scope:'Offline constitutive source/sign/partition/energy witness; no native EOS solve or coupled phase/coastdown qualification',
    uniformLiquidReference:{rho_kg_m3:rho0,m_kg_s:m0,omega_rad_s:omega0,fluid_W:fluid0,head_Pa:dp0},
    coefficient:{...c},cases,checkCount:[...checks.values()].reduce((a,x)=>a+x.count,0),checks:[...checks.values()],
    nativeMapping:{...native,Vl_m3:Vl,Vg_m3:Vg,Ml_kg:Ml,Mv_kg:Mv,alphaG:alpha,massQuality:quality,rhoMix_kg_m3:rho},
    noncondensables:{...nc,air_kg:air,nitrogen_kg:nitrogen,density_kg_m3:rhoNC,pa_Pa:pa,pn_Pa:pn},
    wetThreeGasMapping:{...wetNC,air_kg:wetAir,nitrogen_kg:wetNitrogen,steam_kg:wetSteam,
      liquid_kg:wetLiquid,rhoMix_kg_m3:wetRho,alphaG:alpha},
    maxNormalizedIdentity,nonuniform:one,
    finiteReaction:{dt_s:dt,J_kg_m2:J,heldMaterial:held,omegaStart,omegaEnd,fluidEnergy_J:fluidEnergy,rotorChange_J:rotorChange}}
}

if(import.meta.main){
  const path=Bun.argv[2]
  if(!path)throw new Error('Usage: bun reference-design-rcp-phase-continuation.ts <RCP-owner.md>')
  const text=await Bun.file(path).text(),basis=parseRcpPhase(text)
  const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({inputSha256:sha(JSON.stringify(basis)),sourceSha256:sha(await Bun.file(import.meta.path).text()),basis,...checkRcpPhase(basis)},null,2))
}
