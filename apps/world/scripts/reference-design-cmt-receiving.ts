/** Offline finite material-zone receipt and fast convective-adjustment limit. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { apertureDefinitions, parseApertureBasis } from './reference-design-cmt-inlet'

const positive = z.number().finite().positive()
const schema = z.object({duration_s:z.literal(10),contactAt_s:z.literal(5),
  calorimeterCapacity_J_K:positive,calorimeterConductance_W_K:positive,
  massResidual_kg:positive,energyResidual_J:positive,volumeResidual_m3:positive,entropyTolerance_J_K:positive,
  temporalTemperature_K:positive,temporalPressure_Pa:positive,temporalGrossFraction:positive,
  spatialTemperature_K:positive,spatialPressure_Pa:positive,spatialGrossFraction:positive}).strict()
export function parseReceivingBasis(document:string) {
  const blocks=[...document.matchAll(/^```reference-cmt-receiving\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw new Error('Expected one reference-cmt-receiving block')
  return {...parseApertureBasis(document),receiving:schema.parse(JSON.parse(blocks[0]![1]!))}
}

export const receivingDefinitions=apertureDefinitions+String.raw`
from iapws.iapws97 import _Backward1_T_Ps
r=b['receiving'];A=10.;top=12.;totalVolume=60.
gn,gw=leggauss(4);an,aw=leggauss(16)

def ps(p,s):
    if not .1e6<p<30e6:raise ValueError('Material pressure outside liquid range')
    T=_Backward1_T_Ps(p/1e6,s/1000)
    for _ in range(6):
        q=water(p,T);error=q['s']-s
        if abs(error)<1e-8:return q|{'T':T,'v':1/q['rho']}
        cp=_Region1(T,p/1e6)['cp']*1000;T-=error*T/cp
    raise ValueError('Material entropy inversion failed')

def column(p,mm,ss,n=4):
    if len(mm)!=len(ss) or np.any(mm<=0) or not np.all(np.isfinite(mm)) or not np.all(np.isfinite(ss)):
        raise ValueError('Vanished/nonfinite material zone; no refill or reordering')
    nn,ww=(gn,gw) if n==4 else leggauss(n)
    aboveM=aboveV=0.;rows=[]
    for m,s in zip(mm,ss):
        mass=aboveM+(nn+1)*m/2;weights=ww*m/2
        qq=[ps(p+g*x/A,s) for x in mass]
        vv=np.array([q['v'] for q in qq]);uu=np.array([q['u'] for q in qq])
        V=float(weights@vv);U=float(weights@uu)
        PE=g*m*(top-aboveV/A)-g/A*float(weights@((aboveM+m-mass)*vv))
        ptop=p+g*aboveM/A;ztop=top-aboveV/A
        rows.append(dict(M=float(m),s=float(s),V=V,E=U+PE,ztop=ztop,zbottom=ztop-V/A,
            ptop=ptop,pbottom=ptop+g*m/A,totalH=ps(ptop,s)['h']+g*ztop))
        aboveM+=m;aboveV+=V
    return dict(p=p,M=float(sum(mm)),V=aboveV,E=sum(x['E'] for x in rows),S=float(np.dot(mm,ss)),rows=rows)

def local(row,z):
    q=ps(row['ptop'],row['s']);p=row['ptop']+q['rho']*g*(row['ztop']-z)
    target=row['totalH']-g*z
    for _ in range(5):
        q=ps(p,row['s']);err=q['h']-target
        if abs(err)<1e-7:return p,q
        p-=err*q['rho']
    raise ValueError('Material face hydrostatic inversion failed')

def flux(pp,Tp,c,n=16):
    nn,ww=(an,aw) if n==16 else leggauss(n)
    dm=np.zeros(len(c['rows']));de=dm.copy();outByZone=dm.copy();rings=[]
    for center in b['ringElevations_m']:
        lo0,hi0=center-radius,center+radius
        cuts=sorted([lo0,hi0]+[q['zbottom'] for q in c['rows'][:-1] if lo0<q['zbottom']<hi0])
        ringOut=ringIn=ringE=ringD=hotIn=coolIn=0.
        for lo,hi in zip(cuts[:-1],cuts[1:]):
            mid=(lo+hi)/2
            j=next((j for j,q in enumerate(c['rows']) if q['zbottom']-1e-9<=mid<=q['ztop']+1e-9),None)
            if j is None:raise ValueError('Aperture left material column')
            row=c['rows'][j]
            def state(z):
                p1=pressure(pp,Tp,z);p2,q=local(row,z)
                return p1,p2,q
            def delta(z):
                p1,p2,_=state(z);return p1-p2
            segments=[lo,hi]
            if delta(lo)*delta(hi)<0:segments.insert(1,brentq(delta,lo,hi,xtol=1e-12))
            for za,zb in zip(segments[:-1],segments[1:]):
                aa=math.asin(max(-1.,min(1.,(za-center)/radius)));bb=math.asin(max(-1.,min(1.,(zb-center)/radius)))
                for node,weight in zip(nn,ww):
                    t=(node+1)/2;theta=aa+(bb-aa)*math.sin(math.pi*t/2)**2
                    jac=(bb-aa)*math.pi/2*math.sin(math.pi*t)
                    z=center+radius*math.sin(theta)
                    da=2*radius**2*math.cos(theta)**2*jac*weight/2*b['holesPerRing']
                    p1,p2,q=state(z);dp=p1-p2;donor=water(p1,Tp) if dp>=0 else q
                    dq=b['coefficient']*da*math.copysign(math.sqrt(2*donor['rho']*abs(dp)),dp)
                    energy=dq*(donor['h']+g*z)
                    dm[j]+=dq;de[j]+=energy;ringE+=energy;ringD+=dq*dp/donor['rho']
                    outByZone[j]+=max(0,dq)
                    ringOut+=max(0,dq);ringIn+=max(0,-dq)
                    if dq>0 and Tp-q['T']>1e-6:hotIn+=dq
                    if dq>0 and Tp-q['T'] < -1e-6:coolIn+=dq
        if ringD < -1e-10:raise ValueError('Negative aperture dissipation')
        rings.append(dict(z=center,out=ringOut,back=ringIn,E=ringE,dissipation=ringD,hotIn=hotIn,coolIn=coolIn))
    return dict(dm=dm,de=de,outByZone=outByZone,out=sum(x['out'] for x in rings),back=sum(x['back'] for x in rings),rings=rings)

def make_initial(split):
    edges=[12.,11.95,11.90,11.85,11.80,11.75,11.70,11.25,6.]
    if split:edges=[v for a,c in zip(edges[:-1],edges[1:]) for v in [a,(a+c)/2]]+[6.]
    p=b['pressure_MPa']*1e6;s=water(p,313.15)['s'];mm=[]
    for a,c in zip(edges[:-1],edges[1:]):
        target=A*(a-c)
        def volume(m):
            return column(p,np.array(mm+[m]),np.full(len(mm)+1,s))['rows'][-1]['V']-target
        mm.append(brentq(volume,target*600,target*1100,xtol=1e-8))
    mm=np.array(mm);ss=np.full(len(mm),s);c=column(p,mm,ss)
    pp=brentq(lambda pp:sum(flux(pp,563.15,c)['dm']),p-3000,p+3000,xtol=1e-5)
    return mm,ss,c,vessel(pp,563.15,'plenum'),293.15

def neutralize(mm,ss,old):
    state=old;new=ss.copy();blocks=[];minimumDS=0.
    for _ in range(2*len(mm)):
        # s ordering is used only in this positive-expansion liquid domain.
        common=[ps(state['p'],s) for s in new]
        if any(_Region1(q['T'],state['p']/1e6)['alfav']<=0 for q in common):raise ValueError('Entropy-order stability outside positive expansion range')
        if any(new[j]+1e-6<new[j+1] and common[j]['rho']<=common[j+1]['rho'] for j in range(len(mm)-1)):
            raise ValueError('Entropy and common-pressure density stability disagree')
        inversions=[j for j in range(len(mm)-1) if new[j]+1e-8<new[j+1]]
        if not inversions:return new,state,blocks,minimumDS
        left=inversions[0];right=left+1
        # Include already-neutral neighbors in the active block; no parcel deletion.
        while left>0 and abs(new[left]-new[left-1])<1e-8:left-=1
        while right<len(mm)-1 and abs(new[right]-new[right+1])<1e-8:right+=1
        idx=np.arange(left,right+1);before=state;prior=new.copy()
        def residual(x):
            trial=prior.copy();trial[idx]=x[1]*1000;c=column(x[0]*1e7,mm,trial)
            return [(c['V']-totalVolume),(c['E']-before['E'])/1e5]
        sol=root(residual,[before['p']/1e7,np.dot(mm[idx],prior[idx])/sum(mm[idx])/1000],options={'xtol':1e-11})
        rr=np.array(residual(sol.x))
        if not np.all(np.isfinite(sol.x)) or max(abs(rr))>1e-7:raise ValueError('Neutralization nonlinear residual')
        new[idx]=sol.x[1]*1000;state=column(sol.x[0]*1e7,mm,new)
        ds=state['S']-before['S'];minimumDS=min(minimumDS,ds)
        if abs(state['E']-before['E'])>r['energyResidual_J'] or abs(state['V']-totalVolume)>r['volumeResidual_m3'] or ds < -r['entropyTolerance_J_K']:
            raise ValueError('Neutralization volume/energy/entropy rejection')
        length=before['rows'][left]['ztop']-before['rows'][right]['zbottom']
        contrast=max(q['rho'] for q in common[left:right+1])-min(q['rho'] for q in common[left:right+1])
        reduced=g*contrast/max(q['rho'] for q in common[left:right+1])
        blocks.append(dict(first=left,last=right,entropyChange_J_K=ds,energyResidual_J=state['E']-before['E'],
            blockMass_kg=float(sum(mm[idx])),blockHeight_m=length,
            buoyancyFreeFallScale_s=math.sqrt(2*length/reduced) if reduced>0 else None))
    raise ValueError('Unstable column after bounded block search')

def receipt(mm,ss,old,pl,tc,dt,contact,iteration_tolerance=1e-12):
    N=len(mm);x0=np.r_[mm/1000,ss/1000,old['p']/1e7,pl['p']/1e7,pl['T']/500,tc/500]
    def evaluate(x):
        masses=x[:N]*1000;ent=x[N:2*N]*1000
        c=column(x[-4]*1e7,masses,ent);v=vessel(x[-3]*1e7,x[-2]*500,'plenum');temp=x[-1]*500
        if temp<=0:raise ValueError('Nonpositive calorimeter temperature')
        f=flux(v['p'],v['T'],c);Q=r['calorimeterConductance_W_K']*(v['T']-temp) if contact else 0.
        work=np.array([A*((a['pbottom']+q['pbottom'])/2*(q['zbottom']-a['zbottom'])-
            (a['ptop']+q['ptop'])/2*(q['ztop']-a['ztop'])) for a,q in zip(old['rows'],c['rows'])])
        rr=np.r_[masses-mm-dt*f['dm'],
            (np.array([q['E']-a['E'] for a,q in zip(old['rows'],c['rows'])])-dt*f['de']-work)/1e5,
            c['V']-totalVolume,v['mass']-pl['mass']+dt*sum(f['dm']),
            (v['energy']-pl['energy']+dt*(sum(f['de'])+Q))/1e5,
            (r['calorimeterCapacity_J_K']*(temp-tc)-dt*Q)/1e5]
        return rr,masses,ent,c,v,temp,f,work,Q
    sol=root(lambda x:evaluate(x)[0],x0,options={'xtol':iteration_tolerance})
    values=evaluate(sol.x);rr=values[0]
    if not np.all(np.isfinite(sol.x)) or not np.all(np.isfinite(rr)) or max(abs(rr))>1e-7:
        raise ValueError('Receipt local residual: '+str(dict(nfev=sol.nfev,message=str(sol.message),residual=rr.tolist(),old=x0.tolist(),trial=sol.x.tolist())))
    return values,sol.nfev

def run_case(name,split,dt):
    started=time.perf_counter();mm,ss,c,pl,tc=make_initial(split)
    C=r['calorimeterCapacity_J_K'];M0=c['M']+pl['mass'];E0=c['E']+pl['energy']+C*tc
    S0=c['S']+pl['entropy']+C*math.log(tc);previousS=S0
    trace=[];maxM=maxE=maxV=maxLocal=0.;minimumDS=float('inf');received=returned=0.;events=[];calls=0
    lastAccepted=dict(t_s=0.,masses_kg=mm.tolist(),entropies_J_kgK=ss.tolist(),tank=c,plenum=pl,calorimeter_K=tc)
    def record(t):
        f=flux(pl['p'],pl['T'],c);locations=[11.98,11.92,11.82,11.65,11.25]
        temps=[]
        for z in locations:
            row=next(q for q in c['rows'] if q['zbottom']-1e-8<=z<=q['ztop']+1e-8)
            temps.append(local(row,z)[1]['T']-273.15)
        trace.append(dict(t_s=t,plenum_C=pl['T']-273.15,plenumPressure_Pa=pl['p'],tankPressure_Pa=c['p'],
            calorimeter_C=tc-273.15,locations_m=locations,localResearch_C=temps,rows=c['rows'],
            out_kg_s=f['out'],back_kg_s=f['back'],rings=f['rings'],received_kg=received,returned_kg=returned))
    record(0.)
    try:
        for k in range(round(r['duration_s']/dt)):
            values,nfev=receipt(mm,ss,c,pl,tc,dt,k*dt>=r['contactAt_s']);calls+=nfev
            rr,mm,ss,c,pl,tc,f,work,Q=values
            received+=dt*f['out'];returned+=dt*f['back'];maxLocal=max(maxLocal,float(max(abs(rr))))
            ss,c,blocks,_=neutralize(mm,ss,c)
            maxM=max(maxM,abs(c['M']+pl['mass']-M0));maxE=max(maxE,abs(c['E']+pl['energy']+C*tc-E0));maxV=max(maxV,abs(c['V']-totalVolume))
            S=c['S']+pl['entropy']+C*math.log(tc);minimumDS=min(minimumDS,S-previousS);previousS=S
            if maxM>r['massResidual_kg'] or maxE>r['energyResidual_J'] or maxV>r['volumeResidual_m3'] or minimumDS < -r['entropyTolerance_J_K']:
                raise ValueError('Global receipt ledger rejection: '+str((maxM,maxE,maxV,minimumDS)))
            for block in blocks:
                localOut=sum(f['outByZone'][block['first']:block['last']+1])
                block['grossAdmissionTime_s']=block['blockMass_kg']/localOut if localOut>0 else None
                block['freeFallToAdmissionRatio']=block['buoyancyFreeFallScale_s']/block['grossAdmissionTime_s'] if block['buoyancyFreeFallScale_s'] and block['grossAdmissionTime_s'] else None
                block['plenumTurnoverScale_s']=pl['mass']/max(f['out'],f['back']) if max(f['out'],f['back'])>0 else None
                block['plenumIsobaricCoolingScale_s']=pl['mass']*_Region1(pl['T'],pl['p']/1e6)['cp']*1000/r['calorimeterConductance_W_K'] if k*dt>=r['contactAt_s'] else None
            if blocks:events.append(dict(t_s=(k+1)*dt,blocks=blocks))
            lastAccepted=dict(t_s=(k+1)*dt,masses_kg=mm.tolist(),entropies_J_kgK=ss.tolist(),tank=c,plenum=pl,calorimeter_K=tc)
            if (k+1)%round(.1/dt)==0:record((k+1)*dt)
            if (k+1)%round(1/dt)==0:print(name+' accepted '+str((k+1)*dt)+' s',file=sys.stderr,flush=True)
    except ValueError as error:
        return dict(name=name,status='REJECTED',reason=str(error),attemptedTime_s=(k+1)*dt,trace=trace,events=events,
            lastAcceptedState=lastAccepted,wall_s=time.perf_counter()-started)
    quadrature=[]
    for row in [trace[0],trace[-1]]:
        fine=flux(row['plenumPressure_Pa'],row['plenum_C']+273.15,{'rows':row['rows']},32)
        diff=max(abs(a[k]-v[k]) for a,v in zip(row['rings'],fine['rings']) for k in ['out','back'])
        material=column(row['tankPressure_Pa'],np.array([q['M'] for q in row['rows']]),np.array([q['s'] for q in row['rows']]),8)
        dE=material['E']-sum(q['E'] for q in row['rows']);dV=material['V']-sum(q['V'] for q in row['rows'])
        if diff>.001 or abs(dE)>r['energyResidual_J'] or abs(dV)>r['volumeResidual_m3']:raise ValueError('Recipient quadrature check rejected')
        quadrature.append(dict(t_s=row['t_s'],maximumGrossDifference_kg_s=diff,columnEnergyDifference_J=dE,columnVolumeDifference_m3=dV))
    return dict(name=name,status='COMPLETED',trace=trace,events=events,maximumMassError_kg=maxM,maximumEnergyError_J=maxE,
        maximumVolumeError_m3=maxV,maximumLocalScaledResidual=maxLocal,minimumEntropyIncrement_J_K=minimumDS,
        receiptResidualEvaluations=calls,quadrature=quadrature,
        hotReceiptObserved=any(q['hotIn']>0 for row in trace for q in row['rings']),
        coolerReceiptObserved=any(q['coolIn']>0 for row in trace for q in row['rings']),wall_s=time.perf_counter()-started)

`
export const receivingCalculation=receivingDefinitions+String.raw`definitions=[('eight_coarse',False,.1),('eight_fine',False,.05),('sixteen_fine',True,.05)]
selected=b.get('case','all');cases=b['retainedCases'] if selected=='compare' else []
for name,split,dt in definitions:
    if selected not in ['all',name]:continue
    print('Starting '+name,file=sys.stderr,flush=True)
    result=run_case(name,split,dt);cases.append(result)
    print(json.dumps({k:result[k] for k in ['name','status','wall_s']}),file=sys.stderr,flush=True)
comparisons=[]
if selected in ['all','compare']:
    for a,c,kind in [(cases[0],cases[1],'temporal'),(cases[1],cases[2],'spatial')]:
        if a['status']!='COMPLETED' or c['status']!='COMPLETED':
            comparisons.append(dict(kind=kind,passed=False,reason='At least one trajectory rejected'));continue
        if [q['t_s'] for q in a['trace']]!=[q['t_s'] for q in c['trace']]:raise ValueError('Comparison clocks differ')
        dT=max(abs(x-y) for aa,cc in zip(a['trace'],c['trace']) for x,y in zip(aa['localResearch_C'],cc['localResearch_C']))
        dp=max(abs(aa['tankPressure_Pa']-cc['tankPressure_Pa']) for aa,cc in zip(a['trace'],c['trace']))
        dq=max(abs(aa[k]-cc[k]) for aa,cc in zip(a['trace'],c['trace']) for k in ['out_kg_s','back_kg_s'])/max(cc[k] for cc in c['trace'] for k in ['out_kg_s','back_kg_s'])
        comparisons.append(dict(kind=kind,maximumFixedPointDifference_K=dT,maximumTankPressureDifference_Pa=dp,
            maximumRelativeGrossDifference=dq,passed=bool(dT<=r[kind+'Temperature_K'] and dp<=r[kind+'Pressure_Pa'] and dq<=r[kind+'GrossFraction'])))
print(json.dumps(dict(scope='Finite aperture-local material receipt with rapid neutralization; no empirical plume rate',cases=cases,
    comparisons=comparisons,physicalRedistributionQualified=False)))
`

if(import.meta.main) {
  const [page,python,caseId='all',...retainedPaths]=process.argv.slice(2)
  if(!page||!python||!['all','eight_coarse','eight_fine','sixteen_fine','compare'].includes(caseId))
    throw new Error('Usage: reference-design-cmt-receiving.ts <wiki-page> <python> [case | compare <three case artifacts>]')
  const basis=parseReceivingBasis(await Bun.file(page).text())
  const calculationHash=createHash('sha256').update(receivingCalculation).digest('hex')
  const retainedCases=[]
  if(caseId==='compare') {
    if(retainedPaths.length!==3)throw new Error('Expected three retained cases in coarse/fine/spatial order')
    for(const [i,path] of retainedPaths.entries()) {
      const value=await Bun.file(path).json()
      const {case:retainedCase,...retainedBasis}=value.input
      if(value.calculationHash!==calculationHash||JSON.stringify(retainedBasis)!==JSON.stringify(basis)||
        retainedCase!==['eight_coarse','eight_fine','sixteen_fine'][i]||value.cases.length!==1||value.cases[0].name!==retainedCase)
        throw new Error('Retained case does not match current fixed source/input/matrix')
      retainedCases.push(value.cases[0])
    }
  } else if(retainedPaths.length)throw new Error('Unexpected retained artifacts')
  const input={...basis,case:caseId,...(caseId==='compare'?{retainedCases}:{})}
  const child=Bun.spawn([python,'-c',receivingCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'inherit'})
  const [out,status]=await Promise.all([new Response(child.stdout).text(),child.exited])
  if(status!==0)throw new Error('Receiving calculation failed; see stderr')
  console.log(JSON.stringify({input,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    calculationHash,...JSON.parse(out)},null,2))
}
