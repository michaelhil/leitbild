/** Bounded native port/receiving checks, not a coupled release or secondary-cycle solver. */
import { createHash } from 'node:crypto'

export const releaseBasis = {
  gravity_m_s2: 9.80665,
  secondaryDatum_m: 0,
  msBore_m: 0.2,
  msCdA_m2: 0.02,
  commonReliefDatum_m: -2,
  commonReliefCdA_m2: 0.0005,
  sumpFloor_m: -2,
  sumpArea_m2: 200,
  sgVolume_m3: 120,
  gasDatum_m: 20,
} as const

export function releaseReceiver(
  port: number,
  surface: number,
  liquidMass: number,
  gasPressure: number,
  liquidDensity?: number,
) {
  if (![port, surface, liquidMass, gasPressure].every(Number.isFinite) || liquidMass < 0 || gasPressure <= 0) {
    throw Error('Invalid release receiver')
  }
  if (liquidMass === 0 || surface <= port) return { phase: 'gas', pressure_Pa: gasPressure } as const
  if (liquidDensity === undefined || !Number.isFinite(liquidDensity) || liquidDensity <= 0) {
    throw Error('Missing covering liquid density')
  }
  return {
    phase: 'liquid',
    pressure_Pa: gasPressure + liquidDensity * releaseBasis.gravity_m_s2 * (surface - port),
  } as const
}

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq
b=json.loads(sys.argv[1]);g=b['gravity_m_s2'];p=101325.;checks=[];poolRecovery=[]
def check(name,value,bound):
 if not math.isfinite(value) or abs(value)>bound:raise ValueError((name,value,bound))
 checks.append(dict(name=name,value=value,bound=bound))
def pool(M,T,datum):
 rho=P('D','P',p,'T',T,'Water');V=M/rho;h=P('H','P',p,'T',T,'Water')
 return dict(M=M,T=T,V=V,H=b['sumpFloor_m']+V/b['sumpArea_m2'],K=M*h+M*g*(b['sumpFloor_m']+datum+V/(2*b['sumpArea_m2'])))
def recover_pool(M,K,datum):
 xtol=1e-11;rtol=4*sys.float_info.epsilon
 T=brentq(lambda T:pool(M,T,datum)['K']-K,290.,330.,xtol=xtol,rtol=rtol)
 r=pool(M,T,datum)
 slope=M*(P('C','P',p,'T',T,'Water')+g*r['V']/b['sumpArea_m2']*P('ISOBARIC_EXPANSION_COEFFICIENT','P',p,'T',T,'Water')/2)
 thermalResolution=abs(slope)*(xtol+rtol*abs(T));rounding=8*sys.float_info.epsilon*(abs(r['K'])+abs(K));bound=max(.001,thermalResolution+rounding)
 poolRecovery.append(dict(residual_J=r['K']-K,initialScreen_J=.01,rootTemperatureResolution_J=thermalResolution,rounding_J=rounding,derivedAllowance_J=bound))
 check('native pool H+PE recovery at declared root resolution',r['K']-K,bound);return r

# One frozen 10g liquid donor packet from a liquid-covered SG pickup.
# Release jet is already thermalized at its receiving plane for this flash coupon.
# Gas energy is a supplied CNV ledger increment, NOT a coupled CNV state solve.
def forward(datum):
 ps=6e6;Ts=500.;V=b['sgVolume_m3'];dm=.01
 M=P('D','P',ps,'T',Ts,'Water')*V;u=P('U','P',ps,'T',Ts,'Water');h=P('H','P',ps,'T',Ts,'Water')
 zs=b['secondaryDatum_m']+datum;Ht=h+g*zs;E=M*(u+g*zs)
 M1=M-dm;E1=E-dm*Ht;U1=E1-M1*g*zs
 p1=P('P','D',M1/V,'U',U1/M1,'Water');T1=P('T','D',M1/V,'U',U1/M1,'Water')
 hface=Ht-g*zs;x=P('Q','P',p,'H',hface,'Water')
 if not 0<x<1:raise ValueError('Expected admitted wet release')
 hl=P('H','P',p,'Q',0,'Water');hv=P('H','P',p,'Q',1,'Water');ml=dm*(1-x);mv=dm*x
 liquidE=ml*(hl+g*zs);gasE=mv*(hv+g*zs)
 check('native receiving flash payload',liquidE+gasE-dm*Ht,1e-8)
 rho=P('D','P',p,'T',298.15,'Water');r0=pool(rho*b['sumpArea_m2']*.5,298.15,datum)
 r1=recover_pool(r0['M']+ml,r0['K']+liquidE,datum)
 # The pool K=U+pV+PE coordinate exactly includes the constant-pressure work.
 gasU=gasE-mv*g*(b['gasDatum_m']+datum)
 check('source and both recipients total-energy incidence',E1-E+liquidE+gasE,.0001)
 check('water mass split',ml+mv-dm,1e-15)
 return dict(scope='Frozen liquid-covered SG packet and native pool receipt; gas ledger only, not pressure-driven release or CNV recovery',packet_kg=dm,vapor_kg=mv,liquid_kg=ml,sourcePressureAfter_Pa=p1,sourceTemperatureAfter_K=T1,sourceUAfter_J=U1,poolTemperatureAfter_K=r1['T'],poolEnergyIncrement_J=liquidE,gasTotalEnergyIncrement_J=gasE,gasInternalEnergyIncrement_J=gasU,quality=x)

