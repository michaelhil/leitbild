/** Offline contact/gradient representation experiment; not a live PZR solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseTransportBasis, transportProperties } from './reference-design-pressurizer-transport'

export function parseGradientBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-pressurizer-gradient\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected exactly one reference-pressurizer-gradient block')
  return { ...parseTransportBasis(document), gradient: z.object({ specificHeatingRate_W_kg: z.number().finite().positive() }).strict().parse(JSON.parse(blocks[0]![1]!)) }
}

export const gradientCalculation = `${transportProperties}${String.raw`
import numpy as np
from numpy.polynomial.legendre import leggauss

# A region carries mass, affine specific h/c, and whether its bottom boundary
# is a transported material contact. Numerical cell seams are not contacts.
# Quadratic polynomials occur only in exact heating and the independent oracle.
def poly(a,r):return sum(v*r**i for i,v in enumerate(a))
def integral(a):return sum(v/(i+1) for i,v in enumerate(a))
def cut(s,a,z):
    if not 0<=a<z<=1:raise ValueError('Invalid material interval')
    def shifted(v):return [sum(v[j]*math.comb(j,i)*a**(j-i)*(z-a)**i for j in range(i,len(v))) for i in range(len(v))]
    return dict(m=s['m']*(z-a),h=shifted(s['h']),c=shifted(s['c']),contact=s['contact'] and a==0)
def constant(m,h,c,contact=False):return dict(m=m,h=[h,0.],c=[c,0.],contact=contact)
def conserved(xs):return [math.fsum(s['m'] for s in xs),*[math.fsum(s['m']*integral(s[k]) for s in xs) for k in ('h','c')]]
def extrema(a):
    points=[0.,1.]
    if len(a)==3 and a[2]!=0 and 0<-a[1]/(2*a[2])<1:points.append(-a[1]/(2*a[2]))
    return [poly(a,r) for r in points]
@lru_cache(maxsize=4)
def gauss(q):
    x,w=leggauss(q);return list(zip((x+1)/2,w/2))
def eos(xs,q=8):
    # Independent HEOS U, rather than substituting H-pV in the energy check.
    return [math.fsum(s['m']*w*state(poly(s['h'],r))[j] for s in xs for r,w in gauss(q)) for j in (0,2,3)]
def subset(xs,lo,hi):
    out=[];position=0.
    for s in xs:
        a=max(lo,position);z=min(hi,position+s['m'])
        if z>a:out.append(cut(s,max(0.,(a-position)/s['m']),min(1.,(z-position)/s['m'])))
        position+=s['m']
    if not out:raise ValueError('Empty integration interval')
    return out
projection=dict(volumeChange_m3=0.,absoluteVolumeChange_m3=0.,entropyChange_J_K=0.,absoluteEntropyChange_J_K=0.)
def project(xs,contact=False):
    m=math.fsum(s['m'] for s in xs);result=dict(m=m,contact=contact);offset=0.
    for k in ('h','c'):
        average=math.fsum(s['m']*integral(s[k]) for s in xs)/m
        moment=0.;offset=0.;bounds=[]
        for s in xs:
            a=offset/m;d=s['m']/m
            moment+=d*(a*integral(s[k])+d*sum(v/(i+2) for i,v in enumerate(s[k])))
            offset+=s['m'];bounds.extend(extrema(s[k]))
        raw=12*(moment-.5*average)
        # Conservative mean with a bounded first moment. This is an explicitly
        # measured numerical projection, never thermodynamic physical mixing.
        bound=max(0.,2*min(average-min(bounds),max(bounds)-average))
        slope=math.copysign(min(abs(raw),bound),raw)
        result[k]=[average-.5*slope,slope]
    return result
def remap_profiles(xs,n,q=8):
    before=conserved(xs);v0,s0,_=eos(xs,q)
    groups=[]
    for s in xs:
        if not groups or s['contact']:groups.append([])
        groups[-1].append(s)
    capacity=b['vesselVolume_m3']/n;bands=[];band=[];occupied=0.
    for groupIndex,group in enumerate(groups):
        total=math.fsum(s['m'] for s in group);lo=0.
        while lo<total:
            contact=groupIndex>0 and lo==0
            def candidate(hi):return project(subset(group,lo,hi),contact)
            remaining=candidate(total);v=eos([remaining],q)[0];available=capacity-occupied
            if v>available:
                hi=brentq(lambda end: eos([candidate(end)],q)[0]-available,
                    lo+max(1e-12,math.ulp(lo)*2),total,xtol=1e-9,rtol=1e-13)
                region=candidate(hi);full=True
            else:hi=total;region=remaining;full=False
            if len(band)>=3:raise ValueError('More than two material contacts in one geometric band')
            band.append(region);occupied+=eos([region],q)[0];lo=hi
            if full or capacity-occupied<=64*math.ulp(capacity):
                bands.append(band);band=[];occupied=0.
                if len(bands)>=n:raise ValueError('Full liquid boundary')
    if band:bands.append(band)
    if not bands:raise ValueError('Empty liquid boundary')
    flat=[s for band in bands for s in band];after=conserved(flat)
    errors=[abs(x-y) for x,y in zip(before,after)]
    if errors[0]>1e-6 or errors[1]>.5 or errors[2]>1e-7:raise ValueError('Projection changed conserved inventory '+str(errors))
    v1,s1,_=eos(flat,q)
    projection['volumeChange_m3']+=v1-v0;projection['absoluteVolumeChange_m3']+=abs(v1-v0)
    projection['entropyChange_J_K']+=s1-s0;projection['absoluteEntropyChange_J_K']+=abs(s1-s0)
    return flat,max(map(len,bands))
def remove(xs,dm):
    total=conserved(xs)[0]
    if not 0<dm<total:raise ValueError('Empty liquid boundary')
    return subset(xs,dm,total),subset(xs,0,dm)
def heat(xs,duration,kind):
    out=[];total=conserved(xs)[0];offset=0.;q=b['gradient']['specificHeatingRate_W_kg']*duration
    for s in xs:
        a=offset/total;d=s['m']/total
        shape=[.5+a,d,0.] if kind=='affine' else [.5+3*a*(1-a),3*d*(1-2*a),-3*d*d]
        out.append(dict(m=s['m'],h=[(s['h'][i] if i<len(s['h']) else 0.)+q*shape[i] for i in range(3)],c=s['c'].copy(),contact=s['contact']))
        offset+=s['m']
    return out,q*total
def heat_entropy(before,after,q=8):
    # Independent heat/T integral along the prescribed fixed-p heating path;
    # no Q/Tmean substitution and no projection entropy counted as heat.
    return math.fsum(s['m']*w*(poly(z['h'],r)-poly(s['h'],r))*
        math.fsum(wt/state(poly(s['h'],r)+t*(poly(z['h'],r)-poly(s['h'],r)))[1] for t,wt in gauss(q))
        for s,z in zip(before,after) for r,w in gauss(q))
def run_profiles(n,steps,kind,q=8,restore=False,boron=False):
    for key in projection:projection[key]=0.
    hi=enthalpy(b['initial']['temperature_K']);ci=b['initial']['boron_ppm']*1e-6
    xs=[constant(b['initialVolume_m3']/state(hi)[0],hi,ci)]
    if boron:xs[0]['c']=[.0002,.001]
    if n:xs,_=remap_profiles(xs,n,q)
    sources={key:constant(b['sourceMass_kg'],hi if boron else enthalpy(b[key]['temperature_K']),ci if boron else b[key]['boron_ppm']*1e-6) for key in ('cold','warm')}
    receiver=constant(b['receiverMass_kg'],hi,ci);outlet=[];Q=0.;heatV=heatS=heatIntegralS=0.;maxRegions=len(xs);maxLocal=1;maxErrors=[0.]*4
    def allstates():return [*xs,*sources.values(),receiver]
    initial=conserved(allstates());v0,_,u0=eos(allstates(),q)
    for stroke in b['strokes']:
        if stroke['kind']=='hold':
            if kind!='none':
                beforeV,beforeS,_=eos(xs,q);before=xs;xs,dQ=heat(xs,stroke['duration_s'],kind);Q+=dQ
                afterV,afterS,_=eos(xs,q);heatV+=afterV-beforeV;heatS+=afterS-beforeS
                heatIntegralS+=heat_entropy(before,xs,q)
                if n:xs,local=remap_profiles(xs,n,q);maxLocal=max(maxLocal,local)
        else:
            for _ in range(steps):
                dm=stroke['mass_kg']/steps
                if stroke['kind']=='admit':
                    source=sources[stroke['source']];moved=cut(source,0.,dm/source['m'])
                    sources[stroke['source']]=cut(source,dm/source['m'],1.)
                    xs[0]['contact']=any(abs(poly(moved[k],1.)-poly(xs[0][k],0.))>32*math.ulp(max(abs(poly(moved[k],1.)),abs(poly(xs[0][k],0.)))) for k in ('h','c'))
                    xs=[moved,*xs]
                else:
                    xs,delivered=remove(xs,dm);outlet.extend(delivered)
                    inv=conserved([receiver,*delivered]);receiver=constant(inv[0],inv[1]/inv[0],inv[2]/inv[0])
                if n:xs,local=remap_profiles(xs,n,q);maxLocal=max(maxLocal,local)
                if restore:xs,sources,receiver=json.loads(json.dumps([xs,sources,receiver]))
                maxRegions=max(maxRegions,len(xs))
        now=conserved(allstates());v,_,u=eos(allstates(),q)
        errors=[abs(now[0]-initial[0]),abs(now[1]-initial[1]-Q),abs(now[2]-initial[2]),abs(u-u0+p*(v-v0)-Q)]
        maxErrors=[max(a,z) for a,z in zip(maxErrors,errors)]
    if maxErrors[0]>1e-6 or maxErrors[1]>.5 or maxErrors[2]>1e-7 or maxErrors[3]>.5:raise ValueError('Finite-owner heat/material ledger failed '+str(maxErrors))
    if n and (maxRegions>3*n or maxLocal>3):raise ValueError('Unbounded persistent state')
    return dict(bands=n,subdivisions=steps,quadrature=q,heating=kind,maximumPersistentRegions=maxRegions,maximumRegionsPerBand=maxLocal,
        maximumMassResidual_kg=maxErrors[0],maximumEnthalpyMinusHeatResidual_J=maxErrors[1],maximumBoronResidual_kg=maxErrors[2],maximumInternalEnergyPlusPistonWorkMinusHeatResidual_J=maxErrors[3],
        heatAdded_J=Q,heatInducedVolumeChange_m3=heatV,heatEntropyChange_J_K=heatS,independentHeatOverTemperatureIntegral_J_K=heatIntegralS,
        heatEntropyIdentityResidual_J_K=heatS-heatIntegralS,projection=copy.deepcopy(projection),
        outlet=outlet,finalState=xs)
def compare(actual,exact,q=16):
    # Integrate differences on cumulative discharged MASS using independent
    # polynomial material histories, not the candidate's timesteps or cell ids.
    total=conserved(actual)[0];cuts=sorted(set([0.,total]+[min(total,sum(s['m'] for s in xs[:i])) for xs in (actual,exact) for i in range(1,len(xs)+1)]))
    err=peak=boron=0.
    for lo,hi in zip(cuts,cuts[1:]):
        if hi-lo<1e-7:continue
        a=subset(actual,lo,hi)[0];e=subset(exact,lo,hi)[0]
        for r,w in gauss(q):
            dt=abs(state(poly(a['h'],r))[1]-state(poly(e['h'],r))[1]);err+=(hi-lo)*w*dt;peak=max(peak,dt)
            boron+=(hi-lo)*w*abs(poly(a['c'],r)-poly(e['c'],r))
    return dict(meanAbsoluteTemperatureError_K=err/total,maximumSampledTemperatureError_K=peak,
        meanAbsoluteBoronFractionError=boron/total,relativeWithdrawnEnthalpyError=abs(conserved(actual)[1]/conserved(exact)[1]-1))
def brief(r):return {k:v for k,v in r.items() if k not in ('outlet','finalState')}

rows=[];oracles={kind:run_profiles(0,1,kind) for kind in ('none','affine','curved')}
# Literal bottom-donor oracle independent of profile splitting/projection.
expected=[(1500,'cold'),(2000,'warm'),(1000,'cold'),(500,'initial')]
literal=[constant(m,enthalpy(b[k]['temperature_K']),b[k]['boron_ppm']*1e-6) for m,k in expected]
if compare(oracles['none']['outlet'],literal)['maximumSampledTemperatureError_K']>1e-6:raise ValueError('Literal donor order failed')
initialMass=b['initialVolume_m3']/state(enthalpy(b['initial']['temperature_K']))[0]
analyticHeat=b['gradient']['specificHeatingRate_W_kg']*(120*(initialMass+2500)+60*(initialMass+3000))
if any(abs(oracles[k]['heatAdded_J']-analyticHeat)>.001 for k in ('affine','curved')):raise ValueError('Independent total heat integral failed')
for kind in ('none','affine','curved'):
    for n,steps in [(48,4),(48,16),(48,64),(96,16)]:
        start=time.perf_counter();result=run_profiles(n,steps,kind);comparison=compare(result['outlet'],oracles[kind]['outlet'])
        row={**brief(result),**comparison,'wallSeconds':time.perf_counter()-start};rows.append(row)
        if comparison['meanAbsoluteTemperatureError_K']>b['maximumOutletMeanAbsoluteError_K'] or comparison['relativeWithdrawnEnthalpyError']>b['maximumRelativeWithdrawnEnthalpyError']:raise ValueError('Frozen outlet gate failed '+str(row))
        if kind in ('none','affine') and comparison['maximumSampledTemperatureError_K']>1e-6:raise ValueError('Affine contact transport was not exact '+str(row))
curved=[r for r in rows if r['heating']=='curved' and r['subdivisions']==16]
if curved[1]['meanAbsoluteTemperatureError_K']>=curved[0]['meanAbsoluteTemperatureError_K']:raise ValueError('Curved heating failed spatial improvement')
quad=run_profiles(48,16,'curved',16);quadCompare=compare(quad['outlet'],oracles['curved']['outlet'])
q8=next(r for r in rows if r['bands']==48 and r['subdivisions']==16 and r['heating']=='curved')
quadratureDifferences=dict(meanOutletTemperature_K=abs(quadCompare['meanAbsoluteTemperatureError_K']-q8['meanAbsoluteTemperatureError_K']),
    projectionVolume_m3=abs(quad['projection']['volumeChange_m3']-q8['projection']['volumeChange_m3']),
    projectionEntropy_J_K=abs(quad['projection']['entropyChange_J_K']-q8['projection']['entropyChange_J_K']))
if quadratureDifferences['meanOutletTemperature_K']>1e-6 or quadratureDifferences['projectionVolume_m3']>1e-8 or quadratureDifferences['projectionEntropy_J_K']>.001:raise ValueError('Profile EOS quadrature not resolved')
if any(abs(r['heatEntropyIdentityResidual_J_K'])>.001 for r in [*rows,*oracles.values(),quad]):raise ValueError('Independent heat entropy identity failed')
normal=run_profiles(48,16,'affine');restored=run_profiles(48,16,'affine',restore=True)
if normal!=restored:raise ValueError('JSON restoration changed physical/contact state')
boronExact=run_profiles(0,1,'none',boron=True);boronResult=run_profiles(48,16,'none',boron=True)
boronComparison=compare(boronResult['outlet'],boronExact['outlet'])
if boronComparison['meanAbsoluteBoronFractionError']>1e-12:raise ValueError('Affine boron history failed')
if any(min(extrema(s['c']))<0 or max(extrema(s['c']))>.0013 for s in boronResult['finalState']):raise ValueError('Boron positivity/bounds failed')
overload=[constant(1.,enthalpy(430+i*20),i*.0001,i>0) for i in range(4)];before=copy.deepcopy(overload)
try:remap_profiles(overload,48)
except ValueError as error:
    if 'two material contacts' not in str(error):raise
else:raise ValueError('Four-contact stress silently grew or mixed')
if overload!=before:raise ValueError('Rejected candidate mutated accepted input')
# Closed-form affine split, withdrawal and restoration; no oracle made by
# calling the same splitting function with a different resolution.
h0=enthalpy(500);ramp=dict(m=100.,h=[h0,30000.],c=[.0002,.001],contact=False)
remaining,removed=remove([ramp],25.)
for actual,want in zip(conserved(removed),[25.,25*(h0+3750),25*.000325]):
    if abs(actual-want)>1e-5:raise ValueError('Analytical affine withdrawal integral failed')
for actual,want in zip(conserved(remaining),[75.,75*(h0+18750),75*.000825]):
    if abs(actual-want)>1e-5:raise ValueError('Analytical affine retained integral failed')
restoredRamp=project([*removed,*remaining])
if max(abs(a-z) for a,z in zip(restoredRamp['h'],ramp['h']))>1e-7:raise ValueError('Split/recombine failed affine profile')
print(json.dumps(dict(scope='Isobaric zero-gravity manufactured contact/gradient transport; no wall, pressure or phase qualification',
    Python=platform.python_version(),CoolProp=CoolProp.__version__,rows=rows,oracles={k:brief(v) for k,v in oracles.items()},
    quadrature16={**brief(quad),**quadCompare},quadratureDifferences=quadratureDifferences,
    checks=dict(checkpointRoundtrip=True,smoothBoron=boronComparison,fourRegionOverflowRejected=True,rejectedInputUnchanged=True,literalDonorOrder=True,independentHeatIntegral=True,analyticalAffineSplitAndRecombine=True),
    propertyChecks=propertyChecks,coupledPZRQualified=False),allow_nan=False))
`}`

if (import.meta.main) {
  const [page, python, output] = process.argv.slice(2)
  if (!page || !python || process.argv.length > 5)
    throw Error('Usage: reference-design-pressurizer-gradient.ts owner.md python [evidence.json]')
  const input = parseGradientBasis(await Bun.file(page).text())
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const child = Bun.spawn([python, '-c', gradientCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const result = { input, inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    propertySourceHash: hash(await Bun.file(new URL('./reference-design-pressurizer-transport.ts', import.meta.url)).text()),
    calculationHash: hash(gradientCalculation), ...JSON.parse(out) }
  if (output) await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
