/** Offline normal-spray rate and heater/film admission discriminator. No whole-PZR transient. */
import {createHash} from 'node:crypto'
import {dirname,join} from 'node:path'
import {z} from 'zod'
import {phaseStorageThermodynamics} from './reference-design-pressurizer-phase-storage'
import {primaryTeeLiquidPython} from './reference-design-primary-tee-liquid'
import {poolBoilingPython} from './reference-design-pool-boiling'
import {normalThermalPython,parseNormalThermal} from './reference-design-pressurizer-normal-thermal'
import {parsePressurizerBasis} from './reference-design-pressurizer'

const positive=z.number().finite().positive()
export function parseNormalPhase(text:string) {
  const blocks=[...text.matchAll(/^```reference-pressurizer-normal-phase\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-pressurizer-normal-phase block')
  const selection=z.object({dropletDiameter_m:positive,postBreakupVelocity_m_s:positive,fallHeight_m:positive,
    heaterElements:z.number().int().positive(),heaterDiameter_m:positive,heaterLength_m:positive,
    heaterPatchRadius_m:positive,normalBankCapacity_W:positive,surfaceFactor:positive}).strict().parse(JSON.parse(blocks[0]![1]!))
  if(selection.heaterPatchRadius_m<=selection.heaterDiameter_m/2)throw Error('Heater patch must contain actual water')
  return selection
}
export const normalPhasePython=phaseStorageThermodynamics+String.raw`
import time
started=time.perf_counter();data=json.load(sys.stdin);b=data['selection'];case=data['thermal']['cases'][0];g=9.80665;zH=case['pressureTapElevation_m']
mainFluid=CP.AbstractState('HEOS','Water')
`+primaryTeeLiquidPython+poolBoilingPython+String.raw`
p=case['physicalPressureTap_Pa'];hf=CP.PropsSI('H','P',p,'Q',0,'Water');hg=CP.PropsSI('H','P',p,'Q',1,'Water')
Ts=CP.PropsSI('T','P',p,'Q',0,'Water');hfg=hg-hf;rv=CP.PropsSI('D','P',p,'Q',1,'Water');muv=CP.PropsSI('V','P',p,'Q',1,'Water')
sigma=CP.PropsSI('I','P',p,'Q',0,'Water');h0=case['spray']['outlet']['h'];q=case['q'];initial=ph(p,h0)
if not h0<hf<hg:raise ValueError('Normal pure-steam subcooled spray domain required')
def droplet(diameter,conductance,rtol=1e-8):
    m0=initial['rho']*math.pi*diameter**3/6;velocity0=b['postBreakupVelocity_m_s'];count=q/m0
    maxRe=0.;maxWe=0.;calls=0
    def state(y):
        h=h0+1e5*y[0];liquid=ph(p,h);m=m0*(hg-h0)/(hg-h)
        radius=(3*m/(4*math.pi*liquid['rho']))**(1/3);velocity=y[1]
        Re=rv*abs(velocity)*2*radius/muv;We=rv*velocity*velocity*2*radius/sigma
        return h,liquid,m,radius,Re,We
    def rhs(t,y):
        nonlocal maxRe,maxWe,calls
        h,l,m,R,Re,We=state(y);calls+=1;maxRe=max(maxRe,Re);maxWe=max(maxWe,We)
        k=CP.PropsSI('L','P',p,'T|liquid',l['T'],'Water');area=4*math.pi*R*R
        liquidHeat=conductance*math.pi**2*k/(3*R)*area*(Ts-l['T'])
        rate=liquidHeat/hfg
        # Incoming condensate is saturated liquid at the interface, not mean drop h.
        hdot=rate*(hg-h)/m
        drag=6*math.pi*muv*R*y[1]*(1+.15*Re**.687)
        acceleration=((m-rv*4*math.pi*R**3/3)*g-drag-rate*y[1])/m
        return [hdot/1e5,acceleration,y[1],rate/m0,rate*hg/m0]
    def near_saturation(t,y):return (hf-h0)*.999-1e5*y[0]
    def arrived(t,y):return b['fallHeight_m']-y[2]
    def drag_domain(t,y):return 1000-state(y)[4]
    def spherical_domain(t,y):return 1-state(y)[5]
    events=[near_saturation,arrived,drag_domain,spherical_domain]
    for event in events:event.terminal=True;event.direction=-1
    init=[0.,velocity0,0.,0.,0.];initialRe=state(init)[4];initialWe=state(init)[5]
    if initialRe>=1000 or initialWe>=1:return dict(diameter_m=diameter,conductanceMultiplier=conductance,admitted=False,
        reason='Initial droplet outside declared drag/spherical screen',Re=initialRe,We=initialWe)
    cp=CP.PropsSI('C','P',p,'T|liquid',initial['T'],'Water');k=CP.PropsSI('L','P',p,'T|liquid',initial['T'],'Water')
    thermalScale=initial['rho']*cp*(diameter/2)**2/(math.pi**2*k*conductance)
    solved=solve_ivp(rhs,[0,60],init,method='DOP853',rtol=rtol,atol=[1e-11,1e-10,1e-11,1e-11,1e-5],
        max_step=min(.02,thermalScale/10),events=events)
    y=solved.y[:,-1];h,l,m,R,Re,We=state(y);t=float(solved.t[-1]);reached=bool(len(solved.t_events[0]))
    massResidual=(m-m0)-m0*y[3];energyResidual=m*h-m0*h0-m0*y[4]
    maximum=m0*(hg-h0)/hfg;remaining=(maximum-m)*count
    fastestArrival=(math.sqrt(velocity0**2+2*g*b['fallHeight_m'])-velocity0)/g
    # Ideal free fall with no buoyancy/drag/mass loading is a lower bound on flight time.
    return dict(diameter_m=diameter,conductanceMultiplier=conductance,admitted=bool(solved.success and reached and t<fastestArrival and abs(energyResidual*count)<10 and abs(massResidual*count)<1e-8),
        reachedNearSaturation=reached,stopTime_s=t,stopDistance_m=float(y[2]),fastestPossibleFlight_s=fastestArrival,
        stopReason=next((name for name,event in zip(['99.9% enthalpy gain','pool arrival','Re domain','We domain'],solved.t_events) if len(event)),str(solved.message)),
        sourceCalls=calls,initialThermalScale_s=thermalScale,stopDiameter_m=2*R,stopTemperature_K=l['T'],maxRe=maxRe,maxWe=maxWe,
        actualCondensationThroughStop_kg_s=(m-m0)*count,remainingCondensationUpperBound_kg_s=remaining,
        massResidualAtSprayScale_kg_s=massResidual*count,energyResidualAtSprayScale_W=energyResidual*count,
        untransferredHeatUpperBound_W=remaining*hfg,mechanicalEnergyScale_W=q*(g*b['fallHeight_m']+.5*max(velocity0,y[1])**2),
        rateIsIndependentOfRequiredGamma=True,fullLandingStateClaimed=False)
spray=[droplet(size,factor) for size in [b['dropletDiameter_m']/2,b['dropletDiameter_m'],b['dropletDiameter_m']*4] for factor in [.5,1.,2.]]
refined=droplet(b['dropletDiameter_m'],1.,1e-10)
# Saturated, quiescent pool branch only: no forced-flow departure law or CHF credit.
elements=b['heaterElements'];R=b['heaterDiameter_m']/2;length=b['heaterLength_m'];area=elements*2*math.pi*R*length
pH=case['bottom']['p']*1e6;TsH=CP.PropsSI('T','P',pH,'Q',0,'Water');hfH=CP.PropsSI('H','P',pH,'Q',0,'Water');hgH=CP.PropsSI('H','P',pH,'Q',1,'Water')
hInitial=case['bottom']['h'];TInitial=case['bottom']['T'];rhoInitial=case['bottom']['Mrho']
if not .01<=pH/1e6<=.9*22.064:raise ValueError('Outside selected Gorenflo pressure range')
def steelK(T):return 9.705*T+.0176*T*T/2-1.60e-6*T**3/3
def steelE(T):return 6.683*T+.04906*T*T/2+80.74*(T*math.log(T)-T)
patchVolume=elements*math.pi*(b['heaterPatchRadius_m']**2-R*R)*length
patchMass=patchVolume*rhoInitial;waterSensible=patchMass*(hfH-hInitial);steelMass=elements*math.pi*R*R*length*7920
if waterSensible<0:raise ValueError('This initial patch must retain actual subcooling')
heater=[]
commands=sorted(x['heaterRequest_W'] for x in data['commands']['commands'])
for duty in [commands[0],case['requiredHeater_W'],commands[1],b['normalBankCapacity_W']]:
    if not 0<duty<=b['normalBankCapacity_W']:raise ValueError('This capacity reference admits the normal bank only')
    flux=duty/area;superheat=brentq(lambda dt:pool(pH/1e6,dt)-flux,0,10,xtol=1e-12);surface=TsH+superheat
    center=brentq(lambda T:steelK(T)-steelK(surface)-flux*R/2,surface,650)
    def temperature(r):return brentq(lambda T:steelK(T)-steelK(surface)-flux*(R*R-r*r)/(2*R),surface,650)
    stored=elements*length*7920*quad(lambda r:2*math.pi*r*(steelE(temperature(r))-steelE(TInitial)),0,R,epsabs=1e-5)[0]
    residual=area*pool(pH/1e6,superheat)-duty;net=duty-case['lowerAmbient_W']
    heater.append(dict(duty_W=duty,area_m2=area,flux_W_m2=flux,surfaceTemperature_K=surface,centerTemperature_K=center,
        saturatedHTC_W_m2K=flux/superheat,belowSourceHTCWarning=bool(flux/superheat<50000),
        waterSensibleRequirement_J=waterSensible,steelSensibleRequirement_J=stored,
        noLossWarmupEnergyLowerBound_s=(waterSensible+stored)/duty,
        constantSteadyLossWarmupScale_s=(waterSensible+stored)/net if net>0 else None,
        saturatedNetEvaporationCeiling_kg_s=max(net,0)/(hgH-hfH),initialSubcooling_K=TsH-TInitial,
        initialEscapedVaporCredited_kg_s=0,rootPowerResidual_W=residual,
        achievedPoolSaturation=False,CHFQualified=False))
# Existing smooth vertical wall law: read-only applicability at the previous prescribed wall state.
wallT=case['wallPaths'][2]['innerSteel_K'];wallP=case['ps']*1e6;Tf=(wallT+CP.PropsSI('T','P',wallP,'Q',0,'Water'))/2
fT=CP.PropsSI('T','P',wallP,'Q',0,'Water');rf=CP.PropsSI('D','P',wallP,'T|liquid',Tf,'Water');rg=CP.PropsSI('D','P',wallP,'Q',1,'Water')
mu=CP.PropsSI('V','P',wallP,'T|liquid',Tf,'Water');k=CP.PropsSI('L','P',wallP,'T|liquid',Tf,'Water')
latent=CP.PropsSI('H','P',wallP,'Q',1,'Water')-CP.PropsSI('H','P',wallP,'Q',0,'Water')
C=2*math.pi*math.sqrt(data['pzr']['area_m2']/math.pi);L=case['upper']['V']/data['pzr']['area_m2'];B=rf*(rf-rg)*g/(3*mu)
outThickness=(4*k*(fT-wallT)*L/(B*latent))**.25
filmRate=C*B*outThickness**3;filmRe=4*filmRate/(C*mu)
wall=dict(scope='Existing smooth gravity-film law at held old lateral steel surface; not re-solved ambient/steel steady balance',
    modeledCondensation_kg_s=filmRate,requiredLateralCondensation_kg_s=case['wallPaths'][2]['heat_W']/latent,
    heatRate_W=filmRate*latent,oldLateralLoss_W=case['wallPaths'][2]['heat_W'],outletThickness_m=outThickness,
    filmInventory_kg=C*rf*L*outThickness*.8,maxFilmRe=filmRe,smoothFilmAdmission=bool(filmRe<30),
    flatTopHeadDrainageSelected=False,actualNormalWallRateAdmitted=False)
# One coupled steady wall calculation: the previous steel T is no longer imposed.
# Existing local wavy-film enhancement only; no new coefficient or added source.
thermal=data['thermalDesign'];ri=C/(2*math.pi);ro=ri+thermal['vesselThermalWallThickness_m'];rout=ro+thermal['insulationThickness_m'];Ta=thermal['ambient_K']
Rs=math.log(ro/ri)/(2*math.pi);Ri=math.log(rout/ro)/(2*math.pi*thermal['insulationConductivity_W_mK']);Ra=1/(thermal['exteriorCoefficient_W_m2K']*2*math.pi*rout)
def wall_flux(gamma):
    perWidth=gamma/C;delta=(perWidth/B)**(1/3) if gamma>0 else 0.;Re=4*perWidth/mu;F=1+1.83e-4*Re
    Rfilm=delta/(k*F*C)
    def values(Q):return fT-Q*Rfilm,Ta+Q*(Ri+Ra)
    Q=brentq(lambda Q:(steelK(values(Q)[0])-steelK(values(Q)[1]))/Rs-Q,0,(fT-Ta)/(Rfilm+Ri+Ra),xtol=1e-8)
    inner,outer=values(Q)
    return Q,delta,Re,inner,outer
def wall_rhs(x,y):
    Q,delta,Re,inner,outer=wall_flux(y[0]);return [Q/latent,C*rf*delta,Q]
wallSolved=solve_ivp(wall_rhs,[0,L],[0.,0.,0.],rtol=1e-8,atol=[1e-12,1e-10,1e-6],max_step=L/40)
wallSamples=[wall_flux(v) for v in wallSolved.y[0]];actualFilm=float(wallSolved.y[0,-1]);actualHeat=float(wallSolved.y[2,-1])
wall['coupledWavy']=dict(condensation_kg_s=actualFilm,heat_W=actualHeat,filmInventory_kg=float(wallSolved.y[1,-1]),
    maxFilmRe=max(x[2] for x in wallSamples),innerSteelRange_K=[min(x[3] for x in wallSamples),max(x[3] for x in wallSamples)],
    latentResidual_W=actualHeat-actualFilm*latent,
    gravityToLatentEnergyRatio=g*L/latent,
    filmSubcoolingJakobScale=CP.PropsSI('C','P',wallP,'T|liquid',Tf,'Water')*(fT-min(x[3] for x in wallSamples))/latent,
    retainedFilmToDrainScale_s=float(wallSolved.y[1,-1])/actualFilm,
    solverSuccess=bool(wallSolved.success),belowTurbulentResearchLimit=bool(max(x[2] for x in wallSamples)<1800),
    sourcePressureExtension=True,flatTopHeadIncluded=False,
    scope='Original fictional normal extension of existing wavy film and actual ambient/steel paths; constant representative vapor and film properties, not measured high-pressure validation')
print(json.dumps(dict(scope='Finite normal-droplet rate; conditional saturated heater capacity; existing film applicability, not complete normal phase equilibrium',
    spray=spray,refinedNominal=refined,heater=heater,heaterGeometry=dict(area_m2=area,steelMass_kg=steelMass,patchVolume_m3=patchVolume,patchMass_kg=patchMass,
        patchIsIsolatedAdmissionFixtureNotAddedPlantInventory=True),wall=wall,
    requiredTotalGamma_kg_s=case['requiredEvaporationAndCondensation_kg_s'],
    suppliedSteamScope='Pure saturated stationary steam at actual upper tap pressure; no noncondensable or pressure transient qualification; no added mass or collective spray entrainment',
    upperHydrostaticComparison=dict(saturationTemperatureSpan_K=CP.PropsSI('T','P',case['upper']['pBottom']*1e6,'Q',0,'Water')-Ts,
        saturatedLiquidEnthalpySpan_J_kg=CP.PropsSI('H','P',case['upper']['pBottom']*1e6,'Q',0,'Water')-hf,
        saturatedVaporEnthalpySpan_J_kg=CP.PropsSI('H','P',case['upper']['pBottom']*1e6,'Q',1,'Water')-hg,
        nominalLiquidResidualTarget_J_kg=.001*(hf-h0),pressureVolumeWorkScale_W=q*(case['upper']['pBottom']*1e6-p)/initial['rho']),
    operatingExclusionsNotExecutedHere=['Uncovered wetted-boiling capacity','Unsupported electrical heat delivery','Backup bank dispatch above120kW','Full20kg/s spray performance'],
    warmupScope='Isobaric water enthalpy plus specified final steel-profile energy: no-loss bound applies to that complete warmed endpoint, not first local nucleation or escaped vapor',
    nominalTimeRefinementDifference_s=refined['stopTime_s']-spray[4]['stopTime_s'],
    completeNormalPhaseClosure=False,dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__,numpy=np.__version__),
    wallSeconds=time.perf_counter()-started),allow_nan=False))
`
export async function runNormalPhase(page:string,python:string,receipt:string,commandReceipt:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const source=await Bun.file(import.meta.path).text(),thermalBytes=await Bun.file(receipt).text(),thermal=JSON.parse(thermalBytes)
  if(thermal.calculationSha256!==hash(normalThermalPython)||!thermal.cases?.[0]?.hydraulicAdmission||!thermal.cases[0].energyAccountingAdmission)throw Error('Identified admitted normal boundary required')
  const commandBytes=await Bun.file(commandReceipt).text(),commands=JSON.parse(commandBytes)
  if(commands.receiptSha256!==hash(thermalBytes)||commands.requiredMeanHeater_W!==thermal.cases[0].requiredHeater_W||commands.commands?.length!==2||commands.commands.some((x:{usable?:boolean,heaterRequest_W?:number})=>!x.usable||!Number.isFinite(x.heaterRequest_W)))throw Error('Two acquired requests tied to this exact normal boundary required')
  const text=await Bun.file(page).text(),selection=parseNormalPhase(text),thermalDesign=parseNormalThermal(text)
  const pzr=parsePressurizerBasis(await Bun.file(join(dirname(page),'pressure-and-inventory.md')).text())
  const input={selection,thermal,thermalDesign,pzr,commands},identity={sourceSha256:hash(source),calculationSha256:hash(normalPhasePython),inputSha256:hash(JSON.stringify(input)),thermalReceiptSha256:hash(thermalBytes),commandReceiptSha256:hash(commandBytes)}
  const child=Bun.spawn([python,'-c',normalPhasePython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  return code?{...identity,completed:false,failure:err}:{...identity,completed:true,...JSON.parse(out)}
}
if(import.meta.main){const [page,python,receipt,commands,...rest]=process.argv.slice(2);if(!page||!python||!receipt||!commands||rest.length)throw Error('Usage: normal-phase <thermal owner> <python> <normal receipt> <acquired command receipt>');console.log(JSON.stringify(await runNormalPhase(page,python,receipt,commands),null,2))}
