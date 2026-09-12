/** Offline finite ceiling collector and normal rain selection; no full-vessel transient. */
import {createHash} from 'node:crypto'
import {dirname,join} from 'node:path'
import {z} from 'zod'
import {wallCirculationDefinitions} from './reference-design-pressurizer-wall-circulation'
import {primaryTeeLiquidPython} from './reference-design-primary-tee-liquid'
import {parseNormalThermal,normalThermalPython} from './reference-design-pressurizer-normal-thermal'
import {parsePressurizerBasis} from './reference-design-pressurizer'
import {parseSurgeRoute,resolveSurgeRoute,surgeRoutePython} from './reference-design-surge-route'

export function parseHeadCollection(text:string) {
  const blocks=[...text.matchAll(/^```reference-pressurizer-head-collection\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-pressurizer-head-collection block')
  const positive=z.number().finite().positive()
  return z.object({capillaryRadiusFactor:positive,inertialDragCoefficient:positive}).strict().parse(JSON.parse(blocks[0]![1]!))
}

export const headCollectionPython=wallCirculationDefinitions+String.raw`
mainFluid=CP.AbstractState('HEOS','Water')
`+primaryTeeLiquidPython+String.raw`
headGas=gas(0);pHead=headGas['p'];headSat=saturation(pHead);TsHead=headSat['T'];latent=CP.PropsSI('H','P',pHead,'Q',1,'Water')-CP.PropsSI('H','P',pHead,'Q',0,'Water')
sigma=CP.PropsSI('I','P',pHead,'Q',0,'Water');lc=math.sqrt(sigma/(g*(headSat['rho']-headSat['rhog'])))
def head_case(geometryScale=1.,dragCoefficient=1.):
    # Fixed number of equivalent catchments, not one object per numerical timestep.
    sizeFactor=geometryScale*data['selection']['capillaryRadiusFactor'];dragCoefficient*=data['selection']['inertialDragCoefficient']
    detachRadius=lc*sizeFactor;pitch=2*math.pi*math.sqrt(3)*detachRadius;sites=math.floor(A/pitch**2)
    if sites<1:raise ValueError('Head cannot contain the selected collector pattern')
    outerRadius=math.sqrt(A/(math.pi*sites))
    if not detachRadius<outerRadius:raise ValueError('Attached-drop region overlaps neighboring catchment')
    RiHead=thermal['insulationThickness_m']/(thermal['insulationConductivity_W_mK']*A);RaHead=1/(thermal['exteriorCoefficient_W_m2K']*A);Gs=A/thermal['vesselThermalWallThickness_m'];Ta=thermal['ambient_K']
    if Ta>=TsHead:raise ValueError('Ceiling condensing branch not admitted with hot ambient')
    def flux(drop):
        film=film_section(pHead,drop);enthalpyDifference=headGas['h']-film['flowH']
        if drop==0:return 0.,film
        Ra=g*headSat['rho']*(headSat['rho']-headSat['rhog'])*enthalpyDifference*lc**3/(headSat['k']*headSat['mu']*drop)
        htc=.26*sizeFactor**(-.25)*headSat['k']/lc*Ra**.25
        return A*htc*drop,film
    Qmax=(TsHead-Ta)/(RiHead+RaHead)
    upper=brentq(lambda drop:flux(drop)[0]-Qmax,0,20,xtol=1e-12)
    def residual(drop):
        Q,_=flux(drop);return Gs*(steelK(TsHead-drop)-steelK(Ta+Q*(RiHead+RaHead)))-Q
    drop=brentq(residual,0,upper,xtol=1e-13);Q,film=flux(drop);htc=Q/(A*drop);rate=Q/(headGas['h']-film['flowH'])
    # Gerstmann's annular delta=a/r. The central attached-drop volume is disjoint.
    annulusA=2*headSat['k']*(outerRadius**3-detachRadius**3)/(3*htc*outerRadius**2)
    filmV=sites*2*math.pi*annulusA*(outerRadius-detachRadius);filmM=film['rho']*filmV
    released=ph(pHead,film['flowH']);dropVolume=2*math.pi*detachRadius**3/3;dropMass=released['rho']*dropVolume
    meanAttachedM=sites*dropMass/2;meanAttachedV=sites*dropVolume/2
    siteRate=rate/sites;cycleTime=dropMass/siteRate
    Qsite=Q/sites;cycleEnergyResidual=dropMass*(headGas['h']-released['h'])-Qsite*cycleTime
    h0=released['h'];m=dropMass;maxRe=maxWe=0.;phaseBound=0.
    def falling(t,y):
        nonlocal maxRe,maxWe,phaseBound
        x,v,dh=y[:3];vg=gas(x);l=ph(vg['p'],h0+dh);R=(3*m/(4*math.pi*l['rho']))**(1/3)
        muV=CP.PropsSI('V','P',vg['p'],'T|gas',vg['T'],'Water')
        Re=vg['rho']*abs(v)*2*R/muV;We=vg['rho']*v*v*2*R/sigma
        maxRe=max(maxRe,Re);maxWe=max(maxWe,We)
        hfLocal=CP.PropsSI('H','P',vg['p'],'Q',0,'Water');hgLocal=CP.PropsSI('H','P',vg['p'],'Q',1,'Water')
        phaseBound=max(phaseBound,(hfLocal-l['h'])/(hgLocal-hfLocal))
        drag=6*math.pi*muV*R*v+.5*dragCoefficient*vg['rho']*math.pi*R*R*v*abs(v)
        acceleration=(1-vg['rho']/l['rho'])*g-drag/m
        hdot=vg['rho']/l['rho']*g*v
        # p*dV/pressure buoyancy are accounted by dh=dp/rho; drag work goes to gas.
        return [v,acceleration,hdot,drag*v/m,1/l['rho'],l['h']-vg['p']/l['rho'],g*vg['z'],.5*v*v,
            vg['rho']/l['rho'],vg['rho']*vg['u']/l['rho'],vg['rho']*g*vg['z']/l['rho']]
    def arrival(t,y):return height-y[0]
    arrival.terminal=True;arrival.direction=-1
    initial=[0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.]
    flight=solve_ivp(falling,[0,120],initial,method='DOP853',rtol=1e-9,atol=1e-10,events=arrival,max_step=.05)
    if not flight.success or not len(flight.t_events[0]):raise ValueError('Selected finite rain did not reach pool within bounded flight comparison')
    y=flight.y[:,-1];time=float(flight.t[-1]);landing=ph(gas(height)['p'],h0+y[2]);energyResidual=y[2]+.5*y[1]**2-g*y[0]+y[3]
    if abs(energyResidual)>.01 or abs(cycleEnergyResidual)>1e-5 or phaseBound>.001:raise ValueError('Collector/flight accounting or omitted phase bound failed')
    pressureVolumeChange=landing['p']/landing['rho']-pHead/released['rho']
    nativeEnergyChange=(landing['h']-landing['p']/landing['rho'])-(released['h']-pHead/released['rho'])+.5*y[1]**2-g*y[0]
    nativeEnergyResidual=nativeEnergyChange+pressureVolumeChange+y[3]
    if abs(nativeEnergyResidual)>.01:raise ValueError('Native drop pressure-displacement/drag work gate failed')
    headEnergyResidual=rate*headGas['h']-rate*released['h']-Q
    headV=filmV+meanAttachedV;headM=filmM+meanAttachedM
    sourceCriterion=headSat['k']*drop/(headSat['mu']*(headGas['h']-released['h']))
    if abs(headEnergyResidual)>10 or abs(residual(drop))>10 or not headV+rate*y[4]<case['upper']['V'] or sourceCriterion>=1 or abs(sites*math.pi*outerRadius**2-A)>1e-10:raise ValueError('Head heat, retained volume, area or source inertial gate failed')
    return dict(geometryScale=geometryScale,dragCoefficient=dragCoefficient,accepted=True,headHeat_W=Q,condensation_kg_s=rate,
        headInnerSteel_K=TsHead-drop,headSubcooling_K=drop,htc_W_m2K=htc,heatBalanceResidual_W=residual(drop),
        capillaryLength_m=lc,sites=sites,catchmentRadius_m=outerRadius,detachmentRadius_m=detachRadius,
        catchmentAreaResidual_m2=sites*math.pi*outerRadius**2-A,detachedMass_kg=dropMass,detachedEquivalentDiameter_m=(6*dropVolume/math.pi)**(1/3),
        thinFilmMass_kg=filmM,meanAttachedDropMass_kg=meanAttachedM,headRetainedVolume_m3=headV,
        headU_J=filmM*film['u']+meanAttachedM*(released['h']-pHead/released['rho']),headPE_J=headM*g*top,
        headDisplacedGas=dict(M=headV*headGas['rho'],U=headV*headGas['rho']*headGas['u'],PE=headV*headGas['rho']*g*top),
        singleSiteCollectionPeriod_s=cycleTime,meanHeadResidence_s=headM/rate,collectionCycleEnergyResidual_J=cycleEnergyResidual,
        headEnergyResidual_W=headEnergyResidual,flightTime_s=time,landingVelocity_m_s=float(y[1]),landingTemperature_K=landing['T'],
        landingTotalH_J_kg=landing['h']+.5*y[1]**2+g*bottom,flightEnergyResidual_J_kg=energyResidual,dragPowerToGas_W=rate*y[3],
        nativeDropEnergyChange_J_kg=nativeEnergyChange,pressureVolumeChange_J_kg=pressureVolumeChange,
        nativeDropEnergyResidual_J_kg=nativeEnergyResidual,pressureDisplacementPowerToGas_W=rate*pressureVolumeChange,
        flightMass_kg=rate*time,flightVolume_m3=rate*y[4],flightU_J=rate*y[5],flightPE_J=rate*y[6],flightKE_J=rate*y[7],
        flightDisplacedGas=dict(M=rate*y[8],U=rate*y[9],PE=rate*y[10]),maxRe=maxRe,maxWe=maxWe,
        omittedAdditionalCondensationMassFractionBound=phaseBound,
        capillaryPressureScale_Pa=2*sigma/detachRadius,surfaceEnergyScale_J_kg=3*sigma/(released['rho']*detachRadius),
        headLumpedElevationEnergyBound_J=headM*g*detachRadius,sourceInertialCriterion=sourceCriterion,
        scope='Source-informed but fictional finite collector geometry and effective rain drag; uniform staggered steady population, not source-validated high-pressure droplet shapes')
cases=[]
for settings in [{},{'dragCoefficient':.5},{'dragCoefficient':2},{'geometryScale':.5},{'geometryScale':2}]:
    try:cases.append(head_case(**settings))
    except (ValueError,RuntimeError) as error:cases.append(dict(settings=settings,accepted=False,failure=str(error)))
print(json.dumps(dict(scope='Head-local thermal, finite collection cycle and adiabatic liquid landing; fixed supplied hydrostatic gas, not whole-PZR equilibrium',
    cases=cases,accepted=all(c['accepted'] for c in cases),originalLaw='Gerstmann1964 Nu=.26 Ra^.25, original capillary normalization; no Argonne pressure correction',
    transportRule='One fixed catchment population with retained liquid mass/energy; threshold shedding transfers actual water to falling owner, never directly to pool',
    noNonvolatileBoronGenerated=True,fullTransientPopulationQualified=False,wallSeconds=time.perf_counter()-started),allow_nan=False))
`
export async function runHeadCollection(page:string,python:string,receipt:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const source=await Bun.file(import.meta.path).text(),bytes=await Bun.file(receipt).text(),thermal=JSON.parse(bytes)
  if(thermal.calculationSha256!==hash(normalThermalPython)||!thermal.cases?.[0]?.energyAccountingAdmission)throw Error('Identified admitted normal thermal boundary required')
  const text=await Bun.file(page).text(),folder=dirname(page),design=parseNormalThermal(text),selection=parseHeadCollection(text),pzr=parsePressurizerBasis(await Bun.file(join(folder,'pressure-and-inventory.md')).text())
  const route=resolveSurgeRoute(parseSurgeRoute(await Bun.file(join(folder,'surge-route.md')).text()))
  const input={thermal,design,selection,pzr,route,routeDefinitions:surgeRoutePython}
  const identity={sourceSha256:hash(source),calculationSha256:hash(headCollectionPython),inputSha256:hash(JSON.stringify(input)),thermalReceiptSha256:hash(bytes)}
  const child=Bun.spawn([python,'-c',headCollectionPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  return code?{...identity,accepted:false,failure:err}:{...identity,...JSON.parse(out)}
}
if(import.meta.main){const [page,python,receipt,...rest]=process.argv.slice(2);if(!page||!python||!receipt||rest.length)throw Error('Usage: head-collection <thermal owner> <python> <normal receipt>');console.log(JSON.stringify(await runHeadCollection(page,python,receipt),null,2))}
