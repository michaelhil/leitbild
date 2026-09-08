/** Offline film material/energy reference. Imposed pressure, no installed PZR runtime. */
import { createHash } from 'node:crypto'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'
import { filmDefinitions, parseFilmBasis } from './reference-design-pressurizer-film'

export const energyDefinitions = String.raw`
hf=CP.PropsSI('H','P',p,'Q',0,'Water');hg=hf+hfg
def means(surface):
    return hf-cp*(Ts-surface)/2,hf-3*cp*(Ts-surface)/8
def energy_cell(old,oldh,incoming,incomingh,surface,dx,dt,transport=B):
    hm,ho=means(surface)
    def terms(d):
        M=rho*dx*d;M0=rho*dx*old;out=dt*transport*d**3;inc=dt*incoming
        source=M-M0+out-inc
        # Local height datum is the strip midpoint. All quantities are per circumference.
        receipt=source*hg+inc*(incomingh+g*dx/2)-out*(ho-g*dx/2)
        storage=M*hm-M0*oldh
        return source,receipt-storage,out,M,M0
    def residual(d):
        source,thermal,*_=terms(d)
        return thermal*(d+old)-2*dt*dx*k*(Ts-surface)
    upper=max(old,1e-9)
    while residual(upper)<0:upper*=2
    d=brentq(residual,0,upper,xtol=1e-16)
    source,thermal,out,M,M0=terms(d)
    heat=2*dt*dx*k*(Ts-surface)/(d+old) if d+old else 0.
    # Independent U-based local reconstruction: p*dV is explicit boundary work.
    internal=M*(hm-p/rho)-M0*(oldh-p/rho)
    work=p*(M-M0)/rho
    residualU=source*hg+dt*incoming*(incomingh+g*dx/2)-out*(ho-g*dx/2)-heat-internal-work
    return d,source,heat,hm,ho,residualU

def energy_run(n,nr,dt):
    dx=H/n;solve,masses,areas,centers=make_wall(nr,dx)
    wall=np.full((n,nr),Tw0,dtype=float);film=np.zeros(n);hmean=np.full(n,means(Tw0)[0])
    drain=condensed=heat=sourceEnergy=drainEnergy=drainKinetic=0.;rows=[];localU=localSteel=localMatch=0.
    steps=math.ceil(cfg['duration_s']/dt);dt=cfg['duration_s']/steps
    peakRe=kineticBound=0.;maxGlobal=0.;z=r['height_m']-(np.arange(n)+.5)*dx
    for count in range(steps):
        oldwall=wall.copy();oldfilm=film.copy();oldh=hmean.copy();incoming=0.;incomingh=hf;surfaces=[]
        for i in range(n):
            def interface(surface):
                d,source,qf,hm,ho,ru=energy_cell(oldfilm[i],oldh[i],incoming,incomingh,surface,dx,dt)
                T,q,res=solve(oldwall[i],surface,dt)
                return q[0]*dt-qf*C,(d,source,qf,hm,ho,ru,T,res)
            surface=brentq(lambda T:interface(T)[0],float(min(oldwall[i])),Ts,xtol=1e-10)
            mismatch,(d,source,qf,hm,ho,ru,T,res)=interface(surface)
            if abs(mismatch)>1e-5:raise ValueError('Energy-film actual-surface heat matching failed')
            if source<-1e-12:raise ValueError('Accepted condensing-film state entered evaporation')
            if abs(ru*C)>1e-6:raise ValueError(dict(reason='Accepted local film U/work/PE balance failed',residual_J=ru*C,time_s=(count+1)*dt,strip=i))
            film[i]=d;wall[i]=T;hmean[i]=hm;incoming=B*d**3;incomingh=ho;surfaces.append(surface)
            condensed+=source*C;heat+=qf*C;sourceEnergy+=source*C*(hg+g*z[i])
            localU=max(localU,abs(ru*C));localSteel=max(localSteel,res);localMatch=max(localMatch,abs(mismatch))
        dm=dt*C*incoming;drain+=dm;drainEnergy+=dm*(incomingh+g*r['statedLevel_m'])
        drainKinetic+=dm*27/35*(B*film[-1]**2/rho)**2
        M=rho*dx*C*film;storedFilm=float(sum(M*(hmean-p/rho+g*z)))
        storedWall=float(np.sum(steel_de(wall,Tw0)*masses));work=p*float(sum(M))/rho
        er=storedFilm+storedWall+drainEnergy+work-sourceEnergy;mr=float(sum(M))+drain-condensed
        maxGlobal=max(maxGlobal,abs(er));re=4*B*float(max(film))**3/mu;peakRe=max(peakRe,re)
        # Parabolic velocity: mean(u^2)=6/5 mean(u)^2; omitted low-inertia KE is reported, not stored.
        vmean=B*film**2/rho;ke=float(sum(.6*M*vmean**2));kineticBound=max(kineticBound,ke)
        if abs(er)>.01 or abs(mr)>1e-9 or re>=30:raise ValueError('Film energy/mass/smooth-domain gate failed')
        t=(count+1)*dt
        if count==0 or abs(t-round(t))<1e-8:
            rows.append(dict(time_s=t,filmMass_kg=float(sum(M)),drainedMass_kg=drain,condensedMass_kg=condensed,heat_J=heat,
                filmInternalAndPotential_J=storedFilm,sourceEnthalpyAndPotential_J=sourceEnergy,drainEnthalpyAndPotential_J=drainEnergy,
                compressionWorkOnSteam_J=work,steelEnergy_J=storedWall,totalEnergyResidual_J=er,massResidual_kg=mr,
                innerSurfaceMin_K=min(surfaces),innerSurfaceMax_K=max(surfaces),maxRe=re,
                omittedFilmKinetic_J=ke,omittedDrainedKinetic_J=drainKinetic,maxCrossFilmDiffusionTime_s=float(max(film**2)*rho*cp/k)))
    return dict(axialCells=n,radialCells=nr,step_s=dt,rows=rows,peakRe=peakRe,maxLocalFilmEnergyResidual_J=localU,
        maxLocalSteelResidual_J=localSteel,maxInterfaceMismatch_J=localMatch,maxGlobalEnergyResidual_J=maxGlobal,
        maximumOmittedKinetic_J=kineticBound,omittedDrainedKinetic_J=drainKinetic)

def dry_energy_checks():
    # Independent fixed-T, no-drain startup includes the retained film's mean sensible deficit.
    result=[]
    for step in [cfg['timeStep_s'],cfg['timeStep_s']/2,cfg['timeStep_s']/4]:
        hm,_=means(Tw0);effective=hg-hm
        exact=math.sqrt(2*step*k*(Ts-Tw0)/(rho*effective))
        solved,source,heat,hm,ho,ru=energy_cell(0.,hm,0.,hf,Tw0,H/cfg['axialCells'],step,transport=0.)
        if abs(solved/exact-1)>1e-10:raise ValueError('Energy-aware dry limit failed')
        if abs(ru*C)>1e-6:raise ValueError('Actual no-drain film energy balance failed')
        result.append(dict(step_s=step,exactThickness_m=exact,solvedThickness_m=solved,effectiveCondensationEnthalpy_J_kg=effective))
    # Derive the two profile means independently by quadrature of linear T and parabolic velocity.
    from scipy.integrate import quad
    massMean=quad(lambda x:x,0,1)[0]
    flowMean=quad(lambda x:x*(2*x-x*x),0,1)[0]/quad(lambda x:2*x-x*x,0,1)[0]
    if abs(massMean-.5)>1e-12 or abs(flowMean-.625)>1e-12:raise ValueError('Film profile moment check failed')
    return dict(dry=result,massProfileMean=massMean,flowProfileMean=flowMean)
`