# Separate reverse fixture: covering pool at H=+1m feeds the z=0 MS mouth.
# Native SG receiving pressure evolves, but its 10g source packet is prescribed.
def reverse(datum):
 rho=P('D','P',p,'T',298.15,'Water');r0=pool(rho*b['sumpArea_m2']*3.,298.15,datum)
 zp=b['secondaryDatum_m'];pport=p+rho*g*(r0['H']-zp)
 hs=P('H','P',p,'T',r0['T'],'Water');hport=hs+g*(r0['H']-zp);Ht=hport+g*(zp+datum)
 check('pool port preserves surface total head',Ht-(hs+g*(r0['H']+datum)),1e-10)
 P('T','P',pport,'H',hport,'Water') # Actual native local liquid port must exist.
 pr=60000.;Tr=400.;V=b['sgVolume_m3'];dm=.01
 if pport<=pr:raise ValueError('Wrong reverse pressure direction')
 M=P('D','P',pr,'T',Tr,'Water')*V;u=P('U','P',pr,'T',Tr,'Water');z=zp+datum
 E=M*(u+g*z);M1=M+dm;E1=E+dm*Ht;U1=E1-M1*g*z
 p1=P('P','D',M1/V,'U',U1/M1,'Water');T1=P('T','D',M1/V,'U',U1/M1,'Water')
 r1=recover_pool(r0['M']-dm,r0['K']-dm*Ht,datum)
 check('reverse source/receiver total-energy incidence',E1-E-dm*Ht,1e-7)
 return dict(scope='Frozen actual covering-liquid parcel into finite SG; no connected intake or mixture-rate solution',portPressure_Pa=pport,donorSurface_m=r0['H'],packet_kg=dm,receivedEnergy_J=dm*Ht,receiverPressureAfter_Pa=p1,receiverTemperatureAfter_K=T1,receiverUAfter_J=U1,poolTemperatureAfter_K=r1['T'])

f=forward(0.);fs=forward(100.);r=reverse(0.);rs=reverse(100.)
for key in ['sourcePressureAfter_Pa','sourceTemperatureAfter_K','sourceUAfter_J','poolTemperatureAfter_K','gasInternalEnergyIncrement_J','quality']:
 check('forward datum invariant '+key,fs[key]-f[key],.0001)
for key in ['portPressure_Pa','receiverPressureAfter_Pa','receiverTemperatureAfter_K','receiverUAfter_J','poolTemperatureAfter_K']:
 check('reverse datum invariant '+key,rs[key]-r[key],.0001)
check('forward transported datum shift',fs['poolEnergyIncrement_J']+fs['gasTotalEnergyIncrement_J']-f['poolEnergyIncrement_J']-f['gasTotalEnergyIncrement_J']-.01*g*100,1e-8)
check('reverse transported datum shift',rs['receivedEnergy_J']-r['receivedEnergy_J']-.01*g*100,1e-8)
print(json.dumps(dict(forward=f,reverse=r,poolRecovery=poolRecovery,initialMiss=dict(residual_J=-.01174163818359375,screen_J=.01,disposition='Use declared temperature-root resolution plus floating-point rounding; no physical law, coefficient or root tolerance changed'),checks=checks,dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),allow_nan=False))
`

if (import.meta.main) {
  const [python, output, ...extra] = process.argv.slice(2)
  if (!python || !output || extra.length) throw Error('Usage: release-connections <CoolProp/SciPy Python> <receipt.json>')
  const source = await Bun.file(import.meta.path).text()
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(releaseBasis)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw Error(err)
  if (source !== await Bun.file(import.meta.path).text()) throw Error('Source changed during calculation')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const result = JSON.parse(out)
  const rho = 997.047636760
  const portInputs: [string, number, number, number][] = [
    ['MS dry', 0, -1, 1],
    ['MS at surface', 0, 0, 1],
    ['MS covered', 0, 1, 1],
    ['COMMON empty', -2, -2, 0],
    ['COMMON covered', -2, -1.9, 1],
  ]
  const ports = portInputs.map(([name, z, h, m]) => ({ name, ...releaseReceiver(z, h, m, 101325, rho) }))
  const receipt = {
    sourceSha256: hash(source),
    calculationSha256: hash(calculation),
    input: releaseBasis,
    inputSha256: hash(JSON.stringify(releaseBasis)),
    resultSha256: hash(JSON.stringify(result)),
    ports,
    result,
  }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({
    output,
    source: receipt.sourceSha256,
    calculation: receipt.calculationSha256,
    result: receipt.resultSha256,
    checks: result.checks.length,
    forward: result.forward,
    reverse: result.reverse,
  }))
}
