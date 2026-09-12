/** Offline native regional/line hydrostatics shared by the retained support apparatus and joined initialization. */
export const regionalHydrostaticsPython = String.raw`checks=[];calls=dict(property=0,residual=0,nonlinear=0);half=r['developedLength_m']/2
propertyEntropyError_J_kgK=0.;refinedEntropyError_J_kgK=0.
calls.update(entropyRefinements=0,explicitForwardPropertyCalls=0)
def w(p,**pair):
    global propertyEntropyError_J_kgK,refinedEntropyError_J_kgK
    calls['property']+=1
    if not 14<p<16:raise ValueError('Outside near-nominal phase/pressure investigation')
    q=W(P=p,**pair)
    if 's' in pair:
        target=pair['s']*1000;error=q.s*1000-target
        propertyEntropyError_J_kgK=max(propertyEntropyError_J_kgK,abs(error))
        if abs(error)>1e-9:
            calls['entropyRefinements']+=1
            f=W(P=p,x=0);v=W(P=p,x=1);calls['explicitForwardPropertyCalls']+=2
            if f.s*1000<=target<=v.s*1000:
                quality=(target-f.s*1000)/(1000*(v.s-f.s))
                water.update(CP.PQ_INPUTS,p*1e6,quality);calls['explicitForwardPropertyCalls']+=1
            else:
                isLiquid=target<f.s*1000;quality=0. if isLiquid else 1.;T=q.T
                water.specify_phase(CP.iphase_liquid if isLiquid else CP.iphase_gas)
                try:
                    for _ in range(8):
                        water.update(CP.PT_INPUTS,p*1e6,T);calls['explicitForwardPropertyCalls']+=1
                        defect=water.smass()-target
                        if abs(defect)<=1e-9:break
                        T-=defect*T/water.cpmass()
                    if (isLiquid and T>f.T) or (not isLiquid and T<v.T):raise ValueError('Entropy inverse crossed its stable phase boundary')
                finally:water.unspecify_phase()
            q=SimpleNamespace(P=water.p()/1e6,T=water.T(),rho=water.rhomass(),v=1/water.rhomass(),
                u=water.umass()/1000,s=water.smass()/1000,x=quality)
        corrected=abs(q.s*1000-target);refinedEntropyError_J_kgK=max(refinedEntropyError_J_kgK,corrected)
        if corrected>1e-9:raise ValueError('Forward entropy inversion residual failed')
    if not math.isfinite(q.x) or not 0<=q.x<=1:raise ValueError('Native quality outside physical phase partition')
    return q
def h(q):return q.u*1000+q.P*1e6*q.v
referenceNodes={n:np.polynomial.legendre.leggauss(n) for n in [8,16,32]}
def nodes(lo,hi,n):
    x,weights=referenceNodes[n]
    return lo+(x+1)*(hi-lo)/2,weights*(hi-lo)/2
breaks=sorted(set([0.,half,*np.cumsum(r['lengths_m']).tolist()]))
def line_mesh(n):
    rows=[]
    for lo,hi in zip(breaks[:-1],breaks[1:]):
        xs,weights=nodes(lo,hi,n)
        rows.extend((float(x),route_elevation(r,float(x)),float(weight),0 if x<half else 1) for x,weight in zip(xs,weights))
    return rows
meshes={n:line_mesh(n) for n in [8,16,32]}
bendCenters=[r['lengths_m'][0]+r['lengths_m'][1]/2,r['risingStart_m']+r['lengths_m'][3]/2]
bends=[sum(1 for x in bendCenters if (x<half)==(j==0)) for j in [0,1]]

def liquid(p,s=None,T=None):
    q=w(p,s=s) if s is not None else w(p,T=T)
    if q.x!=0:raise ValueError('HOT/line or bottom withdrawal has left this liquid-port regime')
    # Read from the same state just recovered; no second rounded-state cache.
    mu=water.viscosity();return dict(Mrho=q.rho,h=h(q),u=q.u*1000,s=q.s,T=q.T,mu=mu,p=q.P)

def line(p,s,n=8):
    base=liquid(p,s=s);samples={zH:base};maxHydro=0.
    def at(z):
        nonlocal maxHydro
        if z in samples:return samples[z]
        target=base['h']-g*(z-zH);pp=p-base['Mrho']*g*(z-zH)/1e6
        for _ in range(8):
            q=liquid(pp,s=s);defect=q['h']-target
            if abs(defect)<1e-7:break
            pp-=defect*q['Mrho']/1e6
        q=liquid(pp,s=s);error=abs(q['h']-target)*q['Mrho'];maxHydro=max(maxHydro,error)
        if error>.001:raise ValueError('Physical line hydrostatic enthalpy reconstruction failed')
        samples[z]=q;return q
    M=U=PE=0.;local=[]
    for x,z,weight,j in meshes[n]:
        q=at(z);dm=Ap*weight*q['Mrho'];M+=dm;U+=dm*q['u'];PE+=dm*g*z
        local.append((weight,j,q))
    return dict(M=M,E=U+PE,U=U,PE=PE,inlet=base,outlet=at(zP),local=local,hydroError_Pa=maxHydro)

def region(p,s,M,up,n=8,datum=0.):
    if M<=0:raise ValueError('Spatial owner exhausted; no phase/topology fallback')
    def pressure(m):return p-g*m/A/1e6 if up else p+g*(M-m)/A/1e6
    p0,p1=pressure(0),pressure(M);cuts=[0.,M]
    # Integrate the actual phase boundary rather than smearing it over quadrature nodes.
    for x in [0,1]:
        def boundary(pp):return w(pp,x=x).s-s
        a,b=boundary(p0),boundary(p1)
        if a*b<0:
            ps=brentq(boundary,min(p0,p1),max(p0,p1),xtol=1e-12)
            m=(p-ps)*1e6*A/g if up else M-(ps-p)*1e6*A/g
            cuts.append(m)
    volume=U=moment=gasMass=gasVolume=liquidMass=0.;Tmin=math.inf;Tmax=-math.inf
    for lo,hi in zip(sorted(cuts)[:-1],sorted(cuts)[1:]):
        ms,weights=nodes(lo,hi,n)
        for m,weight in zip(ms,weights):
            q=w(pressure(m),s=s);volume+=weight*q.v;U+=weight*q.u*1000;moment+=weight*(M-m)*q.v
            gasMass+=weight*q.x;liquidMass+=weight*(1-q.x)
            if q.x==1:gasVolume+=weight*q.v
            elif q.x>0:gasVolume+=weight*q.x*w(q.P,x=1).v
            Tmin=min(Tmin,q.T);Tmax=max(Tmax,q.T)
    PE=g*datum*M+g/A*moment
    return dict(M=M,E=U+PE,U=U,PE=PE,V=volume,gasMass=gasMass,gasVolume=gasVolume,
        liquidMass=liquidMass,Tmin=Tmin,Tmax=Tmax,pBottom=p0,pTop=p1)
`
