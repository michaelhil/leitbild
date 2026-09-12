/** Offline normal spray-field selection; actual nozzle source, supplied hydrostatic vapor. */
import {createHash} from 'node:crypto'
import {dirname,join} from 'node:path'
import {z} from 'zod'
import {wallCirculationDefinitions} from './reference-design-pressurizer-wall-circulation'
import {normalDeliveryPython} from './reference-design-pressurizer-normal-delivery'
import {normalThermalPython,parseNormalThermal} from './reference-design-pressurizer-normal-thermal'
import {parsePressurizerBasis} from './reference-design-pressurizer'
import {parseSurgeRoute,resolveSurgeRoute,surgeRoutePython} from './reference-design-surge-route'

export function parseSprayTransfer(text:string) {
  const blocks=[...text.matchAll(/^```reference-pressurizer-spray-transfer\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Exactly one normal spray-transfer selection required')
  return z.object({tipRingRadius_m:z.number().finite().nonnegative(),coneHalfAngle_deg:z.number().finite().positive().lt(90),
    diameterFactor:z.number().finite().positive(),flightHorizon_s:z.number().finite().positive()}).strict().parse(JSON.parse(blocks[0]![1]!))
}
export function assertSprayParents(thermal:{calculationSha256?:string},delivery:{calculationSha256?:string,normalReceiptSha256?:string},thermalBytes:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  if(thermal.calculationSha256!==hash(normalThermalPython)||delivery.calculationSha256!==hash(normalDeliveryPython)||delivery.normalReceiptSha256!==hash(thermalBytes))throw Error('Exact hydraulic/thermal parent identities required')
}

export const sprayTransferDefinitions=wallCirculationDefinitions+String.raw`
from scipy.integrate import Radau
mainFluid=CP.AbstractState('HEOS','Water')
selection=data['selection'];delivery=data['delivery'];theta=math.radians(selection['coneHalfAngle_deg']);ring=selection['tipRingRadius_m']
if ring>=ri:raise ValueError('Tip ring lies outside gross vessel')
satFluid=CP.AbstractState('HEOS','Water')
def liquid(p,T,Ts):
    if not T<Ts:raise ValueError('Actual spray temperature outside selected subcooled liquid branch')
    mainFluid.specify_phase(CP.iphase_liquid)
    try:
        mainFluid.update(CP.PT_INPUTS,p,T)
        return dict(p=p,T=T,h=mainFluid.hmass(),u=mainFluid.umass(),rho=mainFluid.rhomass(),cp=mainFluid.cpmass(),
          hp=mainFluid.first_partial_deriv(CP.iHmass,CP.iP,CP.iT),k=mainFluid.conductivity())
    finally:mainFluid.unspecify_phase()
def local(x):
    v=gas(x);p=v['p'];satFluid.update(CP.PQ_INPUTS,p,0.)
    sf=dict(T=satFluid.T(),h=satFluid.hmass(),dT_dp=satFluid.first_saturation_deriv(CP.iT,CP.iP),sigma=satFluid.surface_tension())
    hg=CP.PropsSI('H','P',p,'Q',1,'Water');return v,sf,hg

def flight(source,sizeFactor=1.,heatFactor=1.,dragFactor=1.,stepFactor=1.):
    if not source.get('mapPressureDomainAdmitted',False):return dict(name=source['name'],admitted=False,stage='source pressure/map',reason='Actual hydraulic flow exists, but this normal atomization boundary is not selected below its pressure domain')
    if not source['hydraulicAdmission'] or not source['energyAccountingAdmission']:raise ValueError('Hydraulic nozzle source was not admitted')
    diameter=next(s['diameter_m'] for s in source['sensitivity'] if s['diameterFactor']==selection['diameterFactor'])*sizeFactor
    initialGas,sf,hg=local(0.);p0=initialGas['p'];h0=source['exitEnthalpy_J_kg'];v0=source['exitVelocity_m_s'];q=source['flow_kg_s']
    T0=source['exitTemperature_K']
    l0=liquid(p0,T0,sf['T'])
    if abs(l0['h']-h0)>1e-7:raise ValueError('Initial forward enthalpy residual')
    if abs(p0-source['nozzleExitPressure_Pa'])>1 or abs(h0+.5*v0*v0+g*top-source['exitTotalH_J_kg'])>.001:raise ValueError('Tip physical plane disagrees with frozen hydraulic source')
    deficit0=sf['h']-h0;theta0=sf['T']-T0;maxRe=maxWe=0.;calls=0;minDeficit=deficit0;accepted=[]
    def evaluate(y):
        x,r,vx,vz,M,logTheta=y[:6];v,sat,hg=local(x);theta=math.exp(logTheta);T=sat['T']-theta;l=liquid(v['p'],T,sat['T']);deficit=sat['h']-l['h']
        if deficit<=0:raise ValueError('Forward liquid enthalpy no longer below saturation')
        return v,sat,hg,l,deficit,theta
    def rhs(t,y):
        nonlocal maxRe,maxWe,calls,minDeficit
        calls+=1
        if time.perf_counter()-started>120:raise ValueError('Frozen 120 s total execution budget exceeded')
        x,r,vx,vz,M,logTheta=y[:6];v,sat,hg,l,deficit,theta=evaluate(y)
        if M<=0:raise ValueError('Finite dispersed liquid exhausted')
        speed=math.hypot(vx,vz);mu=CP.PropsSI('V','P',v['p'],'T|gas',v['T'],'Water');kv=CP.PropsSI('L','P',v['p'],'T|gas',v['T'],'Water');cpv=CP.PropsSI('C','P',v['p'],'T|gas',v['T'],'Water')
        kl=l['k'];Re=v['rho']*speed*diameter/mu;We=v['rho']*speed*speed*diameter/sat['sigma']
        maxRe=max(maxRe,Re);maxWe=max(maxWe,We);minDeficit=min(minDeficit,deficit)
        area=6*M/(l['rho']*diameter);projected=area/4
        cd=max(24/Re*(1+.15*Re**.687),.44) if speed else 0.
        drag=.5*dragFactor*v['rho']*cd*projected*speed*speed
        fx=-drag*vx/speed if speed else 0.;fz=-drag*vz/speed if speed else 0.
        # Selected dilute-field adaptation: actual slip for drag; no terminal-speed reset/floor.
        terminal=.6*sat['sigma']**.316*(g*(l['rho']-v['rho']))**.228/(v['rho']**.456*mu**.0879)
        ReHeat=v['rho']*min(speed,terminal)*diameter/mu;Pr=cpv*mu/kv;blowing=(v['h']-hg)/(hg-sat['h'])
        hL=heatFactor*2*math.pi**2*kl/diameter;hV=kv/diameter*(2+.57*math.sqrt(ReHeat)*Pr**(1/3))/(1+blowing)**.7
        QL=-area*hL*theta;QV=area*hV*(v['T']-sat['T']);c=-(QL+QV)/(hg-sat['h'])
        # Condensation donor is stationary gas; evaporation donor moves with liquid.
        donorK=0. if c>=0 else .5*speed*speed;mixing=.5*c*speed*speed if c>0 else 0.
        pdot=v['rho']*g*vz;volume=M/l['rho'];thermal=-QL+c*deficit+mixing
        thetaDot=(sat['dT_dp']+(l['hp']-1/l['rho'])/l['cp'])*pdot-thermal/(M*l['cp'])
        logThetaDot=thetaDot/theta
        ax=(fx-c*vx)/M if c>=0 else fx/M
        az=(1-v['rho']/l['rho'])*g+(fz-c*vz)/M if c>=0 else (1-v['rho']/l['rho'])*g+fz/M
        thermalAndMass=c*(hg+donorK+g*v['z'])+QV;dragPower=drag*speed
        # E_native + pV changes by incoming total-H/heat minus actual drag work.
        return [vz,vx,ax,az,c,logThetaDot,
          thermalAndMass,dragPower,c,M,volume,M*l['u'],M*g*v['z'],M*.5*speed*speed,
          v['rho']*volume,v['rho']*volume*v['u'],v['rho']*volume*g*v['z'],QV,mixing]
    def arrival(t,y):return height-y[0]
    def wall_hit(t,y):return ri-y[1]
    for event in [arrival,wall_hit]:event.terminal=True;event.direction=-1
    y0=[0.,ring,v0*math.sin(theta),v0*math.cos(theta),1.,math.log(theta0)]+[0.]*13
    class RecordingRadau(Radau):
        def step(self):
            message=super().step()
            if self.status!='failed':accepted.append(dict(t_s=float(self.t),state=self.y.tolist()))
            return message
    try:solved=solve_ivp(rhs,[0,selection['flightHorizon_s']],y0,method=RecordingRadau,rtol=2e-7,atol=1e-9,events=[arrival,wall_hit],max_step=.15*stepFactor,dense_output=True)
    except (ValueError,RuntimeError,OverflowError) as error:
        return dict(name=source['name'],sizeFactor=sizeFactor,heatFactor=heatFactor,dragFactor=dragFactor,stepFactor=stepFactor,admitted=False,stage='finite spray evaluation',failure=str(error),sourceCalls=calls,acceptedHistory=accepted,lastAccepted=accepted[-1] if accepted else None)
    y=solved.y[:,-1];v,sat,hg,l,deficit,temperatureDeficit=evaluate(y);duration=float(solved.t[-1]);speed=math.hypot(y[2],y[3]);M=float(y[4])
    # solve_ivp locates the physical event inside its final accepted solver step.
    # Preserve that bracketing step separately, never call its below-pool tail
    # an accepted part of the spray flight.
    eventBracketingStep=accepted[-1] if accepted and accepted[-1]['t_s']>duration else None
    accepted=[row for row in accepted if row['t_s']<duration]+[dict(t_s=duration,state=y.tolist(),physicalEndpoint=True)]
    E0=l0['u']+.5*v0*v0+g*top;E=M*(l['u']+.5*speed*speed+g*v['z']);pV0=p0/l0['rho'];pV=v['p']*M/l['rho']
    nativeResidual=E-E0+pV-pV0-y[6]+y[7];massResidual=M-1-y[8]
    surface0=6*sf['sigma']/(l0['rho']*diameter);surfaceFinal=6*sat['sigma']*M/(l['rho']*diameter)
    snapshots=[]
    for t in [0.,.01,.1,1.,10.,duration]:
        if t<=duration:
            yy=solved.sol(t);vv,ss,hh,ll,dd,tt=evaluate(yy)
            snapshots.append(dict(t_s=t,z_m=vv['z'],radius_m=float(yy[1]),horizontalVelocity_m_s=float(yy[2]),downwardVelocity_m_s=float(yy[3]),massRatio=float(yy[4]),temperature_K=ll['T'],enthalpyDeficit_J_kg=dd))
    landed=bool(len(solved.t_events[0]));hit=bool(len(solved.t_events[1]));near=deficit/deficit0<=.001
    dilute=q*y[10]/case['upper']['V']<=.01
    accounting=bool(abs(q*nativeResidual)<=10 and abs(q*massResidual)<=1e-8)
    admitted=bool(solved.success and landed and not hit and near and dilute and accounting and q*abs(surfaceFinal-surface0)<=10)
    return dict(name=source['name'],sizeFactor=sizeFactor,heatFactor=heatFactor,dragFactor=dragFactor,stepFactor=stepFactor,admitted=admitted,
      solverSuccess=solved.success,solverMessage=str(solved.message),reachedPool=landed,wallIntercepted=hit,nearSaturatedLanding=near,diluteMeanOccupancy=dilute,energyMassAccountingAdmitted=accounting,
      diameter_m=diameter,flow_kg_s=q,initialRe=maxRe if not snapshots else v0*initialGas['rho']*diameter/CP.PropsSI('V','P',p0,'Q',1,'Water'),maxRe=maxRe,maxWe=maxWe,
      flightTime_s=duration,maxRadius_m=max(float(solved.y[1].max()),ring),wallRadius_m=ri,landingMassFlow_kg_s=q*M,condensation_kg_s=q*(M-1),
      landingTotalH_J_kg=l['h']+.5*speed*speed+g*v['z'],landingTemperature_K=l['T'],landingTemperatureDeficit_K=temperatureDeficit,landingEnthalpyDeficit_J_kg=deficit,initialEnthalpyDeficit_J_kg=deficit0,
      retainedSprayMass_kg=q*y[9],retainedSprayVolume_m3=q*y[10],retainedSprayU_J=q*y[11],retainedSprayPE_J=q*y[12],retainedSprayKE_J=q*y[13],
      displacedGas=dict(M=q*y[14],U=q*y[15],PE=q*y[16]),nativeEnergyResidual_W=q*nativeResidual,massResidual_kg_s=q*massResidual,
      pressureVolumeBoundaryIncrement_W=q*(pV-pV0),dragPowerToGas_W=q*y[7],vaporSensibleHeatToInterface_W=q*y[17],mixingHeatToLiquid_W=q*y[18],
      surfaceEnergyChangeScale_W=q*abs(surfaceFinal-surface0),nozzleConeTurningReaction_N=q*v0*(1-math.cos(theta)),sourceCalls=calls,steps=len(solved.t),snapshots=snapshots,acceptedHistory=accepted,eventBracketingStep=eventBracketingStep,
      suppliedVaporAdvanced=False,normalCirculationSolved=False,scope='Finite effective spray field at supplied hydrostatic vapor, not rigid droplets or resolved sheet breakup; all retained water lands or reaches a named wall event')
`
export const sprayTransferPython=sprayTransferDefinitions+String.raw`rows=[]
for name,size,heat,drag,step in [('normal eight tips',1.,1.,1.,1.),('normal eight tips',2.,.5,.5,1.),('half tips blocked',1.,1.,1.,1.),('source pressure reduced',1.,1.,1.,1.),('normal eight tips',1.,1.,1.,.5)]:
    try:rows.append(flight(next(c for c in delivery['cases'] if c['name']==name),size,heat,drag,step))
    except (ValueError,RuntimeError,OverflowError) as error:
        import traceback
        rows.append(dict(name=name,sizeFactor=size,heatFactor=heat,dragFactor=drag,admitted=False,stage='finite spray evaluation',failure=str(error),traceback=traceback.format_exc()))
refinement=None
if rows[0].get('admitted') and rows[-1].get('admitted'):
    errors={k:abs(rows[-1][k]-rows[0][k])/abs(rows[0][k]) for k in ['flightTime_s','landingMassFlow_kg_s','condensation_kg_s','retainedSprayMass_kg']}
    refinement=dict(relativeDifferences=errors,accepted=max(errors.values())<=.02)
print(json.dumps(dict(cases=rows,refinement=refinement,historyFields=['xDown_m','radius_m','vx_m_s','vzDown_m_s','massRatio','logTemperatureDeficit_K','incomingTotalHIntegral_Jkg','dragIntegral_Jkg','condensedMassRatio','massTimeIntegral_s','volumeTimeIntegral_m3s_kg','internalEnergyTimeIntegral_Js_kg','potentialEnergyTimeIntegral_Js_kg','kineticEnergyTimeIntegral_Js_kg','displacedGasMassTimeIntegral_s','displacedGasUTimeIntegral_Js_kg','displacedGasPETimeIntegral_Js_kg','vaporHeatIntegral_Jkg','mixingHeatIntegral_Jkg'],sourceAdaptation='INL2017 dispersed-drag Eq122/123 and finite-area/heat Eq204–211; actual-slip drag, maintained selected d32, dilute effective normal spray field',
  bareHydrostaticBoundary=bare,normalThermalEquilibriumSolved=False,wallSeconds=time.perf_counter()-started),allow_nan=False,default=lambda value:value.item() if isinstance(value,np.generic) else str(value)))
`

export async function runSprayTransfer(page:string,python:string,thermalPath:string,deliveryPath:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const source=await Bun.file(import.meta.path).text(),thermalBytes=await Bun.file(thermalPath).text(),deliveryBytes=await Bun.file(deliveryPath).text()
  const thermal=JSON.parse(thermalBytes),delivery=JSON.parse(deliveryBytes);assertSprayParents(thermal,delivery,thermalBytes)
  const text=await Bun.file(page).text(),folder=dirname(page),design=parseNormalThermal(text),selection=parseSprayTransfer(text)
  const pzr=parsePressurizerBasis(await Bun.file(join(folder,'pressure-and-inventory.md')).text()),route=resolveSurgeRoute(parseSurgeRoute(await Bun.file(join(folder,'surge-route.md')).text()))
  const input={thermal,delivery,design,selection,pzr,route,routeDefinitions:surgeRoutePython}
  const identity={sourceSha256:hash(source),calculationSha256:hash(sprayTransferPython),inputSha256:hash(JSON.stringify(input)),thermalReceiptSha256:hash(thermalBytes),deliveryReceiptSha256:hash(deliveryBytes)}
  const child=Bun.spawn([python,'-c',sprayTransferPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  return code?{...identity,completed:false,failure:err}:{...identity,completed:true,...JSON.parse(out)}
}
if(import.meta.main){const [page,python,thermal,delivery,...rest]=process.argv.slice(2);if(!page||!python||!thermal||!delivery||rest.length)throw Error('Usage: spray-transfer <thermal owner> <python> <thermal receipt> <delivery receipt>');console.log(JSON.stringify(await runSprayTransfer(page,python,thermal,delivery),null,2))}
