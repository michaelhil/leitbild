/** Exact-flux information/closure discriminator, not a production advection solver. */
import { createHash } from 'node:crypto'
import { parseTransportBasis, transportProperties } from './reference-design-pressurizer-transport'

export const faceClosureCalculation = `${transportProperties}${String.raw`
import numpy as np
from numpy.polynomial.legendre import leggauss

# Analytic material coordinates belong ONLY to the independent fixture. The
# candidate state below retains fixed-cell M/H/B, not these source functions,
# characteristic labels, historical packets or per-transfer profile pieces.
@lru_cache(maxsize=8)
def nodes(q):
    x,w=leggauss(q);return list(zip((x+1)/2,w/2))
h0=enthalpy(b['initial']['temperature_K']);hc=enthalpy(b['cold']['temperature_K'])
c0=b['initial']['boron_ppm']*1e-6;donor=b['sourceMass_kg']
def shape(x,kind):
    if kind=='uniform':return h0,c0
    if kind=='matched-affine':return h0+(h0-hc)*x/(20*donor),c0
    if x>=0:return h0,c0
    s=-x/donor;f=math.sin(math.pi*s/2)**2 if kind=='curved' else s
    c=c0*(1-f) if kind!='boron-jump' else c0*(.5 if s>.5 else 1.)
    return h0+(hc-h0)*f,c
def analytic(x,kind):
    # Exact primitives of M/H/B from material coordinate zero to x.
    if kind=='uniform':return np.array([x,h0*x,c0*x])
    if kind=='matched-affine':return np.array([x,h0*x+(h0-hc)*x*x/(40*donor),c0*x])
    if x>=0:return np.array([x,h0*x,c0*x])
    s=-x/donor;F=s/2-math.sin(math.pi*s)/(2*math.pi) if kind=='curved' else s*s/2
    B=c0*donor*(s-F) if kind!='boron-jump' else c0*donor*(min(s,.5)+.5*max(s-.5,0.))
    return np.array([x,-donor*(h0*s+(hc-h0)*F),-B])
@lru_cache(maxsize=65536)
def thermo(x,kind,q):
    if x==0:return np.zeros(3)
    # Independently integrate v,u,s from the HEOS state; never derive the
    # energy check by replacing U with H-pV. Species do not affect this EOS.
    if x>0 and kind!='matched-affine':
        v,_,s,u=state(h0);return np.array([x*v,x*u,x*s])
    return sum((x*w*np.array([state(shape(x*r,kind)[0])[j] for j in (0,3,2)]) for r,w in nodes(q)),np.zeros(3))
def primitive(x,kind,q):return np.concatenate((analytic(x,kind),thermo(x,kind,q)))
def top_mass(kind,q):
    if kind!='matched-affine':return b['initialVolume_m3']/state(h0)[0]
    return brentq(lambda x:thermo(x,kind,q)[0]-b['initialVolume_m3'],1.,b['initialVolume_m3']/state(h0)[0],xtol=1e-10)
def inverse_volume(target,kind,top,q):
    if target>=0 and kind!='matched-affine':return target/state(h0)[0]
    if target==0:return 0.
    return brentq(lambda x:thermo(x,kind,q)[0]-target,-donor,top,xtol=1e-9,rtol=1e-13)
def fixture_faces(lower,n,kind,q):
    top=top_mass(kind,q);base=thermo(lower,kind,q)[0];end=thermo(top,kind,q)[0]
    cap=b['vesselVolume_m3']/n
    return [lower]+[top if base+j*cap>=end else inverse_volume(base+j*cap,kind,top,q) for j in range(1,n+1)]
def cell_truth(faces,kind,q):return np.array([primitive(z,kind,q)-primitive(a,kind,q) for a,z in zip(faces,faces[1:])])
def make_state(n,kind,q):
    faces=fixture_faces(0.,n,kind,q);truth=cell_truth(faces,kind,q)
    return dict(cells=truth[:,:3].tolist(),source=(analytic(0.,kind)-analytic(-donor,kind)).tolist(),
        receiver=[b['receiverMass_kg'],b['receiverMass_kg']*h0,b['receiverMass_kg']*c0],
        admitted_kg=0.,withdrawn_kg=0.,acceptedTransfers=0)
