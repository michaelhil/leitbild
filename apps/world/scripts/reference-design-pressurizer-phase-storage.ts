/** Sealed regional equilibrium storage reference in heat coordinates; no plant runtime or heat-rate law. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'

const basis = z.object({ wallReheatAboveInitialVapor_K: z.number().finite().positive(), coldLowerOffset_K: z.number().finite().positive() }).strict()
export function parsePhaseStorageBasis(text: string) {
  const blocks = [...text.matchAll(/^```reference-pressurizer-phase-storage\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-pressurizer-phase-storage block')
  return basis.parse(JSON.parse(blocks[0]![1]!))
}

export const phaseStorageThermodynamics = String.raw`
import json,sys,math,platform,scipy,CoolProp
import CoolProp.CoolProp as CP
from types import SimpleNamespace
import numpy as np
from scipy.integrate import solve_ivp,quad
from scipy.optimize import brentq
water=CP.AbstractState('HEOS','Water')
def W(P,**pair):
    if len(pair)!=1:raise ValueError('One independent property pair required')
    key,value=next(iter(pair.items()))
    if key=='T':water.update(CP.PT_INPUTS,P*1e6,value)
    elif key=='s':water.update(CP.PSmass_INPUTS,P*1e6,value*1000)
    elif key=='x':water.update(CP.PQ_INPUTS,P*1e6,value)
    elif key=='v':water.update(CP.DmassP_INPUTS,1/value,P*1e6)
    else:raise ValueError('Unsupported property pair')
    quality=water.Q()
    # HEOS's saturation-side PS tolerance can return a negative two-phase quality.
    # Solve the actual subcooled entropy state instead of clipping its phase inventory.
    if quality<0 and water.phase()==CP.iphase_twophase and key=='s':
        water.update(CP.PQ_INPUTS,P*1e6,0);Ts=water.T();sf=water.smass()
        if value*1000>=sf:raise ValueError('Unexpected negative quality inside saturation entropy domain')
        water.specify_phase(CP.iphase_liquid)
        try:
            def entropy(T):
                water.update(CP.PT_INPUTS,P*1e6,T)
                return water.smass()-value*1000
            T=brentq(entropy,Ts-1,Ts,xtol=1e-11)
            water.update(CP.PT_INPUTS,P*1e6,T)
            quality=0.
        finally:water.unspecify_phase()
    if quality<0:
        phase=water.phase()
        if phase==CP.iphase_liquid:quality=0.
        elif phase==CP.iphase_gas:quality=1.
        else:raise ValueError(dict(reason='Outside the selected liquid/vapor reference domain',phase=phase,quality=quality,P=P,pair=pair))
    return SimpleNamespace(P=water.p()/1e6,T=water.T(),rho=water.rhomass(),v=1/water.rhomass(),
        u=water.umass()/1000,s=water.smass()/1000,x=quality)
`
const phaseStorageReference = String.raw`b=json.load(sys.stdin);r=b['source'];cfg=b['phase'];p0=b['spatial']['surfacePressure_MPa'];g=9.80665
A=math.pi*r['innerRadius_m']**2;H=r['height_m'];L=r['statedLevel_m'];T0=r['fluidTemperature_K'];Tw0=r['wallTemperature_K']
def solid_e(T):
    if not 300<=T<=650:raise ValueError('Wall outside selected NIST comparison interval')
    return 6.683*(T-300)+.04906/2*(T*T-300**2)+80.74*(T*math.log(T)-T-300*math.log(300)+300)
def solid_s(T):return 6.683*math.log(T/300)+.04906*(T-300)+80.74/2*(math.log(T)**2-math.log(300)**2)
# Fixed initial exposed-wall material, not moving wetted-area reassignment.
mw=7920*math.pi*(r['outerRadius_m']**2-r['innerRadius_m']**2)*(H-L)
def wall_temperature(E):return brentq(lambda T:mw*solid_e(T)-E,300,650,xtol=1e-10)
def run(count,nq,cold):
    gx,gw=np.polynomial.legendre.leggauss(nq)
    def gauss(lo,hi):return lo+(gx+1)*(hi-lo)/2,gw*(hi-lo)/2
    edges=sorted(set([float(z) for z in np.linspace(0,H,count+1) if z<L]+[L]+([L/2] if cold else [])))
    native=[];p=p0
    for lo,hi in reversed(list(zip(edges[:-1],edges[1:]))):
        T=T0-(cfg['coldLowerOffset_K'] if cold and hi<=L/2 else 0)
        sol=solve_ivp(lambda z,y:[-W(P=float(y[0]),T=T).rho*g/1e6],[hi,lo],[p],
            rtol=1e-10,atol=1e-12,dense_output=True)
        if not sol.success:raise ValueError(sol.message)
        zs,weights=gauss(lo,hi);qs=[W(P=float(sol.sol(z)[0]),T=T) for z in zs]
        mass=sum(w*q.rho*A for w,q in zip(weights,qs))
        entropy=sum(w*q.rho*A*q.s for w,q in zip(weights,qs))/mass
        # This exact saturation boundary is used to split mass quadrature, not smear boiling over nodes.
        ps=brentq(lambda p:W(P=p,x=0).s-entropy,.01,16.,xtol=1e-11)
        native.append(dict(mass=mass,entropy=entropy,saturationPressure=ps));p=float(sol.y[0,-1])
    native.reverse();M=sum(c['mass'] for c in native);bounds=np.r_[0,np.cumsum([c['mass'] for c in native])]
    def pool(p):
        volume=U=PE=gasMass=gasVolume=0.;temperatures=[];entropyError=0.
        for i,c in enumerate(native):
            lo=bounds[i];hi=bounds[i+1]
            crossing=M-(c['saturationPressure']-p)*1e6*A/g
            splits=[lo]+([crossing] if lo<crossing<hi else [])+[hi]
            for a,d in zip(splits[:-1],splits[1:]):
                ms,weights=gauss(a,d)
                for m,w in zip(ms,weights):
                    q=W(P=p+g*(M-m)/A/1e6,s=c['entropy'])
                    if q.x==1:raise ValueError('Lower material region has exhausted its liquid phase')
                    entropyError=max(entropyError,abs(q.s-c['entropy']))
                    volume+=w*q.v;U+=w*q.u*1000;PE+=w*g/A*(M-m)*q.v
                    if q.x>0:
                        gasMass+=w*q.x;gasVolume+=w*q.x*W(P=q.P,x=1).v
                    temperatures.append(q.T)
        if not 0<volume<A*H or entropyError>1e-7:raise ValueError('Invalid finite pool or entropy inverse')
        return dict(volume=volume,U=U,PE=PE,gasMass=gasMass,gasVolume=gasVolume,
            temperatureMin=min(temperatures),temperatureMax=max(temperatures),entropyError=entropyError)
    initialPool=pool(p0);mhead=(A*H-initialPool['volume'])/W(P=p0,x=1).v
    def fluid(p):
        q=pool(p);vh=A*H-q['volume'];v=vh/mhead;f=W(P=p,x=0);vapor=W(P=p,x=1)
        if v<f.v:raise ValueError('Upper region liquid-only boundary')
        head=W(P=p,v=v);x=head.x
        level=q['volume']/A;headPE=mhead*g*(level+H)/2
        return dict(pressure_MPa=p,level_m=level,upperTemperature_K=head.T,upperQuality=x,
            lowerVolume_m3=q['volume'],lowerEnergy_J=q['U']+q['PE'],upperEnergy_J=mhead*head.u*1000+headPE,
            upperLiquidMass_kg=mhead*(1-x),upperLiquidVolumeFraction=mhead*(1-x)*f.v/vh,
            lowerVaporMass_kg=q['gasMass'],lowerVaporVolumeFraction=q['gasVolume']/q['volume'],
            lowerTemperatureMin_K=q['temperatureMin'],lowerTemperatureMax_K=q['temperatureMax'],
            energy_J=q['U']+q['PE']+mhead*head.u*1000+headPE,
            upperEntropy_J_K=mhead*head.s*1000,
            upperHydrostaticHeadEstimate_Pa=mhead/vh*g*(H-level),
            volumeResidual_m3=q['volume']+mhead*head.v-A*H,
            entropyInverseError_kJ_kgK=q['entropyError'])
    initial=fluid(p0);E0=initial['energy_J'];W0=mw*solid_e(Tw0)
    def state(p,external):
        f=fluid(p);Q=E0-f['energy_J'];wallE=W0+Q+external;Tw=wall_temperature(wallE)
        f.update(netHeatFromFluid_J=Q,wallTemperature_K=Tw,externalWallHeat_J=external,
            totalEnergyResidual_J=f['energy_J']+wallE-E0-W0-external,
            totalEntropyChange_J_K=f['upperEntropy_J_K']-initial['upperEntropy_J_K']+mw*(solid_s(Tw)-solid_s(Tw0)))
        return f
    def contact(start,direction,external):
        previous=start;fp=state(previous,external)['upperTemperature_K']-state(previous,external)['wallTemperature_K']
        for i in range(1,201):
            p=start+direction*i*.001;now=state(p,external);fn=now['upperTemperature_K']-now['wallTemperature_K']
            if fp*fn<=0:return brentq(lambda p:state(p,external)['upperTemperature_K']-state(p,external)['wallTemperature_K'],previous,p,xtol=1e-11)
            previous=p;fp=fn
        raise ValueError('No contact equilibrium in declared 0.2 MPa pressure continuation window')
    coolp=contact(p0,-1,0);cool=state(coolp,0)
    reheatT=initial['upperTemperature_K']+cfg['wallReheatAboveInitialVapor_K']
    external=mw*(solid_e(reheatT)-solid_e(cool['wallTemperature_K']))
    hotp=contact(coolp,1,external)
    paths=[]
    for name,ps,ext,direction in [('cooling',np.linspace(p0,coolp,17),0,1),('heated_return',np.linspace(coolp,hotp,33),external,-1)]:
        rows=[state(float(p),ext) for p in ps]
        for a,d in zip(rows[:-1],rows[1:]):
            dQ=d['netHeatFromFluid_J']-a['netHeatFromFluid_J']
            if direction*dQ<=0 or direction*(a['upperTemperature_K']-a['wallTemperature_K'])<-1e-7:
                raise ValueError('Transfer opposed contact temperature or heat-path direction')
            if d['totalEntropyChange_J_K']<a['totalEntropyChange_J_K']-1e-7:raise ValueError('Negative isolated heat-transfer entropy production')
        for f in rows:
            if abs(f['volumeResidual_m3'])>1e-10 or abs(f['totalEnergyResidual_J'])>1e-5:
                raise ValueError('Finite storage conservation failed')
        paths.append(dict(name=name,states=rows))
    if cool['upperLiquidMass_kg']<=0 or paths[1]['states'][-1]['upperQuality']!=1:
        raise ValueError('Wet emergence and dry recovery were not both demonstrated')
    if cold and paths[1]['states'][-1]['lowerTemperatureMax_K']-paths[1]['states'][-1]['lowerTemperatureMin_K']<cfg['coldLowerOffset_K']/2:
        raise ValueError('Independent lower thermal history was erased')
    workChecks=[]
    for endpoint in [cool,paths[1]['states'][-1]]:
        p=endpoint['pressure_MPa']
        integral,error=quad(lambda p:pool(p)['volume'],p0,p,epsabs=1e-12,epsrel=1e-10,limit=100)
        work=(p*endpoint['lowerVolume_m3']-p0*initial['lowerVolume_m3']-integral)*1e6
        poolResidual=endpoint['lowerEnergy_J']-initial['lowerEnergy_J']+work
        upperResidual=endpoint['upperEnergy_J']-initial['upperEnergy_J']-work+endpoint['netHeatFromFluid_J']
        if max(abs(poolResidual),abs(upperResidual))>.05:
            raise ValueError(dict(reason='Independent adiabatic pool/interface work check failed',pressure_MPa=p,
                poolResidual_J=poolResidual,upperResidual_J=upperResidual,quadratureError_J=error*1e6))
        workChecks.append(dict(pressure_MPa=p,integratedSurfaceWork_J=work,
            lowerFirstLawResidual_J=poolResidual,upperFirstLawResidual_J=upperResidual,quadratureErrorEstimate_J=error*1e6))
    return dict(sourceBands=count,materialBands=len(native),quadratureOrder=nq,coldLowerProfile=cold,
        liquidMaterialMass_kg=M,upperMaterialMass_kg=mhead,initialLevelReconstructionDifference_m=initial['level_m']-L,
        fixedWallMass_kg=mw,coolingContact=cool,heatedContact=paths[1]['states'][-1],paths=paths,independentInterfaceWork=workChecks)
cases=[run(r['cellCount'],4,False),run(r['cellCount'],8,False),run(2*r['cellCount'],8,False),run(r['cellCount'],8,True)]
for a,d in zip(cases[:2],cases[1:3]):
    for end in ['coolingContact','heatedContact']:
        for key,tol in [('pressure_MPa',1e-5),('netHeatFromFluid_J',10),('upperLiquidMass_kg',1e-5)]:
            if abs(a[end][key]-d[end][key])>tol:raise ValueError('Storage quadrature/spatial refinement failed: '+key)
print(json.dumps(dict(scope='Finite sealed regional-equilibrium storage in heat coordinates, not a rate or PACTEL transient',
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,
        CoolPropRevision=CP.get_global_param_string('gitrevision'),formulation='HEOS Water (IAPWS-95)',scipy=scipy.__version__,numpy=np.__version__),
    cases=cases,liveModelInstalled=False,heatRateSelected=False,phaseKineticsQualified=False),allow_nan=False))
`

export const phaseStorageCalculation = phaseStorageThermodynamics + phaseStorageReference

if (import.meta.main) {
  const [source, owner, python, ...extra] = process.argv.slice(2)
  if (!source || !owner || !python || extra.length) throw Error('Usage: reference-design-pressurizer-phase-storage.ts <source-page> <state-owner> <python>')
  const page = await Bun.file(owner).text()
  const input = { source: parsePressurizerBoundaries(await Bun.file(source).text()), spatial: parseSpatialBasis(page), phase: parsePhaseStorageBasis(page) }
  const child = Bun.spawn([python, '-c', phaseStorageCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(phaseStorageCalculation), ...JSON.parse(out) }, null, 2))
}
