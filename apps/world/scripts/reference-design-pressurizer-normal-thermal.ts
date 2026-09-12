/** Offline steady hydraulic/required-duty selection. No phase-rate or full-primary nominal qualification. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { phaseStorageThermodynamics } from './reference-design-pressurizer-phase-storage'
import { regionalHydrostaticsPython } from './reference-design-regional-hydrostatics'
import { primaryTeeLiquidPython } from './reference-design-primary-tee-liquid'
import { bidirectionalTeeDefinitions, parseBidirectionalTee } from './reference-design-primary-tee-bidirectional'
import { sharpCombiningPolynomials, primaryTeePython } from './reference-design-primary-tee'
import { primaryOperatingPointPython } from './reference-design-primary-operating-point'
import { parsePressurizerBasis } from './reference-design-pressurizer'
import { parseSurgeRoute, resolveSurgeRoute, surgeRoutePython } from './reference-design-surge-route'

const positive=z.number().finite().positive()
export function parseNormalThermal(text:string) {
  const blocks=[...text.matchAll(/^```reference-pressurizer-normal-thermal\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-pressurizer-normal-thermal block')
  return z.object({bypassConductanceFraction:positive.max(1),sprayReferenceFlow_kg_s:positive,sprayReferenceDifferential_Pa:positive,
    sprayLength_m:positive,sprayInsideDiameter_m:positive,sprayWallThickness_m:positive,
    vesselThermalWallThickness_m:positive,insulationThickness_m:positive,insulationConductivity_W_mK:positive,
    exteriorCoefficient_W_m2K:positive,liquidContact_W_m2K:positive,vaporContact_W_m2K:positive,
    ambient_K:positive,heaterCapacity_W:positive,heaterProportionalBand_Pa:positive}).strict().parse(JSON.parse(blocks[0]![1]!))
}

export const normalThermalDefinitions=phaseStorageThermodynamics+String.raw`
import time
from scipy.optimize import root
d=json.load(sys.stdin);r=d['route'];cfg=d['pzr'];normal=d['normal'];started=time.perf_counter();g=9.80665
A=cfg['area_m2'];zH=r['sourceElevation_m'];zP=r['receiverElevation_m'];Ap=r['area_m2'];exec(d['routeDefinitions'])
`+regionalHydrostaticsPython+String.raw`
mainFluid=CP.AbstractState('HEOS','Water')
`+primaryTeeLiquidPython+String.raw`
base=d['tee'];before=base['zeroFlow']['before'];after=base['zeroFlow']['after'];pZero=base['zeroFlow']['branchStaticPressure_Pa']
m1=base['cases'][0]['imposedMainMassFlow_kg_s'];Ah=m1/(before['rho']*before['v']);areaRatio=Ah/Ap;poly=d['polynomials']
divZero=[(before['p']+before['dynamic']-after['p']-after['dynamic'])/before['dynamic'],(before['p']+before['dynamic']-pZero)/before['dynamic']]
`+bidirectionalTeeDefinitions+String.raw`
cold=d['cold'];source=ph(cold['p'],cold['h']);zCold=cold['reference_m'];Hcold=source['h']+g*zCold
zSpray=zP+cfg['volume_m3']/A
CdA=normal['sprayReferenceFlow_kg_s']/math.sqrt(2*source['rho']*normal['sprayReferenceDifferential_Pa'])*normal['bypassConductanceFraction']
def steel_K(T):
    if not 300<=T<=650:raise ValueError('Outside owned steel-property interval')
    return 9.705*T+.0176*T*T/2-1.60e-6*T**3/3
def heat_path(T,ri,thickness,length,contact,stress=1.,plate=False):
    Ta=normal['ambient_K'];ro=ri+thickness;ri2=ro+normal['insulationThickness_m']
    if T<=Ta:raise ValueError('Outside selected hot-to-ambient normal sizing regime')
    if plate:
        area=math.pi*ri*ri;Gs=area/thickness;Rc=1/(contact*area)
        Ri=normal['insulationThickness_m']/(normal['insulationConductivity_W_mK']*area);Ra=1/(normal['exteriorCoefficient_W_m2K']*area)
    else:
        Gs=2*math.pi*length/math.log(ro/ri);Rc=1/(contact*2*math.pi*ri*length)
        Ri=math.log(ri2/ro)/(2*math.pi*length*normal['insulationConductivity_W_mK']);Ra=1/(normal['exteriorCoefficient_W_m2K']*2*math.pi*ri2*length)
    def values(Q):return T-Q*Rc,Ta+Q*(Ri+Ra),Ta+Q*Ra
    Q=brentq(lambda Q:Gs*(steel_K(values(Q)[0])-steel_K(values(Q)[1]))-Q,0,(T-Ta)/(Rc+Ri+Ra),xtol=1e-8)
    inner,outer,jacket=values(Q)
    return dict(heat_W=Q*stress,innerSteel_K=inner,outerSteel_K=outer,jacket_K=jacket,
        stressMeaning='Uniform multiplication of ALL effective contact/steel/insulation/exterior conductances; not unchanged physical material with extra heat',
        resistanceResidual_W=(Gs*(steel_K(inner)-steel_K(outer))-Q)*stress)
def native_pool(ps):
    sL=w(ps,x=0).s
    def lower(M):return region(ps,sL,M,False,datum=zP)
    ref=cfg['liquidVolume_m3']*w(ps,x=0).rho
    ML=brentq(lambda M:lower(M)['V']-cfg['liquidVolume_m3'],ref*.9,ref*1.1,xtol=1e-8);lo=lower(ML)
    VU=cfg['volume_m3']-lo['V']
    def upper(M):
        pt=ps-g*M/A/1e6;sU=w(pt,x=1).s
        return region(ps,sU,M,True,datum=zP+lo['V']/A),sU
    ref=VU*w(ps,x=1).rho
    MU=brentq(lambda M:upper(M)[0]['V']-VU,ref*.8,ref*1.2,xtol=1e-8);up,sU=upper(MU)
    return lo,up,liquid(lo['pBottom'],s=sL)
def tube(p,H,q,D,L,wall,z_at,slope,minor,stress):
    if q<=0:raise ValueError('No positive throughflow: this advective normal-state reduction cannot hold a disconnected line warm')
    area=math.pi*D*D/4
    hh=H-g*z_at(0)
    for _ in range(4):state=ph(p,hh);hh=H-g*z_at(0)-.5*(q/(state['rho']*area))**2
    def rhs(x,y):
        state=ph(y[0],y[1]);v=q/(state['rho']*area);Re=q*D/(area*state['mu'])
        friction=math.exp(log_darcy_factor(Re,r['roughness_m']/D))/D+minor/L
        heat=heat_path(state['T'],D/2,wall,1,normal['liquidContact_W_m2K'],stress)['heat_W']
        matrix=[[1-v*v*state['rp'],-v*v*state['rh']],[-v*v/state['rho']*state['rp'],1-v*v/state['rho']*state['rh']]]
        gradients=np.linalg.solve(matrix,[-state['rho']*g*slope(x)-friction*state['rho']*v*v/2,-g*slope(x)-heat/q])
        return [*gradients,heat,area*state['rho'],area*state['rho']*(state['h']-state['p']/state['rho']),area*state['rho']*g*z_at(x),.5*area*state['rho']*v*v]
    solved=solve_ivp(rhs,[0,L],[p,hh,0,0,0,0,0],method='DOP853',rtol=2e-9,atol=[1e-3,1e-6,1e-5,1e-7,1e-2,1e-5,1e-9])
    if not solved.success:raise ValueError(solved.message)
    y=solved.y[:,-1];out=ph(y[0],y[1]);v=q/(out['rho']*area);out['H']=out['h']+v*v/2+g*z_at(L)
    return dict(outlet=out,heatLoss_W=y[2],mass_kg=y[3],internalEnergy_J=y[4],potentialEnergy_J=y[5],kineticEnergy_J=y[6],
        energyResidual_W=q*(H-out['H'])-y[2],volume_m3=area*L,steelMass_kg=7920*math.pi*((D/2+wall)**2-(D/2)**2)*L,
        inletTemperature_K=ph(p,hh)['T'],calls=len(solved.t),endVelocity_m_s=v)
def route_slope(x):
    if x<=r['risingStart_m']:return 0.
    if x<=r['verticalStart_m']:return math.sin((x-r['risingStart_m'])/r['bendRadius_m'])
    return 1.
def evaluate(x,stress):
    ps=x[0];q=x[1];lo,up,bottom=native_pool(ps)
    if q<=0:raise ValueError('Nonpositive bypass flow')
    pb=bottom['p']*1e6;Hb=bottom['h']+g*zP;vb=q/(bottom['Mrho']*Ap)
    # Finite-velocity inlet acceleration plus the actual PZR entrance. Tee replaces the old HOT discharge K.
    pLine=pb-(1+r['entryLoss'])*bottom['Mrho']*vb*vb/2
    L=r['developedLength_m']
    surge=tube(pLine,Hb,q,r['internalDiameter_m'],L,r['wallThickness_m'],lambda s:route_elevation(r,L-s),lambda s:-route_slope(L-s),2*r['elbowLoss'],stress)
    tee=matched_tee(q,surge['outlet']['H'])
    if not tee['accepted']:raise ValueError('Normal return tee not admitted')
    valveDrop=q*q/(2*source['rho']*CdA*CdA)
    spray=tube(source['p']-valveDrop,Hcold,q,normal['sprayInsideDiameter_m'],normal['sprayLength_m'],normal['sprayWallThickness_m'],
        lambda s:zCold+(zSpray-zCold)*s/normal['sprayLength_m'],lambda s:(zSpray-zCold)/normal['sprayLength_m'],0.,stress)
    residual=np.array([surge['outlet']['p']-tee['branch']['p'],spray['outlet']['p']-up['pTop']*1e6])
    return residual,dict(ps=ps,q=q,lower=lo,upper=up,bottom=bottom,surge=surge,spray=spray,tee=tee,valveDrop_Pa=valveDrop)
def solve_case(stress):
    solution=root(lambda x:evaluate(x,stress)[0]/1e5,[base['phaseInitial']['pressureSurface_Pa']/1e6,.10],tol=1e-10)
    residual,x=evaluate(solution.x,stress);q=x['q'];lo=x['lower'];up=x['upper'];Ts=w(x['ps'],x=0).T
    ri=math.sqrt(A/math.pi);wall=normal['vesselThermalWallThickness_m'];height=cfg['liquidVolume_m3']/A
    lowPaths=[heat_path((lo['Tmin']+lo['Tmax'])/2,ri,wall,height,normal['liquidContact_W_m2K'],stress),heat_path(x['bottom']['T'],ri,wall,1,normal['liquidContact_W_m2K'],stress,True)]
    upperPaths=[heat_path((up['Tmin']+up['Tmax'])/2,ri,wall,cfg['volume_m3']/A-height,normal['vaporContact_W_m2K'],stress),heat_path(up['Tmin'],ri,wall,1,normal['vaporContact_W_m2K'],stress,True)]
    QL=sum(p['heat_W'] for p in lowPaths);QU=sum(p['heat_W'] for p in upperPaths)
    zi=zP+height;HF=h(w(x['ps'],x=0))+g*zi;HG=h(w(x['ps'],x=1))+g*zi
    Hb=x['bottom']['h']+g*zP;Hs=x['spray']['outlet']['H']
    requiredGamma=(q*(HF-Hs)+QU)/(HG-HF)
    heater=q*(Hb-Hs)+QL+QU
    upperResidual=requiredGamma*HG+q*Hs-(q+requiredGamma)*HF-QU
    lowerResidual=heater+(q+requiredGamma)*HF-requiredGamma*HG-q*Hb-QL
    ambient=QL+QU+x['spray']['heatLoss_W']+x['surge']['heatLoss_W']
    primaryGain=q*(x['surge']['outlet']['H']-Hcold)
    energyResiduals=[upperResidual,lowerResidual,x['spray']['energyResidual_W'],x['surge']['energyResidual_W'],heater-ambient-primaryGain]
    x.update(solverSuccess=bool(solution.success),solverMessage=str(solution.message),pressureResidual_Pa=residual.tolist(),
        hydraulicAdmission=bool(max(abs(residual))<=1),requiredHeater_W=heater,heaterCapacityMargin_W=normal['heaterCapacity_W']-heater,
        energyAccountingAdmission=bool(max(abs(v) for v in energyResiduals)<10),powerResidualScreen_W=10,
        requiredEvaporationAndCondensation_kg_s=requiredGamma,requiredPoolReceipt_kg_s=q+requiredGamma,
        lowerAmbient_W=QL,upperAmbient_W=QU,wallPaths=lowPaths+upperPaths,regionalEnergyResidual_W=[lowerResidual,upperResidual],
        totalAmbient_W=ambient,primaryThermalReturn_W=primaryGain,wholePathEnergyResidual_W=heater-ambient-primaryGain,
        thermalScope='Required regional steady transfers, not achieved droplet, boiling, slip or wall-film rates; no global saturation reset')
    return x
`
export const normalThermalPython=normalThermalDefinitions+String.raw`cases=[]
for stress in [1.,2.]:
    try:cases.append(dict(effectiveThermalConductanceMultiplier=stress,**solve_case(stress)))
    except (ValueError,RuntimeError) as error:cases.append(dict(effectiveThermalConductanceMultiplier=stress,hydraulicAdmission=False,failure=str(error)))
normalCase=cases[0]
if normalCase.get('hydraulicAdmission'):
    setpoint=normalCase['upper']['pTop']*1e6+normal['heaterProportionalBand_Pa']*normalCase['requiredHeater_W']/normal['heaterCapacity_W']
    for case in cases:
        if 'ps' not in case:continue
        measuredPressure=case['upper']['pTop']*1e6
        demand=min(1.,max(0.,(setpoint-measuredPressure)/normal['heaterProportionalBand_Pa']))*normal['heaterCapacity_W']
        case.update(commissionedSetpoint_Pa=setpoint,physicalPressureTap_Pa=measuredPressure,pressureTapElevation_m=zSpray,availableAutomaticHeater_W=demand,
            automaticSteadyEnergyDeficit_W=case['requiredHeater_W']-demand,withinHeaterCapacity=bool(0<=case['requiredHeater_W']<=normal['heaterCapacity_W']),
            automaticDutyFeasibility=bool(abs(case['requiredHeater_W']-demand)<10 and 0<=case['requiredHeater_W']<=normal['heaterCapacity_W']),
            phaseRateFeasibilityEstablished=False)
    cases.extend([dict(name='Manual bypass isolated',hydraulicAdmission=False,steadyStateAdmitted=False,
        reason='Zero throughflow needs a separate conductive/natural-exchange line state; the advective normal reduction does not hold its old temperatures'),
        dict(name='Heater supply unavailable at normal state',steadyStateAdmitted=False,actualPower_W=0,requiredPower_W=normalCase['requiredHeater_W'],
            reason='Nonzero physical heat demand cannot be supplied; no predicted subsequent pressure trajectory')])
print(json.dumps(dict(scope='Frozen-primary boundary sizing: coupled spray/return hydraulics and required thermal duty, not full-primary or phase-rate steady qualification',
    selectedBypassCdA_m2=CdA,sourceCold=source,cases=cases,
    parentIdentities={name:{k:value[k] for k in ['sourceSha256','calculationSha256','inputSha256']} for name,value in [('tee',base),('primary',d['nominal'])]},
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,scipy=scipy.__version__,numpy=np.__version__),wallSeconds=time.perf_counter()-started),allow_nan=False))
`

export async function loadNormalThermalInput(wiki:string,teePath:string,nominalPath:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const tee=await Bun.file(teePath).json(),nominal=await Bun.file(nominalPath).json()
  const page=await Bun.file(join(wiki,'systems/primary-coolant/pressure-and-inventory.md')).text()
  const thermal=await Bun.file(join(wiki,'systems/primary-coolant/pressurizer-thermal-state.md')).text()
  const route=resolveSurgeRoute(parseSurgeRoute(await Bun.file(join(wiki,'systems/primary-coolant/surge-route.md')).text()))
  if (!nominal.accepted || !tee.endpoint?.withinExistingPressureGate || tee.calculationSha256!==hash(primaryTeePython)
    || nominal.calculationSha256!==hash(primaryOperatingPointPython)
    || ['sourceSha256','calculationSha256','inputSha256'].some(k=>tee.inputNominalIdentity?.[k]!==nominal[k])) throw Error('Frozen primary/tee identities differ or are not admitted')
  const cold=nominal.result.mixing.find((x:any)=>x.owner==='COLD.A/B')
  if(!cold)throw Error('Physical cold header not found')
  const m=tee.cases[0].imposedMainMassFlow_kg_s,before=tee.zeroFlow.before,Ah=m/(before.rho*before.v)
  const input={tee,nominal,cold,route,pzr:parsePressurizerBasis(page),teeSelection:parseBidirectionalTee(page),normal:parseNormalThermal(thermal),routeDefinitions:surgeRoutePython,polynomials:sharpCombiningPolynomials(Ah/route.area_m2)}
  if(input.normal.sprayLength_m<=route.receiverElevation_m+input.pzr.volume_m3/input.pzr.area_m2-cold.reference_m)throw Error('Spray developed length cannot be shorter than its rise')
  return input
}

export async function runNormalThermal(wiki:string,python:string,teePath:string,nominalPath:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const source=await Bun.file(import.meta.path).text(),input=await loadNormalThermalInput(wiki,teePath,nominalPath)
  const identity={sourceSha256:hash(source),calculationSha256:hash(normalThermalPython),inputSha256:hash(JSON.stringify(input)),
    operatingStateScope:'Frozen primary and tee input identities, with current emitted calculation parity; not a re-solved full-primary normal state',
    controllerEvidenceScope:'automaticDutyFeasibility is continuous, unquantized physical-pressure sizing only, not acquired-control steady qualification; selected 1 kPa resolution implies 30 kW demand increments before lag/sample interaction'}
  const p=Bun.spawn([python,'-c',normalThermalPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited])
  if(code!==0)return {...identity,accepted:false,failure:err}
  return {...identity,...JSON.parse(out)}
}
if(import.meta.main) {
  const [wiki,python,tee,nominal,...extra]=Bun.argv.slice(2)
  if(!wiki||!python||!tee||!nominal||extra.length)throw Error('Usage: pressurizer-normal-thermal.ts <LD01-directory> <research-python> <tee-receipt> <primary-receipt>')
  console.log(JSON.stringify(await runNormalThermal(wiki,python,tee,nominal),null,2))
}