def advance(old,face_flux):
    # One shared signed M/H/B face transfer enters adjacent cells oppositely.
    # The analytic fixture supplies these exact fluxes. This function makes
    # NO claim to reconstruct them from insufficient cell averages.
    trial=copy.deepcopy(old);flux=np.asarray(face_flux)
    cells=np.asarray(trial['cells'])+flux[:-1]-flux[1:]
    # Reject nonfinite fluxes / genuinely negative mass before publishing any
    # owner. Cancellation-sized empty-cell remnants are reported, not flashed.
    if not np.all(np.isfinite(flux)) or np.min(cells[:,0])< -1e-6:raise ValueError('Unadmitted finite face transfer')
    trial['cells']=cells.tolist()
    if flux[0,0]>=0:
        trial['source']=(np.asarray(trial['source'])-flux[0]).tolist();trial['admitted_kg']+=float(flux[0,0])
    else:
        trial['receiver']=(np.asarray(trial['receiver'])-flux[0]).tolist();trial['withdrawn_kg']-=float(flux[0,0])
    if trial['source'][0]<=0:raise ValueError('Finite source exhausted')
    trial['acceptedTransfers']+=1
    return trial
def all_amounts(s):return np.sum(np.asarray(s['cells']),axis=0)+s['source']+np.asarray(s['receiver'])
def physical_energy_volume(s,faces,kind,q):
    source=thermo(-s['admitted_kg'],kind,q)-thermo(-donor,kind,q)
    vessel=np.sum(cell_truth(faces,kind,q)[:,3:],axis=0)
    m,H,_=s['receiver'];v,_,_,u=state(H/m)
    return source[1]+vessel[1]+m*u,source[0]+vessel[0]+m*v
def audit(s,faces,kind,q):
    truth=cell_truth(faces,kind,q);cells=np.asarray(s['cells']);occupied=truth[:,0]>0
    # EOS flash is an explicitly evaluated shortcut, NOT written into state.
    defects=[];thermal=0.;entropy=0.
    for a,z in zip(cells[occupied],truth[occupied]):
        v,_,ss,u=state(a[1]/a[0]);defects.append(a[0]*v-z[3]);thermal+=a[0]*u-z[4];entropy+=a[0]*ss-z[5]
    errors=np.max(np.abs(cells-truth[:,:3]),axis=0)
    return dict(maxCellMassError_kg=float(errors[0]),maxCellEnthalpyError_J=float(errors[1]),maxCellBoronError_kg=float(errors[2]),
        totalHomogeneousVolumeDefect_m3=math.fsum(defects),maximumCellVolumeDefect_m3=max(map(abs,defects)),
        levelDefect_mm=1000*math.fsum(defects)/b['area_m2'],homogenizationInternalEnergyChange_J=thermal,
        homogenizationEntropyChange_J_K=entropy,missingPistonWork_J=p*math.fsum(defects),
        internalEnergyPlusMissingWorkResidual_J=thermal+p*math.fsum(defects),
        emptyCellMaximumResiduals=np.max(np.abs(cells[~occupied]),axis=0).tolist() if np.any(~occupied) else [0.,0.,0.],
        occupiedCells=int(np.count_nonzero(occupied)))
