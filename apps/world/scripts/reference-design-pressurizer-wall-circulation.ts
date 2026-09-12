/** Offline hydrostatic wall/film selection. The supplied vapor is a finite-state boundary, not advanced here. */
import {createHash} from 'node:crypto'
import {dirname,join} from 'node:path'
import {phaseStorageThermodynamics} from './reference-design-pressurizer-phase-storage'
import {regionalHydrostaticsPython} from './reference-design-regional-hydrostatics'
import {parseNormalThermal,normalThermalPython} from './reference-design-pressurizer-normal-thermal'
import {parsePressurizerBasis} from './reference-design-pressurizer'
import {parseSurgeRoute,resolveSurgeRoute,surgeRoutePython} from './reference-design-surge-route'

export const wallCirculationDefinitions=phaseStorageThermodynamics+String.raw`
import time
started=time.perf_counter();data=json.load(sys.stdin);case=data['thermal']['cases'][0];cfg=data['pzr'];thermal=data['design'];r=data['route']
g=9.80665;A=cfg['area_m2'];zH=r['sourceElevation_m'];zP=r['receiverElevation_m'];Ap=r['area_m2'];exec(data['routeDefinitions'])
`+regionalHydrostaticsPython+String.raw`
top=case['pressureTapElevation_m'];height=case['upper']['V']/A;bottom=top-height;pTop=case['physicalPressureTap_Pa']/1e6;sGas=w(pTop,x=1).s
gasState=CP.AbstractState('HEOS','Water');gasEntropyResidual=0.
def native_gas(p):
    global gasEntropyResidual
    sat=w(p,x=1)
    if p==pTop:return sat
    if sGas<sat.s:raise ValueError('Supplied hydrostatic gas entropy entered the wet domain')
    # HEOS PS returns quality >1 in its tolerance strip just inside the dry branch.
    # Recover forward PT on the explicitly admitted dry branch, never clip quality.
    T=sat.T+(sGas-sat.s)*1000*sat.T/CP.PropsSI('C','P',p*1e6,'Q',1,'Water')
    gasState.specify_phase(CP.iphase_gas)
    try:
        for _ in range(8):
            gasState.update(CP.PT_INPUTS,p*1e6,T);residual=gasState.smass()-sGas*1000
            if abs(residual)<=1e-9:break
            T-=residual*T/gasState.cpmass()
        if T<sat.T or abs(residual)>1e-9:raise ValueError('Forward dry-gas entropy inversion failed')
        gasEntropyResidual=max(gasEntropyResidual,abs(residual))
        return SimpleNamespace(P=gasState.p()/1e6,T=T,rho=gasState.rhomass(),v=1/gasState.rhomass(),u=gasState.umass()/1000,x=1)
    finally:gasState.unspecify_phase()
hydro=solve_ivp(lambda x,y:[g*native_gas(float(y[0])).rho/1e6],[0,height],[pTop],rtol=1e-11,atol=1e-12,dense_output=True,max_step=height/32)
if not hydro.success:raise ValueError('Supplied native gas hydrostatic reconstruction failed')
def gas(x):
    q=native_gas(float(hydro.sol(x)[0]))
    if q.x!=1:raise ValueError('The declared dry normal gas boundary is no longer dry')
    return dict(p=q.P*1e6,T=q.T,rho=q.rho,h=h(q),u=q.u*1000,z=top-x)
native={key:quad(lambda x:A*gas(x)['rho']*(1 if key=='M' else gas(x)['u'] if key=='U' else g*gas(x)['z']),0,height,epsabs=1e-3)[0] for key in ['M','U','PE']}
bare=dict(pressureBottomResidual_Pa=gas(height)['p']-case['ps']*1e6,**{key+'Residual':native[key]-case['upper'][key] for key in native})
if abs(bare['pressureBottomResidual_Pa'])>1 or abs(bare['MResidual'])>1e-5:raise ValueError('Bare hydrostatic boundary does not reproduce its declared nominal')
liquidState=CP.AbstractState('HEOS','Water');referenceQuad={n:np.polynomial.legendre.leggauss(n) for n in [4,8]}
def saturation(p):
    return dict(T=CP.PropsSI('T','P',p,'Q',0,'Water'),rho=CP.PropsSI('D','P',p,'Q',0,'Water'),
        rhog=CP.PropsSI('D','P',p,'Q',1,'Water'),k=CP.PropsSI('L','P',p,'Q',0,'Water'),mu=CP.PropsSI('V','P',p,'Q',0,'Water'))
def film_section(p,drop,n=4):
    sat=saturation(p);eta,weights=referenceQuad[n];eta=(eta+1)/2;weights=weights/2
    mass=internal=enthalpy=flowMass=flowH=shape2Mass=0.
    for e,weight in zip(eta,weights):
        T=sat['T']-drop*(1-e)
        if T>sat['T']:raise ValueError('Condensing film temperature exceeds local saturation')
        liquidState.specify_phase(CP.iphase_liquid)
        try:liquidState.update(CP.PT_INPUTS,p,T)
        finally:liquidState.unspecify_phase()
        rho=liquidState.rhomass();hh=liquidState.hmass();uu=liquidState.umass();shape=2*e-e*e
        mass+=weight*rho;internal+=weight*rho*uu;enthalpy+=weight*rho*hh
        flowMass+=weight*rho*shape;flowH+=weight*rho*shape*hh;shape2Mass+=weight*rho*shape*shape
    return dict(rho=mass,u=internal/mass,h=enthalpy/mass,flowH=flowH/flowMass,shapeMass=flowMass,shape2Mass=shape2Mass)
def steelK(T):
    if not 300<=T<=650:raise ValueError('Outside selected steel temperature range')
    return 9.705*T+.0176*T*T/2-1.6e-6*T**3/3
ri=math.sqrt(A/math.pi);C=2*math.pi*ri;ro=ri+thermal['vesselThermalWallThickness_m'];rout=ro+thermal['insulationThickness_m']
Rs=math.log(ro/ri)/(2*math.pi);Ri=math.log(rout/ro)/(2*math.pi*thermal['insulationConductivity_W_mK']);Ra=1/(2*math.pi*rout*thermal['exteriorCoefficient_W_m2K'])
def local_wall(p,flow,ambient):
    sat=saturation(p)
    if ambient>=sat['T']:raise ValueError('Ambient does not admit this condensing steady branch')
    B=sat['rho']*(sat['rho']-sat['rhog'])*g/(3*sat['mu']);delta=(flow/(C*B))**(1/3) if flow>0 else 0.
    Re=4*flow/(C*sat['mu']);F=1+1.83e-4*Re;Rfilm=delta/(sat['k']*F*C)
    def values(Q):return sat['T']-Q*Rfilm,ambient+Q*(Ri+Ra)
    Q=brentq(lambda Q:(steelK(values(Q)[0])-steelK(values(Q)[1]))/Rs-Q,0,(sat['T']-ambient)/(Rfilm+Ri+Ra),xtol=1e-8)
    inner,outer=values(Q)
    return dict(QperLength=Q,delta=delta,Re=Re,drop=sat['T']-inner,inner=inner,outer=outer,Ts=sat['T'])
def lateral(n,quadOrder=4):
    dx=height/n;incoming=0.;incomingH=0.;rows=[];sourceEnergy=heat=condensed=0.;filmM=filmU=filmPE=filmV=filmK=0.;gasRemoved={key:0. for key in ['M','U','PE']}
    for i in range(n):
        x0=i*dx;x1=(i+1)*dx;xm=(x0+x1)/2;v=gas(xm);outGas=gas(x1);Hv=v['h']+g*v['z']
        def evaluate(outgoing):
            wall=local_wall(v['p'],(incoming+outgoing)/2,thermal['ambient_K']);drop=wall['drop']
            flowState=film_section(outGas['p'],drop,quadOrder);Ho=flowState['flowH']+g*outGas['z'];Q=wall['QperLength']*dx
            residual=(outgoing-incoming)*Hv+incoming*incomingH-outgoing*Ho-Q
            return residual,wall,Ho,Q
        hi=incoming+.001
        for _ in range(20):
            if evaluate(hi)[0]>0:break
            hi=incoming+2*(hi-incoming)
        else:raise ValueError('No bounded condensing film material root')
        outgoing=brentq(lambda f:evaluate(f)[0],incoming,hi,xtol=1e-14);residual,wall,Ho,Q=evaluate(outgoing)
        if outgoing<incoming or wall['Re']>=1800 or not wall['inner']<wall['Ts'] or abs(residual)>10:raise ValueError('Local condensation, film regime or energy gate failed')
        state=film_section(v['p'],wall['drop'],quadOrder);volume=C*wall['delta']*dx;mass=state['rho']*volume
        # A normalized parabolic velocity profile carries the solved actual mass flux.
        velocityScale=(incoming+outgoing)/(2*C*wall['delta']*state['shapeMass']);kinetic=.5*volume*velocityScale**2*state['shape2Mass']
        filmM+=mass;filmU+=mass*state['u'];filmPE+=mass*g*v['z'];filmV+=volume;filmK+=kinetic
        gasRemoved['M']+=volume*v['rho'];gasRemoved['U']+=volume*v['rho']*v['u'];gasRemoved['PE']+=volume*v['rho']*g*v['z']
        sourceEnergy+=(outgoing-incoming)*Hv;heat+=Q;condensed+=outgoing-incoming
        rows.append(dict(x_m=xm,z_m=v['z'],vaporPressure_Pa=v['p'],vaporTemperature_K=v['T'],localSaturation_K=wall['Ts'],
            innerSteel_K=wall['inner'],wallDrop_K=wall['drop'],filmThickness_m=wall['delta'],filmMass_kg=mass,
            filmInventoryMeanH_J_kg=state['h'],filmFlowH_J_kg=Ho-g*outGas['z'],condensed_kg_s=outgoing-incoming,
            outgoing_kg_s=outgoing,wallHeat_W=Q,energyResidual_W=residual,Re=wall['Re'],
            vaporSuperheat_K=v['T']-wall['Ts'],vaporSuperheatEnergy_W=(outgoing-incoming)*(v['h']-CP.PropsSI('H','P',v['p'],'Q',1,'Water'))))
        incoming=outgoing;incomingH=Ho
    ledger=sourceEnergy-incoming*incomingH-heat
    if abs(ledger)>10 or abs(condensed-incoming)>1e-10 or not filmV<case['upper']['V']:raise ValueError('Whole film accounting/volume failed')
    return dict(cells=n,crossFilmQuadrature=quadOrder,condensed_kg_s=condensed,drain_kg_s=incoming,drainTotalH_J_kg=incomingH,
        heat_W=heat,filmMass_kg=filmM,filmU_J=filmU,filmPE_J=filmPE,filmVolume_m3=filmV,omittedFilmKEEstimate_J=filmK,
        displacedGas=gasRemoved,remainingGas={key:native[key]-gasRemoved[key] for key in native},
        meanFilmDrainTime_s=filmM/incoming,sourceEnergy_W=sourceEnergy,drainEnergy_W=incoming*incomingH,
        energyResidual_W=ledger,maxThinFilmCurvatureRatio=max(row['filmThickness_m']/ri for row in rows),
        vaporSuperheatEnergy_W=sum(row['vaporSuperheatEnergy_W'] for row in rows),rows=rows,accepted=True)
`
export const wallCirculationPython=wallCirculationDefinitions+String.raw`
cases=[lateral(16),lateral(32),lateral(16,8)]
comparisons=[dict(case=k,relativeDifferences={key:abs(cases[k][key]-cases[0][key])/abs(cases[k][key]) for key in ['heat_W','drain_kg_s','filmMass_kg']}) for k in [1,2]]
for c in comparisons:c['passes']=bool(max(c['relativeDifferences'].values())<=.02)
contrary=[]
try:local_wall(gas(0)['p'],.001,gas(0)['T']+1)
except ValueError as error:contrary.append(dict(name='Ambient above local saturation',rejected=True,reason=str(error)))
hot=gas(height/2);sat=saturation(hot['p']);hotWall=sat['T']+.01
contrary.append(dict(name='Preexisting wall hotter than local saturation',wall_K=hotWall,Ts_K=sat['T'],conductiveCondensationDriving_K=sat['T']-hotWall,
    rejectedCondensingBranch=bool(hotWall>=sat['T']),evaporationLawExecuted=False))
print(json.dumps(dict(scope='Steady local hydrostatic lateral film/steel closure; fixed supplied vapor profile, no full-vessel transient',
    bareGasComparison=bare,maxForwardGasEntropyResidual_J_kgK=gasEntropyResidual,cases=cases,comparisons=comparisons,contrary=contrary,
    accepted=all(c['passes'] for c in comparisons),finiteVaporDepletionAdvanced=False,
    assemblyMeaning='Film displaces gas; native owner inventories are newly assembled at the supplied boundary, not a mass-conserving reset of the earlier vessel',
    wallSeconds=time.perf_counter()-started),allow_nan=False))
`

