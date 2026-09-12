/** Offline finite-rate PZR interface selection. No plant transient or imposed phase demand. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {poolBoilingPython} from './reference-design-pool-boiling'
import {normalThermalPython} from './reference-design-pressurizer-normal-thermal'
import {parseNormalPhase} from './reference-design-pressurizer-normal-phase'
import {parseNormalDelivery} from './reference-design-pressurizer-normal-delivery'
import {parsePressurizerBasis} from './reference-design-pressurizer'

export function parseMovingPhase(text:string) {
  const blocks=[...text.matchAll(/^```reference-pressurizer-moving-phase\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Exactly one moving-phase selection required')
  const positive=z.number().finite().positive()
  return z.object({contact_W_m2K:positive,contactAngle_deg:positive.max(180),detachmentFraction:z.number().finite().min(0).max(1),
    bubbleDiameter_m:positive,vaporInterface_W_m2K:positive,freeSurfaceLayer_m:positive,maximumVoidFraction:positive.max(.05),
    comparisonRequests_W:z.tuple([positive,positive]),occupiedHeight_m:positive,rodBottom_m:z.number().finite()}).strict().parse(JSON.parse(blocks[0]![1]!))
}
export function phaseThermalSources(ql:number,qv:number,hf:number,hg:number) {
  if(![ql,qv,hf,hg].every(Number.isFinite)||hg<=hf)throw Error('Finite phase state and positive latent enthalpy required')
  const gamma=(ql+qv)/(hg-hf)
  return {gamma,liquid:-ql-gamma*hf,vapor:-qv+gamma*hg}
}
export function rodContact(count:number,diameter:number,length:number,bottom:number,surface:number) {
  if(![count,diameter,length,bottom,surface].every(Number.isFinite)||!Number.isInteger(count)||count<=0||diameter<=0||length<=0)throw Error('Finite physical rods required')
  const crossSection=count*Math.PI*(diameter/2)**2,wetLength=Math.max(0,Math.min(length,surface-bottom))
  return {submergedVolume:crossSection*wetLength,exposedVolume:crossSection*(length-wetLength),wetArea:count*Math.PI*diameter*wetLength,
    surfaceSolidArea:surface>bottom&&surface<bottom+length?crossSection:0}
}
export function occupiedGeometry(area:number,upflowArea:number,height:number,vesselHeight:number,bubbleVolume:number,aboveLiquidVolume:number,submergedSolidVolume:number,exposedSolidVolume:number) {
  if(![area,upflowArea,height,vesselHeight,bubbleVolume,aboveLiquidVolume,submergedSolidVolume,exposedSolidVolume].every(Number.isFinite)||area<=upflowArea||upflowArea<=0||height<=0||height>=vesselHeight||submergedSolidVolume<0||exposedSolidVolume<0||bubbleVolume<0||bubbleVolume+submergedSolidVolume>=upflowArea*height||aboveLiquidVolume<0||aboveLiquidVolume+exposedSolidVolume>=area*(vesselHeight-height))throw Error('Disjoint physical occupied volumes required')
  return {upflow:upflowArea*height,upflowFluid:upflowArea*height-submergedSolidVolume,return:(area-upflowArea)*height,bulkLiquid:area*height-bubbleVolume-submergedSolidVolume,
    dispersedVapor:bubbleVolume,submergedSolid:submergedSolidVolume,exposedSolid:exposedSolidVolume,aboveLiquid:aboveLiquidVolume,upperVapor:area*(vesselHeight-height)-aboveLiquidVolume-exposedSolidVolume}
}

export const movingPhaseDefinitions=String.raw`
import json,sys,math,time,platform
import CoolProp,CoolProp.CoolProp as CP,scipy
from scipy.optimize import brentq
from scipy.integrate import quad
d=json.load(sys.stdin);started=time.perf_counter();sel=d['selection'];b=d['heater'];base=d['thermal']['cases'][0]
p=base['bottom']['p']*1e6;g=9.80665;Au=d['delivery']['upflowArea_m2'];Ar=d['delivery']['returnArea_m2'];H=sel['occupiedHeight_m']
vesselHeight=d['pzr']['volume_m3']/(Au+Ar);z0=base['pressureTapElevation_m']-vesselHeight
rodArea=b['heaterElements']*math.pi*(b['heaterDiameter_m']/2)**2
rodTop=sel['rodBottom_m']+b['heaterLength_m'];eta=z0+H
if not z0<=sel['rodBottom_m']<rodTop<=eta<z0+vesselHeight or rodArea>=Au:raise ValueError('This normal comparison requires an immersed physical bank inside the gross shell')
solidVolume=rodArea*b['heaterLength_m'];upflowFluidVolume=Au*H-solidVolume
def sat(key,x=0):return CP.PropsSI(key,'P',p,'Q',x,'Water')
Ts=sat('T');hf=sat('H');hg=sat('H',1);hfg=hg-hf;rg=sat('D',1);sigma=sat('I');kf=sat('L')
def liquid(T):
    if T>Ts:raise ValueError('Actual liquid state above saturation is outside this closure')
    def prop(key):return sat(key) if T==Ts else CP.PropsSI(key,'P',p,'T|liquid',T,'Water')
    return dict(T=T,h=prop('H'),u=prop('U'),rho=prop('D'),cp=prop('C'),k=prop('L'),mu=prop('V'))
`+poolBoilingPython+String.raw`
Aw=b['heaterElements']*math.pi*b['heaterDiameter_m']*b['heaterLength_m'];T0=base['bottom']['T']
if not .01<=p/1e6<=.9*22.064:raise ValueError('Pool law pressure scope exceeded')
def wall(Tw,l,hc,chi,wet=True):
    if not wet:return dict(total=0.,boiling=0.,birth=0.,liquidEnergy=0.,vaporEnergy=0.,onset=None)
    phi=math.radians(sel['contactAngle_deg']);F=1-math.exp(-phi**3-.5*phi)
    d0=2*hc*sigma*Ts/(F*F*rg*hfg*kf)
    Ton=Ts+.5*(d0+math.sqrt(d0*d0+4*d0*(Ts-l['T'])))
    qc=hc*(Tw-l['T'])
    if Tw<=Ton:qtotal=qc;qb=0.
    else:
        # CTF onset/cubic shape, with this PZR's explicit effective contact in place of forced convection.
        enhancement=pool(p/1e6,Tw-Ts)-pool(p/1e6,Ton-Ts)
        qtotal=(qc**3+enhancement**3)**(1/3)
        qb=enhancement**3/(qtotal*qtotal+qtotal*qc+qc*qc)
    Q=Aw*qtotal;B=Aw*qb;birth=chi*B/(hg-l['h'])
    # Actual subcooled donor h, not an unowned saturated microlayer.
    liquidEnergy=(Q-chi*B)-birth*l['h'];vaporEnergy=birth*hg
    return dict(total=Q,boiling=B,birth=birth,liquidEnergy=liquidEnergy,vaporEnergy=vaporEnergy,onset=Ton)
def slip(l,D):
    def force(v):
        Re=l['rho']*v*D/l['mu'];drag=3*math.pi*l['mu']*D*v*(1+.15*Re**.687)
        return drag-(l['rho']-rg)*g*math.pi*D**3/6
    v=brentq(force,0.,2.,xtol=1e-13);Re=l['rho']*v*D/l['mu'];We=l['rho']*v*v*D/sigma
    return v,Re,We
def cloud(l,D,birth,ul):
    v,Re,We=slip(l,D);Pr=l['cp']*l['mu']/l['k'];htc=l['k']/D*(2+.6*math.sqrt(Re)*Pr**(1/3))
    areaPerMass=6/(rg*D);loss=areaPerMass*htc*(Ts-l['T'])/hfg;escape=Au*(ul+v)/upflowFluidVolume
    # Supplied constant liquid/motion/saturated-bubble boundaries; not an advanced finite pool.
    rate=loss+escape;M=birth/rate;cond=loss*M;delivery=escape*M;alpha=M/(rg*upflowFluidVolume)
    t=60.;end=M*(-math.expm1(-rate*t));integrated=quad(lambda tt:M*(-math.expm1(-rate*tt)),0,t,epsabs=1e-10)[0]
    massResidual=birth*t-end-rate*integrated
    finiteMassRate=birth-rate*end
    bubbleHRate=finiteMassRate*hg;volumeRate=finiteMassRate/rg
    nativeURate=finiteMassRate*(hg-p/rg)
    return dict(suppliedLiquidVelocity_m_s=ul,slip_m_s=v,Re=Re,We=We,liquidInterface_W_m2K=htc,
      conditionalRetainedVapor_kg=M,conditionalVoidFraction=alpha,conditionalCondensation_kg_s=cond,
      conditionalEscape_kg_s=delivery,escapeFraction=delivery/birth if birth else 0.,
      birthRemovalTime_s=1/rate,escapeResidence_s=1/escape,condensationCoefficient_s=loss,
      conditionalBubbleEnergy_J=M*(hg-p/rg),conditionalBubbleVolume_m3=M/rg,
      finiteCloudAt60s_kg=end,massIntegralResidual_kg=massResidual,
      initialMassRate_kg_s=birth,initialNativeEnergyRate_W=birth*(hg-p/rg),initialPressureVolumeWork_W=p*birth/rg,initialEnthalpyRate_W=birth*hg,
      initialNativeWorkResidual_W=birth*(hg-p/rg)+p*birth/rg-birth*hg,
      finiteMassRateAt60s_kg_s=finiteMassRate,finiteNativeEnergyRate_W=nativeURate,finitePressureVolumeWork_W=p*volumeRate,finiteEnthalpyRate_W=bubbleHRate,
      nativePressureWorkResidual_W=nativeURate+p*volumeRate-bubbleHRate,
      omittedSurfaceEnergyPerMass_J_kg=areaPerMass*sigma,
      constantStateLiquidHeatGain_W=cond*hfg,
      domainAdmitted=bool(Re<=1000 and We<=1 and alpha<=sel['maximumVoidFraction']),
      actualFinitePoolAdvanced=False,actualCirculationSolved=False)
def case(name,power,T=T0,hfactor=1.,chi=None,dfactor=1.):
    l=liquid(T);hc=sel['contact_W_m2K']*hfactor;chi=sel['detachmentFraction'] if chi is None else chi
    if not 0<=power<=b['normalBankCapacity_W']:raise ValueError('Normal 120 kW bank only')
    Tw=brentq(lambda Tw:wall(Tw,l,hc,chi)['total']-power,l['T'],Ts+10.,xtol=1e-11)
    w=wall(Tw,l,hc,chi);clouds=[cloud(l,sel['bubbleDiameter_m']*dfactor,w['birth'],ul) for ul in [0.,.2]]
    remaining=w['total']-chi*w['boiling'];res=w['liquidEnergy']+w['vaporEnergy']-w['total']
    return dict(name=name,power_W=power,liquidTemperature_K=T,liquidSubcooling_K=Ts-T,wallTemperature_K=Tw,
      onsetTemperature_K=w['onset'],effectiveContact_W_m2K=hc,detachmentFraction=chi,diameter_m=sel['bubbleDiameter_m']*dfactor,
      totalWallHeat_W=w['total'],availableBoilingEnhancement_W=w['boiling'],detachmentHeat_W=chi*w['boiling'],
      remainingSensibleHeat_W=remaining,wallBirth_kg_s=w['birth'],liquidEnergySource_W=w['liquidEnergy'],vaporEnergySource_W=w['vaporEnergy'],
      wallEnergyResidual_W=res,wallRootResidual_W=w['total']-power,
      rateAccountingAdmitted=bool(abs(res)<=10 and abs(w['total']-power)<=10 and remaining>=0),
      normalSteadySteelSizingOnly=True,clouds=clouds)
P=base['requiredHeater_W'];low,high=sel['comparisonRequests_W']
`
export const movingPhasePython=movingPhaseDefinitions+String.raw`cases=[case('normal',P),case('lower acquired request',low),case('higher acquired request',high),case('colder liquid',P,T0-5),
  case('saturated liquid',P,Ts),case('half contact',P,hfactor=.5),case('double contact',P,hfactor=2),
  case('half detachment',P,chi=.5),case('half diameter',P,dfactor=.5),case('double diameter',P,dfactor=2)]
normal=cases[0];l=liquid(T0);hot=wall(normal['wallTemperature_K'],l,sel['contact_W_m2K'],sel['detachmentFraction'])
coldWall=wall(T0,l,sel['contact_W_m2K'],sel['detachmentFraction'])
support=[dict(name='loss of electrical support, retained hot wet steel',electricalPower_W=0.,wallHeat_W=hot['total'],steelEnergyRate_W=-hot['total'],wallBirth_kg_s=hot['birth'],birthImmediatelyZero=False),
  dict(name='uncovered hot steel',electricalPower_W=0.,wetWallHeat_W=0.,wetWallBirth_kg_s=0.,storedSteelEnergyRetained=True,dryGasHeatLawAdmitted=False),
  dict(name='cold wet steel, no power',electricalPower_W=0.,wallHeat_W=coldWall['total'],wallBirth_kg_s=coldWall['birth'])]
stefan=[]
for name,dl,dv in [('equal interface temperatures',0.,0.),('condensation',-.1,0.),('evaporation from vapor sensible heat',0.,1.)]:
    area=Au+Ar;hlSurface=kf/sel['freeSurfaceLayer_m'];ql=area*hlSurface*dl;qv=area*sel['vaporInterface_W_m2K']*dv;gamma=(ql+qv)/hfg
    el=-ql-gamma*hf;ev=-qv+gamma*hg
    stefan.append(dict(name=name,area_m2=area,liquidInterface_W_m2K=hlSurface,liquidHeat_W=ql,vaporHeat_W=qv,gamma_kg_s=gamma,liquidEnergy_W=el,vaporEnergy_W=ev,residual_W=el+ev))
# Surface movement: the outward ALE flux contains +p*w, hence the owner's RHS is -p*w.
work=[]
for height,speed in [(height,speed) for height in [H,.5] for speed in [-.001,0.,.001]]:
    openUp=Au-(rodArea if sel['rodBottom_m']<z0+height<rodTop else 0.)
    VuDot=openUp*speed;VrDot=Ar*speed;VgDot=-(openUp+Ar)*speed
    work.append(dict(occupiedHeight_m=height,surfaceOpenArea_m2=openUp+Ar,surfaceVelocity_m_s=speed,upflowVolumeRate_m3_s=VuDot,returnVolumeRate_m3_s=VrDot,upperVolumeRate_m3_s=VgDot,
      lowerWork_W=-p*(VuDot+VrDot),upperWork_W=-p*VgDot,volumeResidual_m3_s=VuDot+VrDot+VgDot,workResidual_W=-p*(VuDot+VrDot+VgDot)))
print(json.dumps(dict(cases=cases,supportCases=support,stefanCases=stefan,movingSurfaceCases=work,
  pressure_Pa=p,saturationTemperature_K=Ts,hf_J_kg=hf,hg_J_kg=hg,normalWettedArea_m2=Aw,
  geometry=dict(grossUpflowArea_m2=Au,returnArea_m2=Ar,occupiedHeight_m=H,rodBottom_m=sel['rodBottom_m'],rodTop_m=rodTop,
    rodCrossSection_m2=rodArea,freeUpflowAreaAtBank_m2=Au-rodArea,submergedSolidVolume_m3=solidVolume,upflowFluidVolume_m3=upflowFluidVolume,
    referenceReturnVolume_m3=Ar*H,grossShellVolume_m3=(Au+Ar)*vesselHeight,liquidVolumeBeforeDispersedVapor_m3=(Au+Ar)*H-solidVolume),
  scope='Constitutive wall/bulk/escape selection and conditional constant-state cloud comparison; no finite pool, steel, circulation or full normal state advanced',
  dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__),wallSeconds=time.perf_counter()-started),allow_nan=False))
`

export async function runMovingPhase(wiki:string,python:string,thermalPath:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const source=await Bun.file(import.meta.path).text(),thermalBytes=await Bun.file(thermalPath).text(),thermal=JSON.parse(thermalBytes)
  if(thermal.calculationSha256!==hash(normalThermalPython))throw Error('Exact retained thermal calculation required')
  const page=await Bun.file(join(wiki,'systems/primary-coolant/pressurizer-thermal-state.md')).text()
  const selection=parseMovingPhase(page),heater=parseNormalPhase(page),delivery=parseNormalDelivery(page)
  const pzr=parsePressurizerBasis(await Bun.file(join(wiki,'systems/primary-coolant/pressure-and-inventory.md')).text())
  if(delivery.upflowArea_m2+delivery.returnArea_m2!==pzr.area_m2)throw Error('Carrier area must partition the vessel once')
  const input={thermal,selection,heater,delivery,pzr};const identity={sourceSha256:hash(source),calculationSha256:hash(movingPhasePython),inputSha256:hash(JSON.stringify(input)),thermalReceiptSha256:hash(thermalBytes)}
  const child=Bun.spawn([python,'-c',movingPhasePython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  return code?{...identity,completed:false,failure:err}:{...identity,completed:true,...JSON.parse(out)}
}
if(import.meta.main){const [wiki,python,thermal,...rest]=process.argv.slice(2);if(!wiki||!python||!thermal||rest.length)throw Error('Usage: moving-phase <LD01 folder> <python> <thermal receipt>');console.log(JSON.stringify(await runMovingPhase(wiki,python,thermal),null,2))}