@lru_cache(maxsize=64)
def mean_readout(n,kind,q):
    # Information-only diagnostic: ask what the first-cell mean would report
    # at the actual outlet. It does NOT drive the exact conservative fluxes.
    lower=-.9*donor;upper=500.;cap=b['vesselVolume_m3']/n;top=top_mass(kind,q)
    breaks=[lower,upper]
    for x in [0.,-donor/2]:
        if lower<x<upper:breaks.append(x)
        faceCross=inverse_volume(thermo(x,kind,q)[0]-cap,kind,top,q)
        if lower<faceCross<upper:breaks.append(faceCross)
    breaks=sorted(set(breaks));err=peak=H=Htrue=Berr=0.
    for lo,hi in zip(breaks,breaks[1:]):
        for r,w in nodes(32):
            x=lo+(hi-lo)*r;right=inverse_volume(thermo(x,kind,q)[0]+cap,kind,top,q)
            amount=analytic(right,kind)-analytic(x,kind);hh,cc=shape(x,kind)
            delta=abs(state(amount[1]/amount[0])[1]-state(hh)[1]);err+=(hi-lo)*w*delta;peak=max(peak,delta)
            H+=(hi-lo)*w*amount[1]/amount[0];Htrue+=(hi-lo)*w*hh
            Berr+=(hi-lo)*w*abs(amount[2]/amount[0]-cc)
    return dict(meanTemperatureError_K=err/(upper-lower),maximumSampledTemperatureError_K=peak,
        relativeWithdrawnEnthalpyError=abs(H/Htrue-1),meanBoronError_ppm=1e6*Berr/(upper-lower),
        passesInheritedThermalScreens=bool(err/(upper-lower)<=b['maximumOutletMeanAbsoluteError_K'] and abs(H/Htrue-1)<=b['maximumRelativeWithdrawnEnthalpyError']))
def run(n,steps,kind,q=8,restore=False):
    s=make_state(n,kind,q);initial=all_amounts(s);faces=fixture_faces(0.,n,kind,q)
    U0,V0=physical_energy_volume(s,faces,kind,q)
    maxima=dict(volume=0.,cellVolume=0.,level=0.,energy=0.,entropy=0.,identity=0.,mass=0.,enthalpy=0.,boron=0.,emptyMass=0.,occupied=0,finiteOwnerEnergyWork=0.)
    nominal=audit(s,faces,kind,q);snapshots=[]
    for targets in [np.linspace(0.,-.9*donor,steps+1)[1:],np.linspace(-.9*donor,500.,steps+1)[1:]]:
        for lower in targets:
            newfaces=fixture_faces(float(lower),n,kind,q)
            flux=np.array([analytic(a,kind)-analytic(z,kind) for a,z in zip(faces,newfaces)])
            s=advance(s,flux);faces=newfaces
            if restore:s=json.loads(json.dumps(s))
            report=audit(s,faces,kind,q);now=all_amounts(s)
            U,V=physical_energy_volume(s,faces,kind,q)
            for k,value in [('volume',abs(report['totalHomogeneousVolumeDefect_m3'])),('cellVolume',report['maximumCellVolumeDefect_m3']),
                ('level',abs(report['levelDefect_mm'])),('energy',abs(report['missingPistonWork_J'])),('entropy',abs(report['homogenizationEntropyChange_J_K'])),
                ('identity',abs(report['internalEnergyPlusMissingWorkResidual_J'])),('mass',abs(now[0]-initial[0])),
                ('enthalpy',abs(now[1]-initial[1])),('boron',abs(now[2]-initial[2])),('emptyMass',report['emptyCellMaximumResiduals'][0]),('occupied',report['occupiedCells']),
                ('finiteOwnerEnergyWork',abs(U-U0+p*(V-V0)))]:
                maxima[k]=max(maxima[k],float(value))
            if report['maxCellMassError_kg']>1e-6 or report['maxCellEnthalpyError_J']>.5 or report['maxCellBoronError_kg']>1e-7:raise ValueError('Face advancement failed independent analytic cell integral')
        snapshots.append(dict(phase='after admission' if len(snapshots)==0 else 'after withdrawal',**report))
    if maxima['mass']>1e-6 or maxima['enthalpy']>.5 or maxima['boron']>1e-7 or maxima['identity']>.5 or maxima['finiteOwnerEnergyWork']>.5:raise ValueError('Conservative/thermodynamic identity failed '+str(maxima))
    if kind=='uniform' and maxima['volume']>1e-8:raise ValueError('Uniform state developed a closure defect')
    return dict(bands=n,subdivisions=steps,history=kind,quadrature=q,persistentCellScalars=3*n,
        nominal=nominal,maximumObserved=maxima,snapshots=snapshots,meanOnlyOutletReadout=mean_readout(n,kind,q)),s

