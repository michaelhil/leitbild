/** Offline normal distributor selection and heater-carrier omission checks; no plant runtime. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {z} from 'zod'
import {loadNormalThermalInput,normalThermalDefinitions,normalThermalPython} from './reference-design-pressurizer-normal-thermal'

export function parseNormalDelivery(text:string) {
  const blocks=[...text.matchAll(/^```reference-pressurizer-normal-delivery\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one normal delivery selection')
  const positive=z.number().finite().positive()
  return z.object({tips:z.number().int().min(2),tipBore_m:positive,tipWaterFlow_m3_s:positive,
    referenceDifferential_Pa:positive,manualConductanceFraction:positive.max(1),
    effectiveDiameterFactor:positive,upflowArea_m2:positive,returnArea_m2:positive,
    circulationLossCoefficient:positive,bubbleDiameter_m:positive}).strict().parse(JSON.parse(blocks[0]![1]!))
}

export function assertDeliveryArea(selection:ReturnType<typeof parseNormalDelivery>,area:number) {
  if(!Number.isFinite(area)||Math.abs(selection.upflowArea_m2+selection.returnArea_m2-area)>1e-12)
    throw Error('Normal carrier must partition the existing net liquid area')
}
export function assertDeliveryParentIds(parents:Record<string,Record<string,unknown>>,tee:Record<string,unknown>,primary:Record<string,unknown>) {
  for(const [name,receipt] of [['tee',tee],['primary',primary]] as const)
    for(const key of ['sourceSha256','calculationSha256','inputSha256'])
      if(typeof receipt[key]!=='string'||parents?.[name]?.[key]!==receipt[key])throw Error('Normal boundary parent identity mismatch')
}

export const normalDeliveryPython=normalThermalDefinitions+String.raw`
selection=d['delivery'];boundary=d['normalBoundary']['cases'][0];pV=boundary['physicalPressureTap_Pa']
if abs(selection['upflowArea_m2']+selection['returnArea_m2']-A)>1e-12:raise ValueError('Normal upflow and return must partition existing net liquid area')
tipCdA=selection['tipWaterFlow_m3_s']*math.sqrt(1000/(2*selection['referenceDifferential_Pa']))
valveCdA=normal['sprayReferenceFlow_kg_s']/math.sqrt(2*source['rho']*normal['sprayReferenceDifferential_Pa'])*selection['manualConductanceFraction']
diameterExponent=math.log(240/180)/math.log(5/2)
def distributor(name,tips,sourceShift=0.):
    upstream=ph(source['p']+sourceShift,source['h']);Hin=upstream['h']+g*zCold
    def trial(q):
        valveDrop=q*q/(2*upstream['rho']*valveCdA*valveCdA)
        line=tube(upstream['p']-valveDrop,Hin,q,normal['sprayInsideDiameter_m'],normal['sprayLength_m'],normal['sprayWallThickness_m'],
            lambda s:zCold+(zSpray-zCold)*s/normal['sprayLength_m'],lambda s:(zSpray-zCold)/normal['sprayLength_m'],0.,1.)
        tipDrop=q*q/(2*line['outlet']['rho']*(tips*tipCdA)**2)
        return line['outlet']['p']-pV-tipDrop,line,valveDrop,tipDrop
    q=brentq(lambda q:trial(q)[0],.02,.15,xtol=1e-11)
    pressureResidual,line,valveDrop,tipDrop=trial(q);H0=line['outlet']['H']-g*zSpray
    boreArea=tips*math.pi*selection['tipBore_m']**2/4
    def exit_state(hh):
        state=ph(pV,hh);velocity=q/(state['rho']*boreArea)
        return hh+velocity*velocity/2-H0,state,velocity
    exitH=brentq(lambda hh:exit_state(hh)[0],H0-1000,H0,xtol=1e-8)
    nozzleEnergy,exitFluid,velocity=exit_state(exitH)
    entropyGain=exitFluid['s']-line['outlet']['s']
    latent=CP.PropsSI('H','P',pV,'Q',1,'Water')-CP.PropsSI('H','P',pV,'Q',0,'Water')
    vaporRho=CP.PropsSI('D','P',pV,'Q',1,'Water');vaporMu=CP.PropsSI('V','P',pV,'Q',1,'Water')
    k=CP.PropsSI('L','P',pV,'T|liquid',exitFluid['T'],'Water');cp=CP.PropsSI('C','P',pV,'T|liquid',exitFluid['T'],'Water')
    sigma=CP.PropsSI('I','T',exitFluid['T'],'Q',0,'Water')
    sourceD=.000240*(tipDrop/200000)**(-diameterExponent)
    mapAdmitted=100000<=tipDrop<=500000
    sensitivity=[]
    for factor in [selection['effectiveDiameterFactor']/2,selection['effectiveDiameterFactor'],selection['effectiveDiameterFactor']*2]:
        diameter=sourceD*factor;thermalTime=exitFluid['rho']*cp*(diameter/2)**2/(math.pi**2*k)
        freeFall=(math.sqrt(velocity*velocity+2*g*(zSpray-(zP+cfg['liquidVolume_m3']/A)))-velocity)/g
        Re=vaporRho*velocity*diameter/vaporMu;We=vaporRho*velocity*velocity*diameter/sigma
        sensitivity.append(dict(diameterFactor=factor,diameter_m=diameter,outsideMapDiagnosticOnly=not mapAdmitted,
            initialConductionTime_s=thermalTime,constantPropertyThreeDecadeTime_s=thermalTime*math.log(1000),
            vacuumArrivalLowerBound_s=freeFall,oldRigidSphereEntryAdmitted=bool(Re<=1000 and We<=1),Re=Re,We=We,
            newSurfacePowerScale_W=q*6*sigma/(exitFluid['rho']*diameter),
            scope='Initial conduction and fastest flight scales only; not integrated growing-drop heat or landing prediction'))
    kineticPower=q*velocity*velocity/2;pressurePower=q*tipDrop/line['outlet']['rho']
    energyPass=bool(abs(line['energyResidual_W'])<=10 and abs(q*nozzleEnergy)<=10 and entropyGain>=0)
    return dict(name=name,activeTips=tips,sourceShift_Pa=sourceShift,flow_kg_s=q,
        hydraulicAdmission=bool(abs(pressureResidual)<=1),energyAccountingAdmission=energyPass,mapPressureDomainAdmitted=mapAdmitted,
        pressureResidual_Pa=pressureResidual,valveDrop_Pa=valveDrop,nozzleDrop_Pa=tipDrop,
        nozzleInletPressure_Pa=line['outlet']['p'],nozzleExitPressure_Pa=pV,
        exitTemperature_K=exitFluid['T'],exitEnthalpy_J_kg=exitH,exitVelocity_m_s=velocity,exitTotalH_J_kg=exitH+velocity*velocity/2+g*zSpray,
        nozzleEnergyResidual_W=q*nozzleEnergy,entropyIncrease_J_kgK=entropyGain,
        lineEnergyResidual_W=line['energyResidual_W'],lineHeatLoss_W=line['heatLoss_W'],lineMass_kg=line['mass_kg'],lineVolume_m3=line['volume_m3'],
        pressureFlowPowerScale_W=pressurePower,exitKineticPower_W=kineticPower,
        pressureEnergyCapacityCheck=bool(kineticPower+max(x['newSurfacePowerScale_W'] for x in sensitivity)<pressurePower),
        sensitivity=sensitivity,fullPrimaryOrPZRNominalResolved=False,highPressureAtomizationQualified=False,
        surfaceTensionScope='Saturation surface tension at exit bulk temperature is a proxy, not a validated high-pressure interface law',
        phaseFlowScope='Achieved boundary-fed hardware flow. Pressure endpoints held from earlier normal state; no new full thermal equilibrium or acquired flow measurement')
cases=[]
for name,tips,shift in [('normal eight tips',selection['tips'],0.),('half tips blocked',selection['tips']//2,0.),('source pressure reduced',selection['tips'],-200000.)]:
    try:cases.append(distributor(name,tips,shift))
    except (ValueError,RuntimeError) as error:cases.append(dict(name=name,hydraulicAdmission=False,failure=str(error)))
cases.append(dict(name='manual upstream isolation',positiveSteadySourceSupply=False,immediateNozzleZeroClaimed=False,
    downstreamLineVolume_m3=math.pi*normal['sprayInsideDiameter_m']**2/4*normal['sprayLength_m'],
    reason='No continuing steady source through the isolated valve. Finite downstream line may discharge; no nozzle-local cap or drain transient is fabricated'))
# A local departure-state omission test, not a frozen-bath trajectory or achieved circulation.
pB=boundary['bottom']['p']*1e6;TsB=CP.PropsSI('T','P',pB,'Q',0,'Water')
rhoG=CP.PropsSI('D','P',pB,'Q',1,'Water');latentB=CP.PropsSI('H','P',pB,'Q',1,'Water')-CP.PropsSI('H','P',pB,'Q',0,'Water')
sigmaB=CP.PropsSI('I','P',pB,'Q',0,'Water');bubble=[]
for subcool in [.01,TsB-boundary['bottom']['T'],5.]:
    T=TsB-subcool;rho=CP.PropsSI('D','P',pB,'T|liquid',T,'Water');mu=CP.PropsSI('V','P',pB,'T|liquid',T,'Water')
    k=CP.PropsSI('L','P',pB,'T|liquid',T,'Water');cp=CP.PropsSI('C','P',pB,'T|liquid',T,'Water');Pr=cp*mu/k
    diameter=selection['bubbleDiameter_m'];R=diameter/2;volume=4*math.pi*R**3/3
    velocity=brentq(lambda v:6*math.pi*mu*R*v*(1+.15*(rho*v*diameter/mu)**.687)-(rho-rhoG)*volume*g,0,2)
    Re=rho*velocity*diameter/mu;Nu=2+.6*math.sqrt(Re)*Pr**(1/3);htc=k*Nu/diameter
    cond=4*math.pi*R*R*htc*subcool/latentB;mass=rhoG*volume;clock=mass/cond;flight=cfg['liquidVolume_m3']/A/velocity
    bubble.append(dict(subcooling_K=subcool,diameter_m=diameter,slipVelocity_m_s=velocity,Re=Re,
        Eotvos=(rho-rhoG)*g*diameter**2/sigmaB,condensationInitial_kg_s=cond,initialMassToCondensationTime_s=clock,
        initialSlipOnlySixMetreTime_s=flight,clockRatio=clock/flight,
        directUnattenuatedEscapeEstablished=False,noSlipEstablished=False,
        scope='Initial property/area/rate clocks only, not constant-bath survival or thermal/velocity equilibrium admission'))
print(json.dumps(dict(scope='Selected normal nozzle hardware/map candidate; heater carrier omission checks, not whole normal pressure support',
    tipCdA_m2=tipCdA,manualCdA_m2=valveCdA,cases=cases,bubbleDepartureChecks=bubble,
    selectedExistingLiquidPartition_m3=dict(upflow=selection['upflowArea_m2']*cfg['liquidVolume_m3']/A,returnFlow=selection['returnArea_m2']*cfg['liquidVolume_m3']/A),
    actualCirculationSolved=False,actualBubbleBirthOrEscapeSolved=False,fullNormalThermalBasisQualified=False,
    flowRootBracket_kg_s=[.02,.15],rootFailureScope='A bracket/solver failure rejects this calculation domain; it does not prove physical no-flow',
    wallSeconds=time.perf_counter()-started),allow_nan=False))
`

export async function runNormalDelivery(wiki:string,python:string,normalPath:string,teePath:string,nominalPath:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const source=await Bun.file(import.meta.path).text(),bytes=await Bun.file(normalPath).text(),normalBoundary=JSON.parse(bytes)
  if(normalBoundary.calculationSha256!==hash(normalThermalPython)||!normalBoundary.cases?.[0]?.energyAccountingAdmission)throw Error('Identified admitted prior normal boundary required')
  const original=await loadNormalThermalInput(wiki,teePath,nominalPath)
  assertDeliveryParentIds(normalBoundary.parentIdentities,original.tee,original.nominal)
  const delivery=parseNormalDelivery(await Bun.file(join(wiki,'systems/primary-coolant/pressurizer-thermal-state.md')).text())
  assertDeliveryArea(delivery,original.pzr.area_m2)
  const input={...original,normalBoundary,delivery},identity={sourceSha256:hash(source),calculationSha256:hash(normalDeliveryPython),inputSha256:hash(JSON.stringify(input)),normalReceiptSha256:hash(bytes)}
  const child=Bun.spawn([python,'-c',normalDeliveryPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  return code?{...identity,completed:false,failure:err}:{...identity,completed:true,...JSON.parse(out)}
}
if(import.meta.main){const [wiki,python,normal,tee,nominal,...rest]=process.argv.slice(2);if(!wiki||!python||!normal||!tee||!nominal||rest.length)throw Error('Usage: normal-delivery <LD01 folder> <python> <normal receipt> <tee receipt> <primary receipt>');console.log(JSON.stringify(await runNormalDelivery(wiki,python,normal,tee,nominal),null,2))}