export async function runWallCirculation(page:string,python:string,receipt:string) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const source=await Bun.file(import.meta.path).text(),bytes=await Bun.file(receipt).text(),thermal=JSON.parse(bytes)
  if(thermal.calculationSha256!==hash(normalThermalPython)||!thermal.cases?.[0]?.energyAccountingAdmission)throw Error('Identified admitted normal thermal boundary required')
  const text=await Bun.file(page).text(),design=parseNormalThermal(text)
  const folder=dirname(page),pzr=parsePressurizerBasis(await Bun.file(join(folder,'pressure-and-inventory.md')).text())
  const route=resolveSurgeRoute(parseSurgeRoute(await Bun.file(join(folder,'surge-route.md')).text()))
  const input={thermal,design,pzr,route,routeDefinitions:surgeRoutePython}
  const identity={sourceSha256:hash(source),calculationSha256:hash(wallCirculationPython),inputSha256:hash(JSON.stringify(input)),thermalReceiptSha256:hash(bytes)}
  const child=Bun.spawn([python,'-c',wallCirculationPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  return code?{...identity,accepted:false,failure:err}:{...identity,...JSON.parse(out)}
}
if(import.meta.main){const [page,python,receipt,...rest]=process.argv.slice(2);if(!page||!python||!receipt||rest.length)throw Error('Usage: wall-circulation <thermal owner> <python> <normal receipt>');console.log(JSON.stringify(await runWallCirculation(page,python,receipt),null,2))}
