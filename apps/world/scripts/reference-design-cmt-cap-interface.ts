/** Local separated-cap interface/receiver selection. No connected transient solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseGeometryBasis, tankGeometry, ringArea, type GeometryBasis } from './reference-design-cmt-geometry.ts'

const schema = z.object({ pressures_Pa: z.tuple([z.literal(1e6), z.literal(5e6), z.literal(15e6)]),
  liquidDonorK_J_kg: z.number().finite().nonnegative(), receiverVolume_m3: z.literal(.5),
  receivedSteam_kg: z.literal(.02), boronFraction: z.literal(.002) }).strict()
export function parseCapBasis(doc: string) {
  const blocks = [...doc.matchAll(/^```reference-cmt-cap\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-cap block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function capContacts(b: GeometryBasis) {
  const g = tankGeometry(b)
  const heights = [...new Set([g.mouth, b.bottomProbe_m, b.topProbe_m, 11.7,
    ...b.ringElevations_m.flatMap(z => [z - b.holeDiameter_m / 2, z, z + b.holeDiameter_m / 2]), b.top_m])].sort((a, c) => a - c)
  return heights.map(height => {
    const liquidVolume = g.volume(g.mouth, height), vaporVolume = g.volume(height, b.top_m)
    if (Math.abs(liquidVolume + vaporVolume - b.freeWater_m3) > 1e-10) throw new Error('Phase occupancy closure')
    return { height_m: height, liquidVolume_m3: liquidVolume, vaporVolume_m3: vaporVolume,
      interfaceArea_m2: height === g.mouth || height === b.top_m ? 0 : g.area(height),
      liquidMouthEligible: height > g.mouth,
      rings: b.ringElevations_m.map(z => {
        const full = ringArea(b, z, b.bodyBottom_m, b.bodyTop_m)
        const liquid = ringArea(b, z, b.bodyBottom_m, height)
        return { z_m: z, liquidArea_m2: liquid, vaporArea_m2: full - liquid, totalArea_m2: full }
      }), probeContact: [b.bottomProbe_m, b.topProbe_m].map(z => height > z ? 'liquid' : height < z ? 'vapor' : 'interface') }
  })
}
export const capCalculation = String.raw`
import json,sys,math,platform
import CoolProp, CoolProp.CoolProp as C
from scipy.optimize import brentq
d=json.load(sys.stdin);b=d['basis'];g=9.80665
li=C.AbstractState('HEOS','Water');li.specify_phase(C.iphase_liquid)
def liquid(p,T):
    li.update(C.PT_INPUTS,p,T)
    return dict(rho=li.rhomass(),h=li.hmass(),u=li.umass(),s=li.smass())
def guard(ok,name):
    if not ok:raise ValueError(name)
cases=[]
for pv in b['pressures_Pa']:
    T=C.PropsSI('T','P',pv,'Q',1,'Water');rv=C.PropsSI('Dmass','P',pv,'Q',1,'Water')
    hv=C.PropsSI('Hmass','P',pv,'Q',1,'Water');uv=C.PropsSI('Umass','P',pv,'Q',1,'Water')
    cv=C.PropsSI('A','P',pv,'Q',1,'Water')
    for ql,qv in [(-30000.,10000.),(-10000.,10000.),(0.,20000.)]:
        heat=ql+qv;k=b['liquidDonorK_J_kg'] if heat>0 else 0.
        def state(j):
            pl=pv
            for _ in range(4):
                l=liquid(pl,T);pl=pv+j*j*(1/rv-1/l['rho'])
            l=liquid(pl,T)
            residual=j*(hv-l['h']+.5*j*j*(1/rv**2-1/l['rho']**2)-k)-heat
            return pl,l,residual
        j=0. if heat==0 else brentq(lambda j:state(j)[2],-.1,.1,xtol=1e-15)
        pl,l,res=state(j);recoil=pl-pv;poynting=recoil/(l['rho']*461.5*T)
        mach=abs(j/rv)/cv
        boronAdvective=j*b['boronFraction'];boronDiffusive=-boronAdvective
        guard(abs(boronAdvective+boronDiffusive)<1e-16,'Nonvolatile interfacial boron flux')
        guard(abs(res)<1e-5 and abs(recoil-j*j*(1/rv-1/l['rho']))<1e-8,'Local EOS/jump residual')
        guard(mach<=.01 and poynting<=1e-4 and l['rho']>rv and all(math.isfinite(v) for v in [j,res,recoil]),'Planar interface domain')
        frames=[]
        for w,tangent in [(0.,0.),(.02,0.),(2.,3.)]:
            vl=w+j/l['rho'];vv=w+j/rv;z=11.7
            fl=j*(l['h']+.5*(vl*vl+tangent*tangent)+k+g*z)+pl*w+ql
            fv=j*(hv+.5*(vv*vv+tangent*tangent)+g*z)+pv*w-qv
            mass=l['rho']*(vl-w)-rv*(vv-w)
            momentum=(j*vl+pl)-(j*vv+pv)
            energy=fl-fv
            guard(abs(mass)<1e-9 and abs(momentum)<1e-8 and abs(energy)<1e-5,'Full moving-face flux identity')
            frames.append(dict(surfaceSpeed_m_s=w,tangentialVelocity_m_s=tangent,massResidual_kg_m2s=mass,
                momentumResidual_Pa=momentum,energyResidual_W_m2=energy,tangentialMomentumResidual= j*tangent-j*tangent))
        cases.append(dict(pv_Pa=pv,pl_Pa=pl,interfaceT_K=T,liquid=l,vapor=dict(rho=rv,h=hv,u=uv),
            heatLiquid_W_m2=ql,heatVapor_W_m2=qv,j_kg_m2s=j,recoil_Pa=recoil,
            poynting=poynting,relativeVaporMach=mach,evaporatingQ_W_m2=j*k,
            boronAdvective_kg_m2s=boronAdvective,boronCounterdiffusive_kg_m2s=boronDiffusive,
            chemicalBoronPhaseFlux_kg_m2s=boronAdvective+boronDiffusive,frames=frames,
            bulkLiquidTransportEnvelopeIncluded=T<=563.15))
# Native finite receiver: steam receipt, not a prescribed equilibrium pressure.
# HEM deliberately mixes immediately; it is NOT a surface condensation-rate test.
receivers=[]
for name,T in [('cold',313.15),('warm',C.PropsSI('T','P',5e6,'Q',0,'Water')-2)]:
    p=5e6;V=b['receiverVolume_m3'];rho=C.PropsSI('Dmass','P',p,'T',T,'Water');M=V*rho
    U=M*C.PropsSI('Umass','P',p,'T',T,'Water');B=b['boronFraction']*M
    m=b['receivedSteam_kg'];h=C.PropsSI('Hmass','P',p,'Q',1,'Water')
    finalM=M+m;finalU=U+m*h;rho1=finalM/V;u1=finalU/finalM
    T1=C.PropsSI('T','Dmass',rho1,'Umass',u1,'Water');p1=C.PropsSI('P','Dmass',rho1,'Umass',u1,'Water')
    quality=C.PropsSI('Q','Dmass',rho1,'Umass',u1,'Water')
    classification=C.PhaseSI('Dmass',rho1,'Umass',u1,'Water')
    # Independent forward PT or saturation lever rule checks the actual recovered phase.
    if classification=='liquid':
        phase='liquid';mf=V*C.PropsSI('Dmass','P',p1,'T',T1,'Water')
        uf=mf*C.PropsSI('Umass','P',p1,'T',T1,'Water');liquidMass=finalM
    else:
        guard(classification=='twophase' and 0<=quality<1,'Receiver has no admitted liquid absorber owner')
        phase='two-phase'
        rf=C.PropsSI('Dmass','P',p1,'Q',0,'Water');rg=C.PropsSI('Dmass','P',p1,'Q',1,'Water')
        ef=C.PropsSI('Umass','P',p1,'Q',0,'Water');eg=C.PropsSI('Umass','P',p1,'Q',1,'Water')
        mf=V/((1-quality)/rf+quality/rg);uf=mf*((1-quality)*ef+quality*eg)
        liquidMass=finalM*(1-quality)
    guard(abs(mf-finalM)<1e-6 and abs(uf-finalU)<.1 and p1!=p,'Finite native receiver feedback')
    receivers.append(dict(name=name,initialM_kg=M,initialU_J=U,initialB_kg=B,initialP_Pa=p,initialT_K=T,
        steamMass_kg=m,steamEnergy_J=m*h,finalM_kg=finalM,finalU_J=finalU,finalB_kg=B,
        finalP_Pa=p1,finalT_K=T1,finalPhase=phase,rawQualityProperty=quality,
        finalVaporQuality=quality if phase=='two-phase' else 0.,
        finalLiquidMass_kg=liquidMass,finalLiquidBoronFraction=B/liquidMass,
        forwardMassResidual_kg=mf-finalM,forwardEnergyResidual_J=uf-finalU))
json.dump(dict(cases=cases,receivers=receivers,localInterfaceChecksPassed=True,
    submergedSteamAdmissionSelected=False,connectedDepletionQualified=False,
    versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__)),sys.stdout,indent=2,allow_nan=False)
`
if (import.meta.main) {
  const [geometryPath, ownerPath, python, output] = process.argv.slice(2)
  if (!geometryPath || !ownerPath || !python || !output) throw new Error('Usage: cap-interface.ts geometry.md transport.md python output.json')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const geometry = parseGeometryBasis(await Bun.file(geometryPath).text()), basis = parseCapBasis(await Bun.file(ownerPath).text())
  const identities = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(capCalculation),
    geometrySourceHash: hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()),
    inputHash: hash(JSON.stringify({ geometry, basis })) }
  const contacts = capContacts(geometry)
  const child = Bun.spawn([python, '-c', capCalculation], { stdin: new Response(JSON.stringify({ basis })), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(stderr)
  await Bun.write(output, JSON.stringify({ ...identities, geometry, basis, contacts, ...JSON.parse(stdout) }, null, 2) + '\n')
}