const verification = String.raw`
checks=dry_energy_checks();wallChecks=wall_checks();n=cfg['axialCells'];nr=cfg['radialCells'];dt=cfg['timeStep_s']
cases=[energy_run(n,nr,dt),energy_run(n,2*nr,dt),energy_run(2*n,nr,dt),energy_run(n,nr,dt/2),energy_run(2*n,2*nr,dt/2)]
comparisons=[]
for label,a in zip(['radial','axial','time','combined'],cases[1:]):
    for t in [1.,5.,10.,cfg['duration_s']]:
        x=next(v for v in cases[0]['rows'] if abs(v['time_s']-t)<1e-8);y=next(v for v in a['rows'] if abs(v['time_s']-t)<1e-8)
        ds={key:abs(x[key]-y[key])/max(abs(y[key]),1e-12) for key in ['filmMass_kg','drainedMass_kg','heat_J']}
        ts={key:abs(x[key]-y[key]) for key in ['innerSurfaceMin_K','innerSurfaceMax_K']}
        comparisons.append(dict(axis=label,time_s=t,relativeDifferences=ds,temperatureDifferences_K=ts,passes=max(ds.values())<=.02 and max(ts.values())<=.02))
print(json.dumps(dict(scope='Fixed-pressure finite film internal/PE energy and radial wall; low-inertia prescribed profile, not a sealed PZR',
    dependencies=dict(python=platform.python_version(),CoolProp=CoolProp.__version__,CoolPropRevision=CP.get_global_param_string('gitrevision'),scipy=scipy.__version__,numpy=np.__version__),
    properties=dict(pressure_Pa=p,liquidEnthalpy_J_kg=hf,vaporEnthalpy_J_kg=hg,filmDensity_kg_m3=rho,filmHeatCapacity_J_kgK=cp),
    independentChecks=checks,wallChecks=wallChecks,cases=cases,comparisons=comparisons,
    numericalScreenPassed=all(x['passes'] for x in comparisons),liveModelInstalled=False),allow_nan=False))
`
export const filmEnergyCalculation = filmDefinitions + energyDefinitions + verification

if (import.meta.main) {
  const [source, owner, python, ...extra] = process.argv.slice(2)
  if (!source || !owner || !python || extra.length) throw Error('Usage: pressurizer-film-energy.ts source.md owner.md python')
  const page = await Bun.file(owner).text()
  const input = { source: parsePressurizerBoundaries(await Bun.file(source).text()), pressure_MPa: parseSpatialBasis(page).surfacePressure_MPa, film: parseFilmBasis(page) }
  const child = Bun.spawn([python, '-c', filmEnergyCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(filmEnergyCalculation), ...JSON.parse(out) }, null, 2))
}
