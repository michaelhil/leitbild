/** Bounded, symmetric two-train CMT reconstruction experiment; never a plant runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { cmtLiquidDefinitions, cmtObservationCalculation, parseCmtBasis } from './reference-design-cmt.ts'

const schema = z.object({ topCells: z.number().int().min(4).max(48), maximumStep_s: z.number().positive().max(.25) }).strict()
export function parseStratificationBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-cmt-stratification\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-stratification numeric block')
  return { ...parseCmtBasis(document), ...schema.parse(JSON.parse(blocks[0]![1]!)) }
}
// Explicit owned fragments; no source-text discovery or caller-supplied code.
export const cmtStratificationDefinitions = cmtLiquidDefinitions + String.raw`
import time
from scipy.optimize import brentq

def minmod(a,c):
    return math.copysign(min(abs(a),abs(c)),a) if a*c>0 else 0.

def slopes(values,centers):
    s=np.zeros(len(values))
    for j in range(1,len(values)-1):
        s[j]=minmod((values[j]-values[j-1])/(centers[j]-centers[j-1]),
                    (values[j+1]-values[j])/(centers[j+1]-centers[j]))
    return s

def faces(values,centers,edges,limited,inlet_left=None,inlet_right=None):
    slope=slopes(values,centers) if limited else np.zeros(len(values))
    if limited and inlet_left is not None:
        slope[0]=minmod((values[0]-inlet_left)/(centers[0]-edges[0]),(values[1]-values[0])/(centers[1]-centers[0]))
    if limited and inlet_right is not None:
        slope[-1]=minmod((inlet_right-values[-1])/(edges[-1]-centers[-1]),(values[-1]-values[-2])/(centers[-1]-centers[-2]))
    return values+slope*(edges[:-1]-centers),values+slope*(edges[1:]-centers)

def tracer_checks():
    # Exact sharp-front advection, with independent integrated boundary flux.
    # This tests the actual reconstruction, not a second copy of its formula.
    N=40;edges=np.linspace(0,1,N+1);centers=(edges[:-1]+edges[1:])/2;dz=1/N
    results=[]
    for reverse,limited in [(False,False),(False,True),(True,True)]:
        c=np.zeros(N);incoming=0.;exported=0.;dt=.0025;v=-1. if reverse else 1.
        for _ in range(80):
            old=c.copy()
            def flux(c):
                left,right=faces(c,centers,edges,limited,1. if v>0 else None,1. if v<0 else None)
                return np.concatenate([[1.],right])*v if v>0 else np.concatenate([left,[1.]])*v
            def r(c):return c-old+dt/dz*np.diff(flux(c))
            solved=root(r,c,options=dict(xtol=1e-11));c=solved.x
            if not np.all(np.isfinite(c)) or max(abs(r(c)))>1e-10:raise ValueError('Tracer implicit residual failed')
            f=flux(c);incoming+=dt*(f[-1]*-1 if reverse else f[0]);exported+=dt*(-f[0] if reverse else f[-1])
            if min(c)<-1e-10 or max(c)>1+1e-10:raise ValueError('Tracer update created extrema')
        exact=np.clip((.2-edges[:-1])/dz,0,1)
        if reverse:exact=exact[::-1]
        total_variation=sum(abs(np.diff(np.concatenate([[0. if reverse else 1.],c,[1. if reverse else 0.]]))))
        error=abs(dz*sum(c)+exported-incoming)
        if error>1e-10 or total_variation>1+1e-9:raise ValueError('Tracer conservation/variation failed')
        results.append(dict(reverse=reverse,limited=limited,massResidual=error,totalVariation=total_variation,
            cellAverageL1=float(dz*sum(abs(c-exact))),means=c.tolist()))
    if results[1]['cellAverageL1']>=results[0]['cellAverageL1']:raise ValueError('Limited tracer did not improve this sharp-front error')
    if max(abs(np.array(results[1]['means'])-np.array(results[2]['means'])[::-1]))>1e-9:raise ValueError('Reverse-flow reconstruction is asymmetric')
    return results

def study(name,nt,dtmax,limited,face_gravity=True,actual_inlet=True):
    started=time.perf_counter()
    # Resolve the initially traversed top 1.5 m, keeping three physical lower
    # bands. Doubling nt changes neither a probe location nor tank geometry.
    heights=np.array([1.5/nt]*nt+[1.5]*3);N=len(heights)
    edges=np.concatenate([[0.],np.cumsum(heights)]);depth=(edges[:-1]+edges[1:])/2
    vs=[vessel([b['primaryVolume_m3']],[0],[3.],3.),
        vessel([1.]+list(10*heights),[0.]+list(heights),[12.]+list(12-depth),12.),
        vessel([.5],[0],[3.],3.)]
    sizes=[len(v['V'])+1 for v in vs];cuts=np.cumsum([0]+sizes)
    p0=b['initialPressure_MPa']*1e6;hot=b['hot_C']+273.15;cold=b['cold_C']+273.15
    rh=water(p0,hot)[0];rc=water(p0,cold)[0]
    pt=brentq(lambda p:p-p0+.5*(rh+water(p,hot)[0])*g*9,p0-1e5,p0)
    y0=np.array([p0,hot,pt,hot]+[cold]*N+[p0,hot]);physical=len(y0)
    scale=np.array([1e7 if i in cuts[:-1] else 500. for i in range(physical)])
    def unpack(y):return [state(v,y[cuts[k]:cuts[k+1]]) for k,v in enumerate(vs)]
    initial=unpack(y0);weights=[1,2,2]
    def totals(ss,key):return sum(w*sum(s[key]) for w,s in zip(weights,ss))
    M0=totals(initial,'M');E0=totals(initial,'E');old=initial
    x=np.concatenate([y0/scale,np.zeros(3+N)])
    t=0.;nextout=b['output_s'];incoming=0.;outgoing=0.;trace=[];nfev=0;maxdef=0.;em=0.;ee=0.
    def profile(tank,inflow):
        hs=np.array([r['h'] for r in tank['rows'][1:]])
        left,right=faces(hs,depth,edges,limited,tank['rows'][0]['h'] if actual_inlet and inflow>0 else None)
        return hs,left,right
    def temperature(p,h):
        # Reconstructed h is inverted only inside the admitted liquid domain.
        upper=min(623.149,brentq(lambda T:_PSat_T(T)*1e6-p,273.151,623.15)-1e-5) if p<_PSat_T(623.15)*1e6 else 623.149
        return brentq(lambda T:water(p,T)[2]-h,273.151,upper)-273.15
    def record(q):
        ss=old;tank=ss[1];hs,left,right=profile(tank,q[3]);probes=[]
        for d in [.75,5.25]:
            js=[j for j in range(N) if edges[j]-1e-10<=d<=edges[j+1]+1e-10]
            samples=[]
            for j in js:
                r=tank['rows'][j+1];fraction=(d-edges[j])/heights[j]
                hp=left[j]+fraction*(right[j]-left[j]);pp=r['p']+r['rho']*g*(d-depth[j])
                samples.append(temperature(pp,hp))
            probes.append(dict(depth_m=d,elevation_m=12-d,reconstructedLiquid_C=samples,
                               neighboringCellMean_C=[tank['rows'][j+1]['T']-273.15 for j in js]))
        # Thermal-front descriptor is a profile crossing, not displaced volume
        # or a sensor. Normalize by actual finite inlet and bottom enthalpies.
        lo=hs[-1];hi=tank['rows'][0]['h'];crossings=[]
        for f in [.1,.5,.9]:
            target=lo+f*(hi-lo);found=[]
            for j in range(N):
                if min(left[j],right[j])<=target<=max(left[j],right[j]) and left[j]!=right[j]:
                    found.append(float(edges[j]+heights[j]*(target-left[j])/(right[j]-left[j])))
                if j<N-1 and (right[j]-target)*(left[j+1]-target)<0:found.append(float(edges[j+1]))
            crossings.append(dict(fraction=f,depths_m=found))
        trace.append(dict(t_s=t,primaryPressure_MPa=ss[0]['ptop']/1e6,primary_C=ss[0]['rows'][0]['T']-273.15,
            balanceLine_C=tank['rows'][0]['T']-273.15,sourceFlow_kg_s=float(q[1]),inletFlow_kg_s=float(q[0]),
            grossInlet_kg=incoming,grossOutlet_kg=outgoing,probes=probes,frontCrossings=crossings,
            minimumCell_C=min(r['T']-273.15 for r in tank['rows'][1:]),maximumCell_C=max(r['T']-273.15 for r in tank['rows'][1:]),
            rawLevelDP_Pa=g*(sum(r['rho']*H for r,H in zip(tank['rows'][1:],heights))-water(tank['ptop'],cold)[0]*6),
            rawSourceDP_Pa=2000*q[1]*abs(q[1])/25**2*rc/tank['rows'][-1]['rho']))
    record(np.zeros(3+N))
    while t<b['duration_s']-1e-9:
        dt=min(dtmax,nextout-t,b['duration_s']-t);opening=min(1.,(t+dt)/2.)
        def residual(xx):
            ss=unpack(xx[:physical]*scale);q=xx[physical:]*25
            rm=[(s['M']-o['M'])/dt for s,o in zip(ss,old)]
            re=[(s['E']-o['E'])/dt for s,o in zip(ss,old)]
            def connect(a,ia,c,ic,m,zface,hface=None):
                donor=ss[a]['rows'][ia] if m>=0 else ss[c]['rows'][ic]
                H=(donor['h'] if hface is None else hface)+g*(zface if face_gravity and zface is not None else donor['z'])
                # One represented train corresponds to two identical physical
                # trains; main receives twice each flux, never twice its store.
                wa=2 if a==0 else 1;wc=2 if c==0 else 1
                rm[a][ia]+=wa*m;rm[c][ic]-=wc*m
                re[a][ia]+=wa*m*H;re[c][ic]-=wc*m*H
            def loss(m,p1,z1,r1,p2,z2,r2,K,check=False):
                rho=r1 if m>=0 else r2;demand=p1-p2+.5*(r1+r2)*g*(z1-z2)
                defect=(K*m*abs(m)*rc/rho-demand+(1000 if check else 0))/20000
                return math.hypot(m/25,defect)-m/25-defect if check else defect
            main,tank,d=ss;qi,qo,qd=q[:3]
            # External zero-storage pipes transport donor total enthalpy;
            # do not relocate the donor's h to another elevation unchanged.
            connect(0,0,1,0,qi,None);connect(1,-1,2,0,qo,None);connect(2,0,0,0,qd,None)
            hydraulic=[loss(qi,main['ptop'],3.,main['rows'][0]['rho'],tank['ptop'],12.,tank['rows'][0]['rho'],2000/25**2*rh/rc),
                loss(qo,tank['pbottom'],6.,tank['rows'][-1]['rho'],d['ptop'],3.,d['rows'][0]['rho'],20000/25**2/opening**2,True),
                loss(qd,d['ptop'],3.,d['rows'][0]['rho'],main['ptop'],3.,main['rows'][0]['rho'],10000/100**2)]
            hs,left,right=profile(tank,q[3])
            for j in range(N):
                m=q[3+j]
                # Inlet remains finite mixed BAL, not a fabricated ghost tank.
                hf=(tank['rows'][0]['h'] if m>=0 else left[0]) if j==0 else (right[j-1] if m>=0 else left[j])
                connect(1,j,1,j+1,m,12-edges[j],hf)
            for j in range(N-1):
                Q=b['interlayerConductance_W_K']*1.5/(depth[j+1]-depth[j])*(tank['rows'][j+1]['T']-tank['rows'][j+2]['T'])
                re[1][j+1]+=Q;re[1][j+2]-=Q
            return np.concatenate([np.concatenate(rm)/25,np.concatenate(re)/25e6,hydraulic])
        solved=root(residual,x,method='hybr',options=dict(xtol=1e-11))
        rr=residual(solved.x);defect=float(max(abs(rr)));nfev+=solved.nfev;maxdef=max(maxdef,defect)
        if not np.all(np.isfinite(solved.x)) or not np.all(np.isfinite(rr)) or defect>1e-7:
            raise ValueError(f'Stratification solve failed at {t}: {solved.message}; residual {defect}')
        # Residual-based acceptance is deliberate, independent of solver status.
        x=solved.x;old=unpack(x[:physical]*scale);q=x[physical:]*25
        # Check reconstructed face states at actual hydrostatic face pressure;
        # invalid phase/domain is rejected, never clipped or labelled BAD.
        hs,left,right=profile(old[1],q[3])
        for j,r in enumerate(old[1]['rows'][1:]):
            temperature(r['p']-r['rho']*g*heights[j]/2,left[j])
            temperature(r['p']+r['rho']*g*heights[j]/2,right[j])
        em=max(em,abs(totals(old,'M')-M0));ee=max(ee,abs(totals(old,'E')-E0))
        if em>1e-4 or ee>100:raise ValueError('Stratification conservation failure')
        incoming+=dt*q[0];outgoing+=dt*q[1];t+=dt
        if t>=nextout-1e-9:record(q);nextout+=b['output_s']
    # Accepted-state output only: no change to transport, solve or acquisition.
    snapshot=dict(t_s=t,topPressure_Pa=old[1]['ptop'],area_m2=10.,topElevation_m=12.,
        heights_m=heights.tolist(),temperatures_K=[r['T'] for r in old[1]['rows'][1:]],
        midpointMass_kg=float(sum(old[1]['M'][1:])),midpointEnergy_J=float(sum(old[1]['E'][1:])),
        midpointEntropy_J_K=float(sum(r['M']*_Region1(r['T'],r['p']/1e6)['s']*1000 for r in old[1]['rows'][1:])),
        unchangedExternalStores=[dict(name=label,pressure_Pa=old[k]['rows'][j]['p'],temperature_K=old[k]['rows'][j]['T'],
            mass_kg=float(old[k]['M'][j]),energy_J=float(old[k]['E'][j]),multiplicity=count)
            for label,k,j,count in [('finite_primary',0,0,1),('BAL_each_train',1,0,2),('DVI_each_train',2,0,2)]])
    return dict(name=name,topCells=nt,totalCells=N,limited=limited,commonFaceGravity=face_gravity,actualInletReconstruction=actual_inlet,
        wall_s=time.perf_counter()-started,nfev=nfev,maxScaledResidual=maxdef,maxMassResidual_kg=em,maxEnergyResidual_J=ee,trace=trace,finalSnapshot=snapshot)

`
export const stratificationCalculation = cmtStratificationDefinitions + '\n' + cmtObservationCalculation + String.raw`checks=tracer_checks()
nt=b['topCells'];dt=b['maximumStep_s']
cases=[study('donor_center_first_order',nt,dt,False,False),study('common_face_first_order',nt,dt,False),
       study('limited_zero_boundary_slope',nt,dt,True,True,False),study('limited',nt,dt,True),
       study('limited_half_step',nt,dt/2,True),study('limited_double_top',2*nt,dt,True)]
replays=[]
for case in cases:
    adapted=dict(name=case['name'],trace=[dict(t_s=r['t_s'],tanks=[dict(rawLevelDP_Pa=r['rawLevelDP_Pa'],rawSourceDP_Pa=r['rawSourceDP_Pa'])]) for r in case['trace']])
    replays.append(observation(adapted))
def compare(a,c):
    return dict(maxPressureDifference_MPa=max(abs(x['primaryPressure_MPa']-y['primaryPressure_MPa']) for x,y in zip(a['trace'],c['trace'])),
        finalOutletDifference_kg=abs(a['trace'][-1]['grossOutlet_kg']-c['trace'][-1]['grossOutlet_kg']),
        maxProbeEnvelopeDifference_K=max(abs(u-v) for x,y in zip(a['trace'],c['trace']) for px,py in zip(x['probes'],y['probes'])
            for u,v in [(min(px['reconstructedLiquid_C']),min(py['reconstructedLiquid_C'])),(max(px['reconstructedLiquid_C']),max(py['reconstructedLiquid_C']))]))
print(json.dumps(dict(tracerChecks=checks,cases=cases,observationReplays=replays,
    comparisons=dict(gravityConvention=compare(cases[0],cases[1]),reconstruction=compare(cases[1],cases[2]),
        inletBoundary=compare(cases[2],cases[3]),time=compare(cases[3],cases[4]),space=compare(cases[3],cases[5])),precisePressureFrontQualified=False)))
`

if (import.meta.main) {
  const [page, python] = process.argv.slice(2)
  if (!page || !python) throw new Error('Usage: reference-design-cmt-stratification.ts <wiki-page> <python>')
  const input = parseStratificationBasis(await Bun.file(page).text())
  const child = Bun.spawn([python, '-c', stratificationCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exit !== 0) throw new Error(stderr)
  console.log(JSON.stringify({ input, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    calculationHash: createHash('sha256').update(stratificationCalculation).digest('hex'), ...JSON.parse(stdout) }, null, 2))
}
