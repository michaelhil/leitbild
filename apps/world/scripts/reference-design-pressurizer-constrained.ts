/** Offline fixed-cell EOS-constrained transport; not a live PZR runtime. */
import { createHash } from 'node:crypto'
import { parseTransportBasis, transportProperties } from './reference-design-pressurizer-transport'

export const constrainedCalculation = `${transportProperties}${String.raw`
import numpy as np
from scipy.optimize import root
from numpy.polynomial.legendre import leggauss
h0=enthalpy(b['initial']['temperature_K']);hc=enthalpy(b['cold']['temperature_K']);dh=h0-hc
c0=b['initial']['boron_ppm']*1e-6;donor=b['sourceMass_kg']
# These are finite external donor prescriptions, never interior face fluxes.
def source_primitive(m,kind):
    s=m/donor
    f=s/2-math.sin(math.pi*s)/(2*math.pi) if kind=='curved' else s*s/2
    scale=1/20 if kind=='nonuniform-initial' else 1.
    H=h0*m-(0 if kind=='uniform' else scale*dh*donor*f)
    B=c0*m if kind in ('uniform','nonuniform-initial') else c0*donor*(s-f)
    if kind=='boron-jump':B=c0*donor*(min(s,.5)+.5*max(s-.5,0.))
    return np.array([m,H,B])
def source_point(m,kind):
    s=m/donor;f=math.sin(math.pi*s/2)**2 if kind=='curved' else s
    h=h0-(0 if kind=='uniform' else dh*f/(20 if kind=='nonuniform-initial' else 1))
    c=c0 if kind in ('uniform','nonuniform-initial') else c0*(1-f)
    if kind=='boron-jump':c=c0*(1 if s<.5 else .5)
    return h,c

def initial(n,kind):
    cap=b['vesselVolume_m3']/n;remaining=b['initialVolume_m3'];cells=[]
    while remaining>1e-12:
        v=min(cap,remaining)
        # Native homogeneous cells, including a deliberately nonuniform
        # initial challenge. No stratified EOS-inconsistent means are inserted.
        h=h0+(dh/20)*(len(cells)+.5)/n if kind=='nonuniform-initial' else h0
        m=v/state(h)[0];cells.append([m,m*h,m*c0]);remaining-=v
    return dict(cells=cells,source=source_primitive(donor,kind).tolist(),receiver=parcel(b['receiverMass_kg'],h0,c0),
        admitted_kg=0.,withdrawn_kg=0.,acceptedTransfers=0,topologyEvents=0)

def slopes(values,masses,bounds):
    # MC/minmod reconstruction in current mass coordinates. The cut cell
    # is explicitly mixed; empty cells never supply a slope or donor value.
    values=np.asarray(values);masses=np.asarray(masses);out=np.zeros(len(values))
    for i in range(len(values)-1):
        if masses[i]<=0 or masses[i+1]<=0:continue
        dr=(values[i+1]-values[i])/((masses[i]+masses[i+1])/2)
        if i==0:
            # One-sided outlet extrapolation has no invented ghost donor.
            # Limit its profile, not conserved inventories, to the admitted
            # source/initial scalar envelope supplied by this benchmark.
            extent=max(0.,min(values[i]-bounds[0],bounds[1]-values[i]))
            out[i]=math.copysign(min(abs(dr),2*extent/masses[i]),dr);continue
        dl=(values[i]-values[i-1])/((masses[i]+masses[i-1])/2)
        dc=(values[i+1]-values[i-1])/((masses[i-1]+masses[i+1])/2+masses[i])
        if dl*dr>0:out[i]=math.copysign(min(abs(2*dl),abs(dc),abs(2*dr),
            2*abs(values[i]-values[i-1])/masses[i],2*abs(values[i+1]-values[i])/masses[i]),dl)
    return out

def transported(old,newM,newValues,F,field,bounds):
    oldM=old[:,0];valid=oldM>0
    oldValues=np.divide(old[:,field],oldM,out=np.asarray(newValues).copy(),where=valid)
    mid=(oldValues+newValues)/2;midM=(oldM+newM)/2
    # Empty initial top cell is excluded, including from its neighbor's slope.
    reconM=midM.copy();reconM[~valid]=0.
    slope=slopes(mid,reconM,bounds);flux=np.zeros(len(old)+1)
    for j in range(len(old)):
        if j==0 and F[j]>=0:continue
        i=j-1 if F[j]>=0 else j
        offset=midM[i]/2*(1 if F[j]>=0 else -1)
        flux[j]=F[j]*(mid[i]+slope[i]*offset)
    return flux

