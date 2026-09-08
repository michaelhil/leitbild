/** Finite two-material-zone comparison, never an installed tank mixing law. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { cmtStratificationDefinitions, parseStratificationBasis } from './reference-design-cmt-stratification.ts'

const positive=z.number().finite().positive()
const schema=z.object({ maximumStep_s:positive.max(.25), pressureDifference_Pa:positive,
  interfaceDifference_m:positive, massResidual_kg:positive, energyResidual_J:positive }).strict()
export function parseMaterialBasis(document:string) {
  const blocks=[...document.matchAll(/^```reference-cmt-material\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected one reference-cmt-material numeric block')
  return {...parseStratificationBasis(document),material:schema.parse(JSON.parse(blocks[0]![1]!))}
}

export const materialCalculation=cmtStratificationDefinitions+String.raw`
A=10.;Vtank=60.;ztop=12.;zbottom=6.

def one(p,T,V,H,z,top):return state(vessel([V],[H],[z],top),[p,T])

def material_state(y):
    pm,tm,pt,tb,th,tc,vh,pd,td=y
    if not 0<=vh<Vtank:raise ValueError('Material interface left admitted tank interior')
    main=one(pm,tm,b['primaryVolume_m3'],0,3.,3.)
    bal=one(pt,tb,1.,0,12.,12.)
    # Zero inventory has no temperature/entropy/EOS equation. No epsilon seed.
    hot=one(pt,th,vh,vh/A,ztop-vh/(2*A),ztop) if vh>0 else None
    pi=hot['pbottom'] if hot is not None else pt
    vc=Vtank-vh;zi=ztop-vh/A
    cold=one(pi,tc,vc,vc/A,zbottom+vc/(2*A),zi)
    dvi=one(pd,td,.5,0,3.,3.)
    return dict(stores=[main,bal,hot,cold,dvi],pI=pi,hotVolume=vh,interface=zi)

def store_value(s,key):return 0. if s is None else float(s[key][0])
def total(s,key):return sum(w*store_value(q,key) for w,q in zip([1,2,2,2,2],s['stores']))
def entropy(s):return sum(w*q['rows'][0]['M']*_Region1(q['rows'][0]['T'],q['rows'][0]['p']/1e6)['s']*1000
    for w,q in zip([1,2,2,2,2],s['stores']) if q is not None)

def port_checks():
    results=[]
    # For the actual hot-zone midpoint closure, E+pI*V equals M*(h_center+g*ztop).
    # This is the first positive packet balance and tests every zone separately.
    for vh in [1.,.1,.001,1e-6]:
        hot=one(15e6,560.,vh,vh/A,ztop-vh/(2*A),ztop)
        r=hot['rows'][0];work=hot['pbottom']*vh
        incoming=r['M']*(r['h']+g*ztop)
        defect=hot['E'][0]+work-incoming
        if abs(defect)>1e-6:raise ValueError('Finite hot-zone birth identity failed')
        results.append(dict(hotVolume_m3=vh,hotEnergyResidual_J=float(defect),interfaceWork_J=work,
            hotResidualIfWorkOmitted_J=float(hot['E'][0]-incoming),coldWorkReceived_J=work))
    # Fixed mass: moving-centroid PE converts interface work to center-pressure work.
    M=1000.;dV=.001;pi=15e6
    for name,sign in [('cold',1),('hot',-1)]:
        du=-pi*dV-sign*M*g*dV/(2*A)
        expected=-(pi+sign*M*g/(2*A))*dV
        if abs(du-expected)>1e-8:raise ValueError('Material compression identity failed')
    zero=material_state([15.2e6,563.15,15.13e6,563.15,float('nan'),313.15,0.,15.2e6,563.15])
    if zero['stores'][2] is not None:raise ValueError('Absent hot zone acquired fabricated state')
    return results

def material_run(name,dtmax):
    started=time.perf_counter();p0=b['initialPressure_MPa']*1e6;hot=b['hot_C']+273.15;cold=b['cold_C']+273.15
    rh=water(p0,hot)[0];rc=water(p0,cold)[0]
    pt=brentq(lambda p:p-p0+.5*(rh+water(p,hot)[0])*g*9,p0-1e5,p0)
    y=np.array([p0,hot,pt,hot,hot,cold,0.,p0,hot]);old=material_state(y)
    M0=total(old,'M');E0=total(old,'E');S0=entropy(old);initial=dict(mass_kg=M0,energy_J=E0,entropy_J_K=S0)
    scales=np.array([1e7,500.,1e7,500.,500.,500.,1.,1e7,500.])
    t=0.;nextout=b['output_s'];trace=[];lastq=np.zeros(4);nfev=0;maxM=0.;maxE=0.;maxR=0.;minDS=float('inf');Sprev=S0
    inletM=0.;outletM=0.;maxHotDef=0.;maxColdDef=0.;birth=None
    def record():
        main,bal,h,c,dvi=old['stores'];hr=None if h is None else h['rows'][0]
        trace.append(dict(t_s=t,primaryPressure_Pa=main['ptop'],tankTopPressure_Pa=bal['ptop'],
            hotVolume_m3=old['hotVolume'],interfaceElevation_m=old['interface'],
            hot_C=None if hr is None else hr['T']-273.15,cold_C=c['rows'][0]['T']-273.15,
            balance_C=bal['rows'][0]['T']-273.15,hotMass_kg=store_value(h,'M'),coldMass_kg=store_value(c,'M'),
            sourceFlow_kg_s=float(lastq[1]),balanceToTankFlow_kg_s=float(lastq[3]),
            tankInletMass_kg=inletM,tankOutletMass_kg=outletM,totalEntropyChange_J_K=entropy(old)-S0,
            probeEnvironments=[dict(elevation_m=z,liquid_C=[c['rows'][0]['T']-273.15] if z<old['interface'] or hr is None
                else [hr['T']-273.15] if z>old['interface'] else [c['rows'][0]['T']-273.15,hr['T']-273.15]) for z in [11.25,6.75]]))
    record()
    while t<b['duration_s']-1e-10:
        dt=min(dtmax,nextout-t,b['duration_s']-t);opening=min(1.,(t+dt)/2.)
        if old['hotVolume']==0:
            # A numerical starting guess for the first positive transfer, not stored seed inventory.
            guessFlow=25*opening
            guess=y.copy();guess[6]=dt*guessFlow/water(pt,hot)[0];guess[4]=hot
            x=np.r_[guess/scales,[guessFlow/25]*4]
        else:x=np.r_[y/scales,lastq/25]
        def residual(xx):
            ss=material_state(xx[:9]*scales);main,bal,h,c,dvi=ss['stores'];qi,qo,qd,qh=xx[9:]*25
            if h is None:raise ValueError('Positive-step hot-zone equation has no finite volume')
            mi,ba,ho,co,di=[q['rows'][0] for q in ss['stores']]
            Hb=ba['h']+g*12
            Hi=(mi['h'] if qi>=0 else ba['h'])+g*(3 if qi>=0 else 12)
            outlet=water(c['pbottom'],co['T'])
            Ho=outlet[2]+g*6 if qo>=0 else di['h']+g*3
            Hd=(di['h'] if qd>=0 else mi['h'])+g*3
            mass=np.array([(store_value(a,'M')-store_value(o,'M'))/dt for a,o in zip(ss['stores'],old['stores'])])
            energy=np.array([(store_value(a,'E')-store_value(o,'E'))/dt for a,o in zip(ss['stores'],old['stores'])])
            mass+=np.array([2*qi-2*qd,-qi+qh,-qh,qo,-qo+qd])
            work=ss['pI']*(ss['hotVolume']-old['hotVolume'])/dt
            energy+=np.array([2*qi*Hi-2*qd*Hd,-qi*Hi+qh*Hb,-qh*Hb+work,qo*Ho-work,-qo*Ho+qd*Hd])
            def loss(m,p1,z1,r1,p2,z2,r2,K,check=False):
                rho=r1 if m>=0 else r2
                defect=(K*m*abs(m)*rc/rho-(p1-p2+.5*(r1+r2)*g*(z1-z2))+(1000 if check else 0))/20000
                return math.hypot(m/25,defect)-m/25-defect if check else defect
            heads=[loss(qi,mi['p'],3,mi['rho'],ba['p'],12,ba['rho'],2000/25**2*rh/rc),
                loss(qo,c['pbottom'],6,outlet[0],di['p'],3,di['rho'],20000/25**2/opening**2,True),
                loss(qd,di['p'],3,di['rho'],mi['p'],3,mi['rho'],10000/100**2)]
            return np.r_[mass/25,energy/25e6,heads]
        try:
            solved=root(residual,x,method='hybr',options=dict(xtol=1e-11))
            rr=residual(solved.x)
        except ValueError as error:
            if not str(error).startswith(('CMT apparatus reached','Material interface left','Positive-step hot-zone')):raise
            return dict(name=name,status='REJECTED_ADMISSION_OR_SOLVE',time_s=t,message=str(error),initial=initial,trace=trace)
        nfev+=solved.nfev
        if not np.all(np.isfinite(solved.x)) or not np.all(np.isfinite(rr)) or max(abs(rr))>1e-7:
            return dict(name=name,status='REJECTED_RESIDUAL',time_s=t,maxResidual=float(max(abs(rr))),initial=initial,trace=trace)
        y=solved.x[:9]*scales;ss=material_state(y);q=solved.x[9:]*25
        if q[3]<0 or q[1]<-1e-8 or ss['interface']<=6 or ss['hotVolume']<=0:
            return dict(name=name,status='REJECTED_DIRECTION_OR_INTERFACE',time_s=t+dt,flows=q.tolist(),initial=initial,trace=trace)
        maxM=max(maxM,abs(total(ss,'M')-M0));maxE=max(maxE,abs(total(ss,'E')-E0));maxR=max(maxR,float(max(abs(rr))))
        maxHotDef=max(maxHotDef,abs(rr[7]*25e6*dt));maxColdDef=max(maxColdDef,abs(rr[8]*25e6*dt))
        if old['stores'][2] is None:
            ba=ss['stores'][1]['rows'][0];ho=ss['stores'][2]['rows'][0]
            birth=dict(time_s=t+dt,initialHotMass_kg=0.,initialHotVolume_m3=0.,hotMass_kg=ho['M'],hotVolume_m3=ss['hotVolume'],
                incomingMass_kg=dt*q[3],incomingEnergy_J=dt*q[3]*(ba['h']+g*12),
                hotEnergy_J=store_value(ss['stores'][2],'E'),interfaceWork_J=ss['pI']*ss['hotVolume'],
                hotEnergyResidual_J=float(rr[7]*25e6*dt),coldEnergyResidual_J=float(rr[8]*25e6*dt),
                centerEnthalpyMinusInlet_J_kg=ho['h']-ba['h'])
        S=entropy(ss);minDS=min(minDS,S-Sprev);Sprev=S
        if maxM>b['material']['massResidual_kg'] or maxE>b['material']['energyResidual_J']:
            return dict(name=name,status='REJECTED_LEDGER',time_s=t+dt,maxMassResidual_kg=maxM,maxEnergyResidual_J=maxE,initial=initial,trace=trace)
        old=ss;lastq=q;inletM+=dt*q[3];outletM+=dt*q[1];t+=dt
        if t>=nextout-1e-9:record();nextout+=b['output_s']
    return dict(name=name,status='COMPLETED',step_s=dtmax,initial=initial,maxMassResidual_kg=maxM,maxEnergyResidual_J=maxE,
        maxScaledResidual=maxR,maxHotZoneEnergyResidual_J=maxHotDef,maxColdZoneEnergyResidual_J=maxColdDef,
        minimumAcceptedEntropyIncrement_J_K=minDS,birth=birth,nfev=nfev,wall_s=time.perf_counter()-started,trace=trace)

checks=port_checks()
coarse=material_run('material_coarse',b['material']['maximumStep_s'])
fine=material_run('material_fine',b['material']['maximumStep_s']/2)
# Explicitly different thermal limit and shared bottom-port convention in BOTH arms.
b['interlayerConductance_W_K']=0.
eulerian=study('zero_heat_physical_port',b['topCells'],b['material']['maximumStep_s'],True,physical_bottom_port=True)
comparison=None
if coarse['status']==fine['status']=='COMPLETED':
    if [r['t_s'] for r in coarse['trace']]!=[r['t_s'] for r in fine['trace']]:raise ValueError('Material comparison output times differ')
    dp=float(max(abs(a['primaryPressure_Pa']-c['primaryPressure_Pa']) for a,c in zip(coarse['trace'],fine['trace'])))
    dz=float(max(abs(a['interfaceElevation_m']-c['interfaceElevation_m']) for a,c in zip(coarse['trace'],fine['trace'])))
    comparison=dict(maxPressureDifference_Pa=dp,maxInterfaceDifference_m=dz,
        pressurePass=dp<=b['material']['pressureDifference_Pa'],interfacePass=dz<=b['material']['interfaceDifference_m'],
        entropyNondecreasing=bool(coarse['minimumAcceptedEntropyIncrement_J_K']>=0 and fine['minimumAcceptedEntropyIncrement_J_K']>=0))
print(json.dumps(dict(scope='Finite internally mixed admitted-material / no-cross-interface-mixing reference; not a slot mixing law',
    comparisonBasis=dict(interfacialHeat_W=0.,interfacialMassExchange_kg_s=0.,physicalBottomPort=True,topEntryElevation_m=12.,radialDistributorIncluded=False),
    checks=checks,material=[coarse,fine],eulerian=eulerian,comparison=comparison,
    numericalReferenceAccepted=comparison is not None and comparison['pressurePass'] and comparison['interfacePass'] and comparison['entropyNondecreasing'],
    physicalMixingQualified=False)))
`

if(import.meta.main) {
  const [page,python]=process.argv.slice(2)
  if(!page||!python)throw new Error('Usage: reference-design-cmt-material.ts <wiki-page> <python>')
  const input=parseMaterialBasis(await Bun.file(page).text())
  const child=Bun.spawn([python,'-c',materialCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(status!==0)throw new Error(stderr)
  console.log(JSON.stringify({input,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    calculationHash:createHash('sha256').update(materialCalculation).digest('hex'),...JSON.parse(stdout)},null,2))
}
