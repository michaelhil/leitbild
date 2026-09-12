/** Offline, low-Mach supplied-boundary PRHR sizing; never imported by a runtime. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {parsePrhrGeometry,auditPrhrGeometry} from './reference-design-prhr-geometry'
import {poolBoilingPython} from './reference-design-pool-boiling'
const positive=z.number().finite().positive()
const caseSchema=z.object({name:z.string().min(1),pool_C:z.number().finite(),bankEffect:positive.max(1),terminalHead_Pa:z.number().finite(),headerFilmFactor:positive.optional(),cells:z.number().int().min(8).max(256).optional()}).strict()
export function parsePrhrCapacity(text:string){
  const blocks=[...text.matchAll(/^```reference-prhr-capacity\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Exactly one capacity basis required')
  return z.object({primaryPressure_MPa:positive,hot_C:z.number().finite(),containmentPressure_MPa:positive,flowBracket_kg_s:z.tuple([positive,positive]),cells:z.number().int().min(8).max(256),cases:z.array(caseSchema).min(1)}).strict().refine(b=>b.flowBracket_kg_s[1]>b.flowBracket_kg_s[0]&&b.cases.every(c=>b.hot_C>c.pool_C),'Forward cooling and increasing positive bracket required').parse(JSON.parse(blocks[0]![1]!))
}
type SurfaceScreen={unscaledCorrelationScreenRatio:number;insideFilm:{Re:number;Pr:number;turbulentNu:number;naturalNu:number;laminarNu:number}}
export function capacityScreens(surfaces:SurfaceScreen[]){
  if(!surfaces.length)throw Error('Physical surface evidence required')
  const outsideBoilingScreen=surfaces.some(s=>s.unscaledCorrelationScreenRatio>1)
  const outsideForcedFilmScreen=surfaces.some(s=>s.insideFilm.turbulentNu>=Math.max(s.insideFilm.naturalNu,s.insideFilm.laminarNu)&&(s.insideFilm.Re<2300||s.insideFilm.Re>5e6||s.insideFilm.Pr<.5||s.insideFilm.Pr>2000))
  return {outsideBoilingScreen,outsideForcedFilmScreen,scope:outsideBoilingScreen||outsideForcedFilmScreen?'diagnostic-only: selected source screen exceeded':'within selected source screens; not empirical bank or complete cooling qualification'}
}
export const prhrCapacityPython=String.raw`
import json,sys,math,time,platform
import iapws,scipy
from types import SimpleNamespace
from iapws import IAPWS97
from iapws.iapws97 import _Region1,_TSat_P
from iapws._iapws import _Viscosity,_ThCond
from scipy.optimize import brentq
d=json.load(sys.stdin);geo=d['geometry'];t=geo['tubes'];audit=d['audit'];basis=d['basis'];g=9.80665
p=basis['primaryPressure_MPa'];Th=basis['hot_C']+273.15;ks=geo['steelConductivity_W_mK'];N=t['count'];L=audit['tubeLength_m'];cal=geo['calibration'];b={'surfaceFactor':1.}
`+poolBoilingPython+String.raw`
def water(T,P=p):
    if not 273.15<=T<=_TSat_P(P):raise ValueError('Single-phase Region1 sizing domain exceeded')
    w=_Region1(T,P);rho=1/w['v'];mu=_Viscosity(rho,T)
    phase=SimpleNamespace(cp=w['cp'],cp_cv=w['cp']/w['cv'],mu=mu,drhodP_T=rho*w['kt'])
    k=_ThCond(rho,T,phase)
    return dict(rho=rho,mu=mu,k=k,cp=1000*w['cp'],h=1000*w['h'],beta=w['alfav'])
def friction(Re,eps):
    if Re<1:return 64/Re
    A=(2.457*math.log(1/((7/Re)**.9+.27*eps)))**16;B=(37530/Re)**16
    return 8*((8/Re)**12+1/(A+B)**1.5)**(1/12)
def dp_loss(m,w,D,length,K=0):
    if m==0:return 0.
    area=math.pi*D*D/4;v=m/(w['rho']*area);Re=abs(m)*D/(area*w['mu'])
    return (friction(Re,geo['roughness_m']/D)*length/D+K)*w['rho']*v*abs(v)/2
def inside(T,Tw,m,D,details=False):
    bulk=water(T);wall=water(Tw);film=water((T+Tw)/2)
    Pr=bulk['mu']*bulk['cp']/bulk['k'];Prw=wall['mu']*wall['cp']/wall['k'];Re=4*abs(m)/(math.pi*D*bulk['mu'])
    if not .05<=Pr/Prw<=20:raise ValueError('Gnielinski property-ratio domain exceeded')
    # INL Eq234-236: bulk beta/mu/Pr, with density alone at the film temperature.
    Ra=g*bulk['beta']*abs(T-Tw)*D**3/(bulk['mu']/film['rho'])**2*Pr
    nc=max(.59*Ra**.25,.13*Ra**(1/3))
    turbulent=0.
    if Re>1000:
        f=(1.58*math.log(Re)-3.28)**-2
        turbulent=(f/2)*(Re-1000)*Pr/(1+12.7*math.sqrt(f/2)*(Pr**(2/3)-1))*(Pr/Prw)**.11
    h=max(3.66,turbulent,nc)*bulk['k']/D
    return dict(Re=Re,Pr=Pr,PrRatio=Pr/Prw,Ra=Ra,laminarNu=3.66,turbulentNu=turbulent,naturalNu=nc,h_W_m2K=h) if details else h
def station(poolT,z):
    poolWater=water(poolT,basis['containmentPressure_MPa'])
    P=basis['containmentPressure_MPa']+poolWater['rho']*g*(audit['pool']['initialSurface_m']-z)/1e6
    f=IAPWS97(P=P,x=0);v=IAPWS97(P=P,x=1)
    return P,f,v
def pool_flux(Tw,poolT,D,st,effect):
    P,f,v=st
    if Tw<poolT:raise ValueError('This sizing comparison is forward cooling only')
    # Liquid-film reference reaches saturation, not an invalid superheated liquid.
    film=water((poolT+min(Tw,f.T))/2,P)
    Pr=film['mu']*film['cp']/film['k'];nu=film['mu']/film['rho'];alpha=film['k']/(film['rho']*film['cp'])
    Ra=g*film['beta']*(Tw-poolT)*D**3/(nu*alpha)
    Nu=(.6+.387*Ra**(1/6)/(1+(.559/Pr)**(9/16))**(8/27))**2
    h=Nu*film['k']/D
    phi=math.radians(38);F=1-math.exp(-phi**3-.5*phi)
    dOnb=2*h*f.sigma*f.T/(F*F*v.rho*(v.h-f.h)*1000*water(poolT,P)['k'])
    Tonb=poolT+.25*(math.sqrt(dOnb)+math.sqrt(dOnb+4*(f.T-poolT)))**2
    qfc=h*(Tw-poolT)
    q=qfc if Tw<=Tonb else (qfc**3+(pool(P,Tw-f.T,False)-pool(P,Tonb-f.T,False))**3)**(1/3)
    return effect*q
def heat(T,m,Di,Do,poolT,st,effect,primaryFactor=1.):
    # Per metre, radial wall and inside/outside films are in SERIES.
    Rwall=math.log(Do/Di)/(2*math.pi*ks)
    def values(To):
        q=math.pi*Do*pool_flux(To,poolT,Do,st,effect);Ti=To+q*Rwall
        return q,Ti
    outerMax=brentq(lambda To:values(To)[1]-T,poolT,T,xtol=1e-8)
    def res(To):
        q,Ti=values(To)
        return math.pi*Di*primaryFactor*inside(T,Ti,m,Di)*(T-Ti)-q
    To=brentq(res,poolT,outerMax,xtol=1e-8);q,Ti=values(To)
    return q,To,Ti
def surface_diagnostic(name,s,z,T,m,Di,Do,poolT,st,effect,primaryFactor=1.):
    q,To,Ti=heat(T,m,Di,Do,poolT,st,effect,primaryFactor);P,f,v=st
    flux=q/(math.pi*Do);qCHF=.131*(v.h-f.h)*1000*math.sqrt(v.rho)*(g*f.sigma*(f.rho-v.rho))**.25
    return dict(component=name,s_m=s,z_m=z,primary_C=T-273.15,innerWall_C=Ti-273.15,outerWall_C=To-273.15,
      localPoolPressure_MPa=P,localSaturation_C=f.T-273.15,wallSuperheat_K=To-f.T,heatFlux_W_m2=flux,
      saturatedPoolCHFScreen_W_m2=qCHF,actualFluxScreenRatio=flux/qCHF,unscaledCorrelationScreenRatio=flux/effect/qCHF,
      insideFilm=inside(T,Ti,m,Di,True),primaryFilmFactor=primaryFactor)
def z_at(s):
    a=t['straightLeg_m'];r=t['bendRadius_m'];drop=t['top_m']-t['bottom_m'];arc=math.pi*r/2
    if s<=a:return t['top_m'],0.
    if s<=a+arc:
        theta=(s-a)/r;return t['top_m']-r*(1-math.cos(theta)),-math.sin(theta)
    if s<=a+arc+drop-2*r:return t['top_m']-r-(s-a-arc),-1.
    if s<=a+2*arc+drop-2*r:
        theta=(s-a-arc-drop+2*r)/r;return t['bottom_m']+r-r*math.sin(theta),-math.cos(theta)
    return t['bottom_m'],0.
def solve_case(case,cells):
    poolT=case['pool_C']+273.15;effect=case['bankEffect'];dpTerm=case['terminalHead_Pa'];headerFactor=case.get('headerFilmFactor',1.)
    # Geometry breakpoints are integration boundaries, not interpolated elevation jumps.
    a=t['straightLeg_m'];r=t['bendRadius_m'];drop=t['top_m']-t['bottom_m'];arc=math.pi*r/2
    breaks=[0,a,a+arc,a+arc+drop-2*r,a+2*arc+drop-2*r,L]
    nodes=[]
    for lo,hi in zip(breaks[:-1],breaks[1:]):
        n=max(1,math.ceil(cells*(hi-lo)/L));nodes.extend(lo+(hi-lo)*j/n for j in range(n))
    nodes.append(L)
    hot=water(Th);stTop=station(poolT,t['top_m']);stBottom=station(poolT,t['bottom_m'])
    # Only geometry-fixed pool properties are reused. No rounded live fluid-state cache.
    stations={s:station(poolT,z_at(s)[0]) for lo,hi in zip(nodes[:-1],nodes[1:]) for s in [lo,(lo+hi)/2,hi]}
    def trial(m,detail=False):
        hD=geo['header']['id_m'];hO=geo['header']['od_m'];hL=geo['header']['length_m']
        def header(Tin,st):
            wi=water(Tin)
            def f(T):return m*(wi['h']-water(T)['h'])-hL*heat(T,m/2,hD,hO,poolT,st,effect,headerFactor)[0]
            T=brentq(f,poolT+1e-5,Tin,xtol=1e-8)
            return T,m*(wi['h']-water(T)['h'])
        top,Qtop=header(Th,stTop);surfaces=[]
        if detail:surfaces.append(surface_diagnostic('upper-header',0,t['top_m'],top,m/2,hD,hO,poolT,stTop,effect,headerFactor))
        state=[top,0.,0.,0.];peakFlux=0.
        def rhs(s,y):
            T=y[0];w=water(T);q,To,Ti=heat(T,m/N,t['id_m'],t['od_m'],poolT,stations[s],effect)
            return [-q/(m/N*w['cp']),q*N,w['rho']*g*z_at(s)[1],dp_loss(m/N,w,t['id_m'],1)]
        for lo,hi in zip(nodes[:-1],nodes[1:]):
            if detail:surfaces.append(surface_diagnostic('tube',lo,z_at(lo)[0],state[0],m/N,t['id_m'],t['od_m'],poolT,stations[lo],effect))
            ds=hi-lo;mid=(lo+hi)/2;k1=rhs(lo,state)
            k2=rhs(mid,[v+ds*k/2 for v,k in zip(state,k1)])
            k3=rhs(mid,[v+ds*k/2 for v,k in zip(state,k2)])
            k4=rhs(hi,[v+ds*k for v,k in zip(state,k3)])
            state=[v+ds*(a+2*b+2*c+d)/6 for v,a,b,c,d in zip(state,k1,k2,k3,k4)]
            peakFlux=max(peakFlux,k1[1]/(N*math.pi*t['od_m']),k2[1]/(N*math.pi*t['od_m']),k3[1]/(N*math.pi*t['od_m']),k4[1]/(N*math.pi*t['od_m']))
        tubeOut,Qintegral,hydroTube,dpTube=state
        bottom,Qbottom=header(tubeOut,stBottom);cold=water(bottom)
        if detail:
            surfaces.append(surface_diagnostic('tube',L,z_at(L)[0],tubeOut,m/N,t['id_m'],t['od_m'],poolT,stBottom,effect))
            surfaces.append(surface_diagnostic('lower-header',L,t['bottom_m'],bottom,m/2,hD,hO,poolT,stBottom,effect,headerFactor))
        # Mean header path loss for selected mixed/equal-flow reduction; no asserted maldistribution bound.
        dpHeaders=0.
        for j in range(24):
            f=(j+.5)/24
            dpHeaders+=dp_loss(m*f,water(top),hD,hL/24)*f+dp_loss(m*f,cold,hD,hL/24)*f
        wc=water((top+tubeOut)/2);dpTube+=dp_loss(m/N,wc,t['id_m'],0,2*t['bendLoss_K']+t['entryExitLoss_K'])
        dpConnect=dp_loss(m,hot,geo['hotConnector']['id_m'],geo['hotConnector']['length_m'],geo['connectorLoss_K']/2)+dp_loss(m,cold,geo['coldConnector']['id_m'],geo['coldConnector']['length_m'],geo['connectorLoss_K']/2)
        dpMeter=cal['meterDrop_Pa']*(m/cal['flow_kg_s'])**2*cal['density_kg_m3']/cold['rho']
        dpValve=audit['calibration']['selectedValveDrop_Pa']*(m/cal['flow_kg_s'])**2*cal['density_kg_m3']/hot['rho']
        # Terminal head is relative to a same-density hydrostatic baseline, not a second 12m buoyancy source.
        hydro=hot['rho']*g*(t['top_m']-geo['hotTerminal_m'])+hydroTube+cold['rho']*g*(geo['coldTerminal_m']-t['bottom_m'])
        terminalStatic=dpTerm+hot['rho']*g*(geo['coldTerminal_m']-geo['hotTerminal_m'])
        available=terminalStatic-hydro;loss=dpHeaders+dpTube+dpConnect+dpMeter+dpValve
        totalQ=m*(hot['h']-cold['h']);Qtubes=m*(water(top)['h']-water(tubeOut)['h'])
        return dict(flow_kg_s=m,topHeader_C=top-273.15,tubeOutlet_C=tubeOut-273.15,outlet_C=bottom-273.15,heat_W=totalQ,
          tubeHeat_W=Qtubes,topHeaderHeat_W=Qtop,bottomHeaderHeat_W=Qbottom,integratedTubeHeat_W=Qintegral,
          tubeEnergyResidual_W=Qtubes-Qintegral,availableHead_Pa=available,loss_Pa=loss,headResidual_Pa=available-loss,
          peakTubeFlux_W_m2=peakFlux,surfaces=surfaces,headerLoss_Pa=dpHeaders,meterDP_Pa=dpMeter,valveDP_Pa=dpValve,
          omittedMechanicalEnergyScale_W=m*(abs(terminalStatic)/min(hot['rho'],cold['rho'])+g*(t['top_m']-geo['hotTerminal_m'])+.5*(m/(min(hot['rho'],cold['rho'])*math.pi*geo['hotConnector']['id_m']**2/4))**2))
    # Freeze an operational sizing bracket, refuse if no forward root; no enlarged fallback bracket.
    m=brentq(lambda m:trial(m)['headResidual_Pa'],basis['flowBracket_kg_s'][0],basis['flowBracket_kg_s'][1],xtol=1e-5)
    answer=trial(m,True)
    if abs(answer['tubeEnergyResidual_W'])>1e-4*answer['heat_W']:raise ValueError('Axial enthalpy/heat screen failed')
    if abs(answer['headResidual_Pa'])>1:raise ValueError('Hydraulic closure screen failed')
    return dict(case,**dict(cells=cells,**answer))
propertyChecks=[]
for P,T in [(15.,300.),(15.,450.),(15.,550.),(15.,593.15),(.12,300.),(.12,365.)]:
    actual=water(T,P);ref=IAPWS97(P=P,T=T)
    for key,expected in [('rho',ref.rho),('mu',ref.mu),('k',ref.k),('cp',ref.cp*1000),('h',ref.h*1000),('beta',ref.alfav)]:
        error=abs(actual[key]-expected)/abs(expected)
        if error>1e-11:raise ValueError('Fast property access disagrees with complete IF97 '+key)
        propertyChecks.append(dict(pressure_MPa=P,temperature_K=T,property=key,relativeError=error))
start=time.monotonic();results=[]
for case in basis['cases']:
    try:result=dict(status='completed',**solve_case(case,case.get('cells',basis['cells'])))
    except Exception as e:result=dict(**case,status='refused',reason=str(e))
    results.append(result);progress={k:v for k,v in result.items() if k!='surfaces'}
    print(json.dumps(dict(case=progress,elapsedSeconds=time.monotonic()-start)),file=sys.stderr,flush=True)
print(json.dumps(dict(cases=results,propertyChecks=propertyChecks,elapsedSeconds=time.monotonic()-start,dependencies=dict(python=platform.python_version(),iapws=iapws.__version__,scipy=scipy.__version__),
  scope='Fixed-pressure single-phase low-Mach sizing with mixed headers/equal branch flow, fixed fullywet pool and reduced source-informed films; not a conservative full-pressure transient or empirical bank qualification'),allow_nan=False))
`
if(import.meta.main){
  const [owner,python,...rest]=process.argv.slice(2);if(!owner||!python||rest.length)throw Error('Usage: prhr-capacity <owner.md> <python>')
  const document=await Bun.file(owner).text(),geometry=parsePrhrGeometry(document),audit=auditPrhrGeometry(geometry)
  const basis=parsePrhrCapacity(document),input={geometry,audit,basis},source=await Bun.file(import.meta.path).text()
  const geometrySource=await Bun.file(new URL('./reference-design-prhr-geometry.ts',import.meta.url)).text()
  const child=Bun.spawn([python,'-c',prhrCapacityPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'inherit'})
  const [out,code]=await Promise.all([new Response(child.stdout).text(),child.exited]);if(code)throw Error('Capacity comparison failed')
  if(await Bun.file(import.meta.path).text()!==source)throw Error('Source changed during calculation')
  if(await Bun.file(new URL('./reference-design-prhr-geometry.ts',import.meta.url)).text()!==geometrySource)throw Error('Geometry source changed during calculation')
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const result=JSON.parse(out)
  result.cases=result.cases.map((c:{surfaces?:SurfaceScreen[]})=>c.surfaces?{...c,sourceScreens:capacityScreens(c.surfaces)}:c)
  console.log(JSON.stringify({sourceSha256:hash(source),geometrySourceSha256:hash(geometrySource),calculationSha256:hash(prhrCapacityPython),inputSha256:hash(JSON.stringify(input)),input,...result},null,2))
}