def trial(oldstate,requested,cap,kind,limits,event=None):
    # One candidate transaction. Root iterations never publish any owner.
    s=copy.deepcopy(oldstate);old=np.array(s['cells'],dtype=float)
    if requested>0 and abs(vol(old[-1])-cap)<1e-10:
        old=np.vstack((old,np.zeros(3)))
    n=len(old);oldM=old[:,0];oldH=old[:,1]
    oldh=np.divide(oldH,oldM,out=np.full(n,h0),where=oldM>0)
    empty=event=='empty';size=n-1 if empty else n
    massScale=cap/state(h0)[0];energyScale=massScale*dh
    def amounts(x):
        # Order-one absolute enthalpy coordinates are essential: centering
        # x at h0 makes relative finite differences vanish in nearly uniform
        # cells when a tiny nonzero x is rounded away by h0 + dh*x.
        h=np.r_[dh*x,oldh[-1]] if empty else dh*x
        M=np.array([cap/state(z)[0] for z in h[:-1]]+[0.])
        if event=='full':M[-1]=cap/state(h[-1])[0]
        if event:fin=math.fsum(M)-math.fsum(oldM)
        else:
            fin=requested;M[-1]=math.fsum(oldM)+fin-math.fsum(M[:-1])
        F=np.r_[fin,fin-np.cumsum(M-oldM)];F[-1]=0.
        HH=transported(old,M,h,F,1,limits[0])
        if fin>=0:HH[0]=(source_primitive(s['admitted_kg']+fin,kind)-source_primitive(s['admitted_kg'],kind))[1]
        return h,M,F,HH
    def residual(x):
        h,M,F,HH=amounts(x)
        r=M*h-oldH-HH[:-1]+HH[1:]
        return r[:size]/energyScale
    # A 1e-9 relative h/dh step permits O(0.1 J) cell-balance error at
    # this mass/enthalpy scale. Ask for tighter iteration convergence while
    # retaining the independent 0.01 J residual gate as authoritative.
    try:sol=root(residual,oldh[:size]/dh,tol=1e-12)
    except ValueError as e:raise ValueError('Thermodynamic root iteration rejected, not an accepted physical state: '+str(e))
    h,M,F,HH=amounts(sol.x);r=residual(sol.x)*energyScale
    if np.max(np.abs(r))>.01:raise ValueError('Constrained energy residual did not converge: '+str(np.max(np.abs(r))))
    if event and not (0<F[0]/requested<=1+1e-10):raise ValueError('Surface event is outside requested transfer')
    topV=0. if empty else M[-1]*state(h[-1])[0]
    if not event and (topV<0 or topV>cap+1e-10):
        return trial(oldstate,requested,cap,kind,limits,'empty' if topV<0 else 'full')
    if np.min(M)<0:raise ValueError('Negative accepted cell inventory')
    # h is only a quadrature limit at a removed top cell, never EOS water.
    oldc=np.divide(old[:,2],oldM,out=np.full(n,c0),where=oldM>0)
    def species(x,ret=False):
        c=np.r_[x*c0,oldc[-1]] if empty else x*c0
        BB=transported(old,M,c,F,2,limits[1])
        if F[0]>=0:BB[0]=(source_primitive(s['admitted_kg']+F[0],kind)-source_primitive(s['admitted_kg'],kind))[2]
        rr=M*c-old[:,2]-BB[:-1]+BB[1:]
        return (c,BB,rr) if ret else rr[:size]/(massScale*c0)
    cs=root(species,oldc[:size]/c0,tol=1e-12);c,BB,rr=species(cs.x,True)
    if np.max(np.abs(rr))>1e-10:raise ValueError(dict(reason='Constrained boron residual did not converge',maximumBoronResidual_kg=float(np.max(np.abs(rr))),rootMessage=str(cs.message)))
    if np.min(c[M>0])<limits[1][0]-1e-12 or np.max(c[M>0])>limits[1][1]+1e-12:raise ValueError(dict(reason='Boron concentration outside admitted bounds',
        minimumBoron_ppm=float(1e6*np.min(c[M>0])),maximumBoron_ppm=float(1e6*np.max(c[M>0])),
        maximumBoronResidual_kg=float(np.max(np.abs(rr))),rootMessage=str(cs.message)))
    cells=np.array([M,M*h,M*c]).T
    if empty:cells=cells[:-1]
    s['cells']=cells.tolist();boundary=np.array([F[0],HH[0],BB[0]])
    if F[0]>=0:
        s['source']=(np.array(s['source'])-boundary).tolist();s['admitted_kg']+=F[0]
    else:
        s['receiver']=(np.array(s['receiver'])-boundary).tolist();s['withdrawn_kg']-=F[0]
    if s['source'][0]<=0:raise ValueError('Outside finite-source positive-inventory bench')
    s['acceptedTransfers']+=1;s['topologyEvents']+=int(event is not None)
    # The upper mixed cell's empty-event equation closes identically.
    energyResidual=float(np.max(np.abs(M*h-oldH-HH[:-1]+HH[1:])))
    courant=[];fullCourant=[]
    for j in range(n):
        if j==0 and F[j]>=0:continue
        i=j-1 if F[j]>=0 else j
        if oldM[i]<=0 and F[j]!=0:raise ValueError('Empty old cell supplied a donor transfer')
        if oldM[i]>0:
            courant.append(abs(F[j])/oldM[i])
            if i<n-1:fullCourant.append(abs(F[j])/oldM[i])
    return s,dict(mass_kg=float(F[0]),enthalpy_J=float(HH[0]),boron_kg=float(BB[0]),event=event,
        maximumEnergyResidual_J=energyResidual,maximumBoronResidual_kg=float(np.max(np.abs(rr))),
        surfaceVolume_m3=float(topV),maximumActualDonorCourant=max(courant,default=0.),
        transportedEnthalpyRange_J_kg=[float(np.min(HH[F!=0]/F[F!=0])),float(np.max(HH[F!=0]/F[F!=0]))],
        transportedBoronRange_ppm=[float(1e6*np.min(BB[F!=0]/F[F!=0])),float(1e6*np.max(BB[F!=0]/F[F!=0]))],
        maximumFullCellDonorCourant=max(fullCourant,default=0.),rootEvaluations=int(sol.nfev+cs.nfev))