rows=[];partitionStates={};partitionErrors=[0.,0.,0.]
for kind,levels in [('uniform',[(48,16)]),('matched-affine',[(48,16),(96,16)]),
    ('smooth',[(48,4),(48,16),(48,64),(48,128),(96,16),(192,16)]),
    ('boron-jump',[(48,16),(48,128),(96,16)]),('curved',[(48,16),(48,128),(96,16),(192,16)])]:
    for n,steps in levels:
        start=time.perf_counter();row,end=run(n,steps,kind);rows.append(dict(**row,wallSeconds=time.perf_counter()-start))
        if n==48:
            stateVector=np.vstack((np.asarray(end['cells']),end['source'],end['receiver']))
            if kind in partitionStates:
                partitionErrors=np.maximum(partitionErrors,np.max(np.abs(stateVector-partitionStates[kind]),axis=0)).tolist()
            else:partitionStates[kind]=stateVector
if any(error>tolerance for error,tolerance in zip(partitionErrors,[1e-6,.5,1e-7])):raise ValueError('Changing transfer partition changed accepted physical state')
normal,accepted=run(48,16,'curved');restored,restarted=run(48,16,'curved',restore=True)
if normal!=restored or accepted!=restarted:raise ValueError('Restart changed fixed-cell advancement')
quad,_=run(48,16,'curved',16)
quadError=abs(quad['maximumObserved']['volume']-normal['maximumObserved']['volume'])
if quadError>1e-8:raise ValueError('EOS volume quadrature not resolved')
original=copy.deepcopy(accepted);bad=np.zeros((49,3));bad[1,0]=1e9
try:advance(accepted,bad)
except ValueError:pass
else:raise ValueError('Negative-cell transfer was accepted')
if accepted!=original:raise ValueError('Rejected face transfer mutated physical owners')
for kind in ('smooth','curved'):
    subset=[r for r in rows if r['history']==kind and r['subdivisions']==16]
    if not all(a['maximumObserved']['volume']>z['maximumObserved']['volume'] for a,z in zip(subset,subset[1:])):raise ValueError('Spatial closure-defect refinement failed')
print(json.dumps(dict(scope='Exact prescribed face-flux conditioning of fixed-cell conserved means, not a usable transport solver',
    Python=platform.python_version(),CoolProp=CoolProp.__version__,rows=rows,quadratureVolumeDifference_m3=quadError,
    transferPartitionStateDifferences=partitionErrors,
    checks=dict(fixedCellStateIndependentOfTransferCount=True,independentAnalyticCellIntegrals=True,finiteOwnerConservation=True,
        uniformNoClosureDefect=True,checkpointRoundtrip=True,atomicRejection=True,spatialDefectRefinement=True),
    coupledPZRQualified=False),allow_nan=False))
`}`

if (import.meta.main) {
  const [page, python, output] = process.argv.slice(2)
  if (!page || !python || process.argv.length > 5)
    throw Error('Usage: reference-design-pressurizer-face-closure.ts owner.md python [evidence.json]')
  const input = parseTransportBasis(await Bun.file(page).text())
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const identity = { input, inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    propertySourceHash: hash(await Bun.file(new URL('./reference-design-pressurizer-transport.ts', import.meta.url)).text()),
    calculationHash: hash(faceClosureCalculation) }
  const child = Bun.spawn([python, '-c', faceClosureCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw Error(err)
  const result = { ...identity, ...JSON.parse(out) }
  if (output) await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
