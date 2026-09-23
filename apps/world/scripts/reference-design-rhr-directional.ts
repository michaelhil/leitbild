/** Offline finite directional intersection decision; no installed network or runtime model. */
import { createHash } from 'node:crypto'

const calculation = String.raw`
import json,sys,math,scipy,CoolProp
import numpy as np
import CoolProp.CoolProp as C
from scipy.integrate import quad
from scipy.optimize import brentq

def ph(p,h):
    return dict(p=p,h=h,rho=C.PropsSI('D','P',p,'H',h,'Water'),T=C.PropsSI('T','P',p,'H',h,'Water'),s=C.PropsSI('S','P',p,'H',h,'Water'),q=C.PropsSI('Q','P',p,'H',h,'Water'))
def pt(p,T,velocity,tracer=0):
    return dict(**ph(p,C.PropsSI('H','P',p,'T',T,'Water')),velocity=np.array(velocity,dtype=float),tracer=tracer)
def ps(p,s):return ph(p,C.PropsSI('H','P',p,'S',s,'Water'))
def acoustic(p,s):
    q=C.PropsSI('Q','P',p,'S',s,'Water')
    if not 0<=q<=1:return C.PropsSI('A','P',p,'S',s,'Water')
    dp=p*1e-5
    def v(x):return 1/C.PropsSI('D','P',x,'S',s,'Water')
    minus=C.PropsSI('Q','P',p-dp,'S',s,'Water');plus=C.PropsSI('Q','P',p+dp,'S',s,'Water')
    if 0<=minus<=1 and 0<=plus<=1:derivative=(v(p+dp)-v(p-dp))/(2*dp)
    elif 0<=minus<=1:derivative=(v(p)-v(p-dp))/dp
    elif 0<=plus<=1:derivative=(v(p+dp)-v(p))/dp
    else:raise ValueError('No same-phase acoustic derivative side')
    c2=-v(p)**2/derivative
    if c2<=0:raise ValueError('Nonpositive native wet acoustic derivative')
    return math.sqrt(c2)
def saturation_events(s,lo,hi):
    events=[]
    for quality in [0,1]:
        f=lambda p:C.PropsSI('S','P',p,'Q',quality,'Water')-s
        if f(lo)*f(hi)<0:events.append(brentq(f,lo,hi))
    return events
def wave(i,p,normal_velocity):
    pi=i['p'];v0=1/i['rho']
    if abs(p-pi)<=4*max(math.ulp(p),math.ulp(pi)):
        return dict(**i,F=0,kind='zero',c=acoustic(pi,i['s']))
    if p<pi:
        points=saturation_events(i['s'],p,pi)
        F=-quad(lambda x:1/(C.PropsSI('D','P',x,'S',i['s'],'Water')*acoustic(x,i['s'])),p,pi,points=points,epsabs=1e-7,epsrel=1e-8)[0]
        return dict(**ps(p,i['s']),F=F,kind='rarefaction',c=acoustic(p,i['s']),phaseEvents_Pa=points)
    dp=p-pi
    f=lambda h:h-i['h']-.5*dp*(v0+1/ph(p,h)['rho'])
    h=brentq(f,i['h'],i['h']+2*dp*v0+1,xtol=1e-7)
    d=ph(p,h);dv=v0-1/d['rho']
    if dv<=0:raise ValueError('Noncompressive Hugoniot')
    if d['s']<i['s']-1e-7:raise ValueError('Shock entropy decrease')
    return dict(**d,F=math.sqrt(dp*dv),kind='shock',c=acoustic(p,d['s']),shockRelativeSpeed=math.sqrt(dp/dv)/i['rho'])
def face(left,right,normal):
    n=np.array(normal);ul=float(left['velocity']@n);ur=float(right['velocity']@n)
    if left['p']==right['p'] and ul==ur:p=left['p']
    else:
        def f(p):return wave(left,p,ul)['F']+wave(right,p,ur)['F']+ur-ul
        p=brentq(f,1e6,20e6,xtol=.00001)
    L=wave(left,p,ul);R=wave(right,p,ur)
    u=.5*(ul+ur+R['F']-L['F'])
    # The comparison uses only the star region between outward waves.
    left_speed=ul-L['shockRelativeSpeed'] if L['kind']=='shock' else u-L['c']
    right_speed=ur+R['shockRelativeSpeed'] if R['kind']=='shock' else u+R['c']
    if left_speed>=0 or right_speed<=0:raise ValueError('Star state is not at stationary face')
    if ul-acoustic(left['p'],left['s'])>=0 or ur+acoustic(right['p'],right['s'])<=0:raise ValueError('Interior characteristic not outward')
    fan_checks=[]
    for i,w,ui,side in [(left,L,ul,-1),(right,R,ur,1)]:
        if not w.get('phaseEvents_Pa'):continue
        points=list(np.geomspace(i['p'],p,18))
        for event in w['phaseEvents_Pa']:points.extend([event*(1+1e-6),event*(1-1e-6)])
        points=sorted([x for x in points if p<=x<=i['p']],reverse=True)
        values=[]
        for x in points:
            k=wave(i,x,ui);velocity=ui+side*k['F']
            values.append(dict(p_Pa=x,lambda_m_s=velocity+side*k['c']))
        ordered=min(-side*(b['lambda_m_s']-a['lambda_m_s']) for a,b in zip(values,values[1:]))
        if ordered < -1e-4:raise ValueError('Nonordered phase-crossing rarefaction: '+str(ordered))
        fan_checks.append(dict(side=side,minimumOrderedIncrement_m_s=ordered,samples=values))
    d=L if u>=0 else R;donor=left if u>=0 else right
    tangent=donor['velocity']-float(donor['velocity']@n)*n
    vel=u*n+tangent;mass=d['rho']*u
    H=d['h']+.5*float(vel@vel)
    return dict(p=p,u=u,material=d,velocity=vel,mass=mass,momentum=mass*vel+p*n,energy=mass*H,tracer=mass*donor['tracer'],entropy=mass*d['s'],leftWave=L['kind'],rightWave=R['kind'],leftSpeed=left_speed,rightSpeed=right_speed,phaseEvents=L.get('phaseEvents_Pa',[])+R.get('phaseEvents_Pa',[]),phaseFanChecks=fan_checks)
def extensive(i,V):
    M=i['rho']*V;v=i['velocity']
    return dict(M=M,P=M*v,E=M*(i['h']-i['p']/i['rho']+.5*float(v@v)),B=M*i['tracer'],V=V)
def rate():return dict(M=0.,P=np.zeros(2),E=0.,B=0.)
def add(r,f,A,sign=1,project=None):
    r['M']+=sign*A*f['mass'];r['E']+=sign*A*f['energy'];r['B']+=sign*A*f['tracer']
    momentum=f['momentum'] if project is None else float(f['momentum']@project)*project
    r['P']+=sign*A*momentum
def entropy_rate(i,r):
    v=i['velocity']
    return (r['E']-float(v@r['P'])+(.5*float(v@v)-i['h'])*r['M'])/i['T']+i['s']*r['M']
def recover(U):
    rho=U['M']/U['V'];v=U['P']/U['M'];e=U['E']/U['M']-.5*float(v@v)
    T=C.PropsSI('T','D',rho,'U',e,'Water')
    p=C.PropsSI('P','D',rho,'T',T,'Water');h=e+p/rho
    return dict(p=p,h=h,rho=rho,T=T,s=C.PropsSI('S','D',rho,'T',T,'Water'),velocity=v,tracer=U['B']/U['M'])
def primitive_flux(i,n):
    u=float(i['velocity']@n);m=i['rho']*u
    return dict(mass=m,momentum=m*i['velocity']+i['p']*n,energy=m*(i['h']+.5*float(i['velocity']@i['velocity'])),tracer=m*i['tracer'],entropy=m*i['s'])
def clean(x):
    if isinstance(x,np.ndarray):return x.tolist()
    if isinstance(x,dict):return {k:clean(v) for k,v in x.items()}
    if isinstance(x,list):return [clean(v) for v in x]
    if isinstance(x,np.floating):return float(x)
    return x

A=math.pi/4;side=.1;length=1.;width=math.sqrt(A);V=A*length
normals=[np.array([-1.,0.]),np.array([1.,0.]),np.array([0.,1.])]
areas=[A,A,side]
wall_patches=[(np.array([0.,1.]),width*length-side),(np.array([0.,-1.]),width*length)]
# The two omitted +/-z wall faces are equal, Uz=0 and exactly cancel.
def fixture(name,main_velocity=10,side_velocity=0,side_temperature=563.15,side_pressure=15.2e6):
    node=pt(15.2e6,563.15,[main_velocity,0],.001)
    neighbors=[pt(15.2e6,563.15,[main_velocity,0],.001),pt(15.2e6,563.15,[main_velocity,0],.002),pt(side_pressure,side_temperature,[0,side_velocity],.004)]
    states=[node]+neighbors;volumes=[V,A,A,.05]
    rates=[rate() for _ in states];outer=rate();outerS=0.;wall_reaction=np.zeros(2);projection_reaction=np.zeros(2);traces=[]
    for j,(n,a,neighbor) in enumerate(zip(normals,areas,neighbors)):
        f=face(node,neighbor,n);traces.append(f)
        add(rates[0],f,a,-1);add(rates[j+1],f,a,1,project=n)
        projection_reaction+=a*(f['momentum']-float(f['momentum']@n)*n)
        out=primitive_flux(neighbor,n);add(rates[j+1],out,a,-1);add(outer,out,a,1);outerS+=a*out['entropy']
    for n,a in wall_patches:
        reflected=dict(node,velocity=node['velocity']-2*float(node['velocity']@n)*n)
        f=face(node,reflected,n)
        if abs(f['mass'])>1e-8 or abs(f['energy'])>1e-5:raise ValueError('Reflecting wall transfers material/energy')
        add(rates[0],f,a,-1);wall_reaction+=a*f['momentum']
    total={key:sum(r[key] for r in rates)+outer[key] for key in ['M','E','B']}
    total['P']=sum((r['P'] for r in rates),np.zeros(2))+outer['P']+wall_reaction+projection_reaction
    Sdot=sum(entropy_rate(i,r) for i,r in zip(states,rates));production=Sdot+outerS
    U=[extensive(i,v) for i,v in zip(states,volumes)]
    # Compare the same native extensive-state recovery before and after. A second
    # PH inverse at the reconstructed pressure has its own resolution error and
    # is not a physical entropy increment, including when the state is unchanged.
    initial_recovered=[recover(x) for x in U]
    increments=[]
    for dt in [1e-7,5e-8]:
        updated=[dict(V=x['V'],**{key:x[key]+dt*r[key] for key in ['M','P','E','B']}) for x,r in zip(U,rates)]
        recovered=[recover(x) for x in updated]
        # Differences per owner avoid subtracting one huge aggregate entropy.
        deltaS=sum(y['M']*(j['s']-i['s'])+(y['M']-x['M'])*i['s'] for x,y,i,j in zip(U,updated,initial_recovered,recovered))
        increments.append(dict(dt_s=dt,entropyProduction_W_K=deltaS/dt+outerS,node=recovered[0],side=recovered[3]))
    admitted=all(abs(total[k])<b for k,b in [('M',1e-7),('E',1e-4),('B',1e-9)]) and np.linalg.norm(total['P'])<1e-6 and production>=-1e-4
    if production>1:
        admitted=admitted and all(abs(x['entropyProduction_W_K']/production-1)<.01 for x in increments)
    else:
        admitted=admitted and all(abs(x['entropyProduction_W_K']-production)<.1 for x in increments)
    transverse_power=sum(a*f['mass']*.5*float((f['velocity']-f['u']*n)@(f['velocity']-f['u']*n)) for a,n,f in zip(areas,normals,traces) if f['mass']>0)
    return clean(dict(name=name,inputs=states,nodeVolume_m3=V,volumes_m3=volumes,faces=traces,rates=rates,externalBoundaryRates=outer,externalEntropyOut_W_K=outerS,wallReaction_N=wall_reaction,projectionReaction_N=projection_reaction,transverseKineticTransportTo1D_W=transverse_power,additionalProjectionHeat_W=0,totalResiduals=total,entropyDerivative_W_K=Sdot,entropyProduction_W_K=production,nativeInitialEntropyOffset_J_kgK=[j['s']-i['s'] for i,j in zip(states,initial_recovered)],finiteIncrements=increments,admitted=admitted))

rows=[]
for name,params in [
 ('throughflow static side tap',{}),
 ('previous strong withdrawal',dict(side_velocity=40)),
 ('cold combining return',dict(side_velocity=-1,side_temperature=393.15)),
 ('reversed main throughflow',dict(main_velocity=-10)),
 ('resting unequal temperature',dict(main_velocity=0,side_temperature=393.15)),
]:
    try:rows.append(fixture(name,**params))
    except Exception as error:rows.append(dict(name=name,admitted=False,error=str(error)))
# Finite, property-resolvable transverse motion tests the actual wall law.
# The earlier optional infinitesimal postincrement shock check remains a
# rejected numerical diagnostic, not a physical failure or accepted trajectory.
wall_state=pt(15.2e6,563.15,[10,1]);wall_force=np.zeros(2);wall_rows=[]
for n,a in wall_patches:
    mirror=dict(wall_state,velocity=wall_state['velocity']-2*float(wall_state['velocity']@n)*n)
    f=face(wall_state,mirror,n)
    wall_force-=a*(f['p']-wall_state['p'])*n
    wall_rows.append(dict(normal=n,area_m2=a,pressure_Pa=f['p'],massFlux_kg_m2_s=f['mass'],energyFlux_W_m2=f['energy']))
wall_power=float(wall_force@wall_state['velocity'])
if wall_power>=0 or any(abs(r['massFlux_kg_m2_s'])>1e-8 or abs(r['energyFlux_W_m2'])>1e-5 for r in wall_rows):raise ValueError('Failed finite reflecting-wall check')
print(json.dumps(dict(scope='Native pure-water finite directional local rates and explicit increments; no installed valves/network/trajectory. Exterior faces retain their current primitive outflow for this instantaneous diagnostic.',geometry=dict(volume_m3=V,mainArea_m2=A,equivalentWidth_m=width,length_m=length,sideArea_m2=side,closedSurfaceAreaVector=sum((a*n for a,n in zip(areas,normals)),np.zeros(2))+sum((a*n for n,a in wall_patches),np.zeros(2))),cases=rows,finiteWallCheck=dict(input=wall_state,faces=wall_rows,pressureCorrectionForce_N=wall_force,resolvedKineticRate_W=wall_power,externalWallWork_W=0,admitted=True),retainedDiagnostics=['rhr-directional-initial.json: PH-to-DU-to-PH baseline entropy offset is not a physical increment','rhr-directional-weak-wall-diagnostic.json: optional infinitesimal postincrement shock entropy comparison hits property-coordinate resolution; not qualified'],versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__,python=sys.version)),default=clean,sort_keys=True))
`

if (import.meta.main) {
  const [python, output] = process.argv.slice(2)
  if (!python || !output) throw new Error('Usage: <research-python> <output.json>')
  const source = await Bun.file(import.meta.path).text()
  const child = Bun.spawn([python, '-c', calculation], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(stderr)
  if (await Bun.file(import.meta.path).text() !== source) throw new Error('Source changed during calculation')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const result = { sourceSha256: hash(source), calculationSha256: hash(calculation), ...JSON.parse(stdout) }
  await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ output, cases: result.cases.map((c: { name: string; admitted: boolean; error?: string }) => ({ name: c.name, admitted: c.admitted, error: c.error })) }))
}