def inventory(s):return np.sum(np.array(s['cells']),axis=0)+s['source']+np.array(s['receiver'])
def uv(s,kind):
    # Independent HEOS U and V: source is a prescribed finite external
    # profile, vessel and receiver are this candidate's homogeneous cells.
    x,w=leggauss(16);lo=s['admitted_kg'];hi=donor
    V=U=0.
    for xx,ww in zip(x,w):
        h,_=source_point(lo+(hi-lo)*(xx+1)/2,kind);v,_,_,u=state(h)
        V+=(hi-lo)*ww/2*v;U+=(hi-lo)*ww/2*u
    for m,H,_ in s['cells']+[s['receiver']]:
        if m>0:
            v,_,_,u=state(H/m);V+=m*v;U+=m*u
    return U,V

def reference_withdrawn(q,kind,initialCells):
    # Independent outlet reference, never called by advancement.
    if q<=4500:return source_point(4500-q,kind)
    m=q-4500
    for M,H,B in initialCells:
        if m<=M:return H/M,B/M
        m-=M
    raise ValueError('Reference original inventory exhausted')

def reference_volume(s,kind,initialCells):
    # Independent unmixed reference volume at the same supplied/withdrawn
    # mass, not a volume imposed on the candidate's mixed-cell solution.
    mass=max(0.,s['admitted_kg']-s['withdrawn_kg']);x,w=leggauss(16)
    V=sum(mass*ww/2*state(source_point(mass*(xx+1)/2,kind)[0])[0] for xx,ww in zip(x,w))
    consumed=max(0.,s['withdrawn_kg']-s['admitted_kg'])
    for M,H,_ in initialCells:
        used=min(M,consumed);consumed-=used;V+=(M-used)*state(H/M)[0]
    return V

def run(n,divisions,kind):
    started=time.perf_counter();cap=b['vesselVolume_m3']/n;s=initial(n,kind)
    first=copy.deepcopy(s);base=inventory(s);U0,V0=uv(s,kind);metrics=[];out=[]
    maxLedger=np.zeros(3);maxWork=0.;maxCells=len(s['cells']);restart=False
    initialH=[H/M for M,H,_ in s['cells']];minH=min(initialH);maxH=max(initialH);minB=c0;maxB=c0
    endpointValues=[source_point(m,kind) for m in (0.,donor)]
    limits=[(min([v[i] for v in endpointValues]+[row[i+1]/row[0] for row in s['cells']]),
             max([v[i] for v in endpointValues]+[row[i+1]/row[0] for row in s['cells']])) for i in range(2)]
    envelope=limits[0]
    maxVolumeDifference=0.;maxFullVolumeResidual=0.
    for direction,total in ((1,4500.),(-1,5000.)):
        remaining=total
        while remaining>1e-8:
            # External transfer-resolution bound, not a remap timer. Actual
            # internal donor Courant numbers are separately measured below.
            fullMass=min(c[0] for c in s['cells'][:-1])
            dm=min(remaining,total/divisions,.5*fullMass)
            before=copy.deepcopy(s)
            try:new,m=trial(s,direction*dm,cap,kind,limits)
            except Exception as e:
                raise ValueError(dict(reason=e.args[0] if e.args else str(e),direction=direction,requestedMass_kg=direction*dm,
                    admitted_kg=s['admitted_kg'],withdrawn_kg=s['withdrawn_kg'],acceptedTransfers=s['acceptedTransfers'],
                    topologyEvents=s['topologyEvents'],originalStatePreserved=(s==before),lastAcceptedState=s))
            if before!=s:raise ValueError('Trial mutated original state')
            if not restart and new['admitted_kg']>2250:
                restored=json.loads(json.dumps(before));again,other=trial(restored,direction*dm,cap,kind,limits)
                if new!=again or m!=other:raise ValueError('Checkpoint continuation mismatch')
                restart=True
            if direction<0:
                q0=s['withdrawn_kg'];q1=new['withdrawn_kg'];weight=q1-q0
                # Compare interval-average withdrawn h to independent exact
                # integral; temperature conversion and peak remain readouts.
                nodes,weights=leggauss(16);Htrue=Btrue=pointError=pointBError=peak=0.
                hn=-m['enthalpy_J']/weight;cn=-m['boron_kg']/weight;tn=state(hn)[1]
                breaks=[2000.,4500.]+list(4500+np.cumsum([row[0] for row in first['cells']]))
                cuts=sorted(set([q0,q1]+[q for q in breaks if q0<q<q1]))
                for aa,zz in zip(cuts,cuts[1:]):
                    for xx,ww in zip(nodes,weights):
                        ht,ct=reference_withdrawn(aa+(zz-aa)*(xx+1)/2,kind,first['cells'])
                        Htrue+=(zz-aa)*ww/2*ht;Btrue+=(zz-aa)*ww/2*ct
                        error=abs(tn-state(ht)[1]);pointError+=(zz-aa)*ww/2*error;peak=max(peak,error)
                        pointBError+=(zz-aa)*ww/2*abs(cn-ct)
                ht=Htrue/weight
                out.append(dict(mass_kg=weight,error_K=pointError/weight,maximumPointError_K=peak,
                    intervalMeanError_K=abs(state(hn)[1]-state(ht)[1]),
                    enthalpy_J=-m['enthalpy_J'],referenceEnthalpy_J=Htrue,
                    boronError_kg=pointBError,intervalBoronError_kg=abs(-m['boron_kg']-Btrue)))
            s=new;remaining-=abs(m['mass_kg']);metrics.append(m)
            maxLedger=np.maximum(maxLedger,np.abs(inventory(s)-base));U,V=uv(s,kind)
            maxWork=max(maxWork,abs(U-U0+p*(V-V0)));maxCells=max(maxCells,len(s['cells']))
            currentH=[H/M for M,H,_ in s['cells']];currentB=[B/M for M,_,B in s['cells']]
            minH=min(minH,min(currentH));maxH=max(maxH,max(currentH));minB=min(minB,min(currentB));maxB=max(maxB,max(currentB))
            volumes=[vol(x) for x in s['cells']]
            maxFullVolumeResidual=max(maxFullVolumeResidual,max(abs(v-cap) for v in volumes[:-1]))
            maxVolumeDifference=max(maxVolumeDifference,abs(sum(volumes)-reference_volume(s,kind,first['cells'])))
    mean=math.fsum(o['mass_kg']*o['error_K'] for o in out)/5000
    rel=abs(math.fsum(o['enthalpy_J']-o['referenceEnthalpy_J'] for o in out))/math.fsum(o['referenceEnthalpy_J'] for o in out)
    return dict(history=kind,bands=n,subdivisions=divisions,acceptedTransfers=s['acceptedTransfers'],topologyEvents=s['topologyEvents'],
        maximumCellScalars=3*maxCells,maximumInventoryResidual=maxLedger.tolist(),maximumIndependentEnergyWorkResidual_J=maxWork,
        maximumSolveEnergyResidual_J=max(m['maximumEnergyResidual_J'] for m in metrics),
        rootEvaluations=sum(m['rootEvaluations'] for m in metrics),maximumActualDonorCourant=max(m['maximumActualDonorCourant'] for m in metrics),
        maximumFullCellDonorCourant=max(m['maximumFullCellDonorCourant'] for m in metrics),meanOutletError_K=mean,
        acceptedEnthalpyRange_J_kg=[minH,maxH],acceptedTemperatureRange_K=[state(minH)[1],state(maxH)[1]],
        acceptedBoronRange_ppm=[minB*1e6,maxB*1e6],sourceInitialEnthalpyEnvelope_J_kg=list(envelope),
        sourceInitialBoronEnvelope_ppm=[v*1e6 for v in limits[1]],
        transportedEnthalpyRange_J_kg=[min(m['transportedEnthalpyRange_J_kg'][0] for m in metrics),max(m['transportedEnthalpyRange_J_kg'][1] for m in metrics)],
        transportedBoronRange_ppm=[min(m['transportedBoronRange_ppm'][0] for m in metrics),max(m['transportedBoronRange_ppm'][1] for m in metrics)],
        maximumEnthalpyEnvelopeExcursion_J_kg=max(0.,envelope[0]-minH,maxH-envelope[1]),
        maximumFullCellVolumeResidual_m3=maxFullVolumeResidual,maximumUnmixedReferenceLevelDifference_mm=1000*maxVolumeDifference/b['area_m2'],
        maximumPointOutletError_K=max(o['maximumPointError_K'] for o in out),
        meanIntervalOutletError_K=math.fsum(o['mass_kg']*o['intervalMeanError_K'] for o in out)/5000,relativeWithdrawnEnthalpyError=rel,
        meanOutletBoronError_ppm=1e6*math.fsum(o['boronError_kg'] for o in out)/5000,
        screensPass=mean<=b['maximumOutletMeanAbsoluteError_K'] and rel<=b['maximumRelativeWithdrawnEnthalpyError'],
        final=s,wallSeconds=time.perf_counter()-started)

cases=[('uniform',48,16),('nonuniform-initial',48,16),('smooth',48,16),('smooth',48,64),
    ('smooth',96,32),('smooth',192,64),('boron-jump',48,16),('curved',48,16),('curved',96,32),('curved',192,64)]
sample=np.array([0.,1.,2.]);width=np.array([1.,100.,1.]);bounded=slopes(sample,width,(0.,2.))
if not (sample[1]-bounded[1]*width[1]/2>=sample[0] and sample[1]+bounded[1]*width[1]/2<=sample[2]):
    raise ValueError('Unequal-mass face reconstruction is not bounded')
rows=[]
for kind,n,d in cases:
    try:
        row=run(n,d,kind);rows.append(row)
        print(kind,n,d,row['meanOutletError_K'],row['screensPass'],file=sys.stderr,flush=True)
    except Exception as e:
        rows.append(dict(history=kind,bands=n,subdivisions=d,rejected=e.args[0] if e.args else str(e)))
        detail=e.args[0] if e.args else str(e)
        if isinstance(detail,dict):detail={k:v for k,v in detail.items() if k!='lastAcceptedState'}
        print(kind,n,d,'REJECTED',str(detail),file=sys.stderr,flush=True)
print(json.dumps(dict(scope='Actual conservative EOS-constrained homogeneous fixed cells with MUSCL faces and mixed cut-cell events; offline only',
    Python=platform.python_version(),CoolProp=CoolProp.__version__,rows=rows,coupledPZRQualified=False),allow_nan=False))
`}`

if (import.meta.main) {
  const [page, python, output] = process.argv.slice(2)
  if (!page || !python || process.argv.length > 5) throw Error('Usage: constrained.ts owner.md python [evidence.json]')
  const input = parseTransportBasis(await Bun.file(page).text())
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const identities = { input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(constrainedCalculation),
    sourceHash: hash(await Bun.file(import.meta.path).text()),
    propertySourceHash: hash(await Bun.file(new URL('./reference-design-pressurizer-transport.ts', import.meta.url)).text()) }
  const child = Bun.spawn([python, '-c', constrainedCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw Error('Offline constrained transport failed')
  const result = { ...identities, ...JSON.parse(stdout) }
  if (output) await Bun.write(output, JSON.stringify(result, null, 2)+'\n')
  console.log(JSON.stringify(result, null, 2))
}
