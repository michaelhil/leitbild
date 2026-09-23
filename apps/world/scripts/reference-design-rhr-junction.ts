/** Bounded pure-water ideal intersection candidate; no runtime or network trajectory. */
import { createHash } from 'node:crypto'

const calculation = String.raw`
import json,sys,math,scipy,CoolProp
import CoolProp.CoolProp as C
import numpy as np
from scipy.integrate import quad
from scipy.optimize import brentq,least_squares

# Independent small implementation of the selected native wave equations.
# No source slicing/import of another executable's private Python string.
def ph(p,h):
    return dict(p=p,h=h,rho=C.PropsSI('D','P',p,'H',h,'Water'),s=C.PropsSI('S','P',p,'H',h,'Water'),T=C.PropsSI('T','P',p,'H',h,'Water'),quality=C.PropsSI('Q','P',p,'H',h,'Water'))
def sound(p,s):
    q=C.PropsSI('Q','P',p,'S',s,'Water')
    if 0<=q<=1:raise ValueError('Saturation-crossing outgoing wave outside candidate')
    return C.PropsSI('A','P',p,'S',s,'Water')
def pt(p,T,u,area,normal,tracer=0):
    d=ph(p,C.PropsSI('H','P',p,'T',T,'Water'))
    return dict(**d,u=u,area=area,normal=normal,tracer=tracer,c=sound(p,d['s']))
def wave(i,p):
    p0=i['p'];h0=i['h'];v0=1/i['rho']
    if abs(p-p0)<=4*max(math.ulp(p),math.ulp(p0)):
        return dict(**i,kind='zero',speed=i['u']+i['c'],headSpeed=i['u']+i['c'])
    if p<p0:
        d=ph(p,C.PropsSI('H','P',p,'S',i['s'],'Water'))
        F=quad(lambda x:1/(C.PropsSI('D','P',x,'S',i['s'],'Water')*sound(x,i['s'])),p0,p,epsabs=1e-9,epsrel=1e-9)[0]
        d.update(u=i['u']+F,kind='rarefaction',headSpeed=i['u']+i['c'])
        d['speed']=d['u']+sound(p,d['s'])
    else:
        dp=p-p0
        def residual(h):return h-h0-.5*dp*(v0+1/ph(p,h)['rho'])
        h=brentq(residual,h0,h0+2*dp*v0+1,xtol=1e-7);d=ph(p,h)
        dv=v0-1/d['rho']
        if dv<=0:raise ValueError('Nonpositive compression density change')
        d.update(u=i['u']+math.sqrt(dp*dv),kind='shock',speed=i['u']+math.sqrt(dp/dv)/i['rho'])
        d['headSpeed']=d['speed'];d['hugoniotResidual']=residual(h)
    sound(p,d['s'])
    return d
def evaluate(ports,x):
    p=x[0]*1e6;H=x[1]*1e6;traces=[]
    for i in ports:
        w=wave(i,p);u=w['u']
        d=w if u<=0 else ph(p,H-.5*u*u)
        q=i['area']*d['rho']*u
        traces.append(dict(wave=w,material=d,u=u,q=q,H=d['h']+.5*u*u))
    return traces
def solve(name,ports):
    p0=sum(i['p'] for i in ports)/len(ports)
    incoming=[i for i in ports if i['u']<0]
    H0=sum(-i['area']*i['rho']*i['u']*(i['h']+.5*i['u']**2) for i in incoming)/sum(-i['area']*i['rho']*i['u'] for i in incoming)
    def decode(y):return np.array([(p0+1e4*y[0])/1e6,(H0+1e4*y[1])/1e6])
    def residual(y):
        x=decode(y);ts=evaluate(ports,x)
        return np.array([sum(t['q'] for t in ts)/1000,sum(t['q']*(t['H']-x[1]*1e6) for t in ts)/1e8])
    def jacobian(y):
        # Fixed resolvable 10 Pa / 10 J/kg central probes, not baseline-relative
        # probes whose EOS recovery noise can terminate a near-zero correction.
        delta=1e-3
        return np.column_stack([(residual(y+delta*np.eye(2)[j])-residual(y-delta*np.eye(2)[j]))/(2*delta) for j in range(2)])
    y0=np.zeros(2)
    if max(abs(v) for v in residual(y0))<1e-12:x=decode(y0);n=1
    else:
        sol=least_squares(residual,y0,jac=jacobian,bounds=([(10e6-p0)/1e4,(.1e6-H0)/1e4],[(19e6-p0)/1e4,(2e6-H0)/1e4]),xtol=1e-12,ftol=1e-12,gtol=1e-12,max_nfev=40)
        if not sol.success:raise ValueError(sol.message)
        x=decode(sol.x);n=sol.nfev
    ts=evaluate(ports,x);mass=sum(t['q'] for t in ts)
    # Independently sum unshifted energy as well as the well-scaled solve residual.
    energy=sum(t['q']*t['H'] for t in ts)
    entropy=sum(t['q']*t['material']['s'] for t in ts)
    gross=-sum(t['q'] for t in ts if t['q']<0)
    if gross<=0:raise ValueError('No incoming material in nonzero test')
    B=sum(-t['q']*i['tracer'] for t,i in zip(ts,ports) if t['q']<0)/gross
    tracer=sum(t['q']*(i['tracer'] if t['q']<0 else B) for t,i in zip(ts,ports))
    reaction=[sum((i['area']*x[0]*1e6+t['q']*t['u'])*i['normal'][axis] for t,i in zip(ts,ports)) for axis in [0,1]]
    violations=[]
    if abs(mass)>1e-6:violations.append('mass residual')
    if abs(energy)>1:violations.append('energy residual')
    if abs(tracer)>1e-9:violations.append('tracer residual')
    if entropy < -1e-4:violations.append('negative junction entropy production')
    for i,t in zip(ports,ts):
        w=t['wave'];d=t['material']
        if min(w['speed'],w['headSpeed'])<=0:violations.append('wave not outgoing')
        if w['s']<i['s']-1e-7:violations.append('wave entropy decrease')
        if 0<=d['quality']<=1:violations.append('wet incoming state outside this bounded junction check')
        elif abs(t['u'])>=sound(d['p'],d['s']):violations.append('supersonic trace')
    return dict(name=name,inputs=ports,pressure_Pa=x[0]*1e6,mixedH_J_kg=x[1]*1e6,traces=ts,massResidual_kg_s=mass,energyResidual_W=energy,entropyProduction_W_K=entropy,grossIncoming_kg_s=gross,tracerResidual_kg_s=tracer,outgoingTracer=B,stationaryWallForce_N=reaction,wallPower_W=0,evaluations=n,violations=violations,admitted=not violations)
A=math.pi/4;R=.1;p=15.2e6;hot=563.15
def tee(u,temperatures=None,areas=None):
    temperatures=temperatures or [hot]*3;areas=areas or [A,A,R]
    return [pt(p,T,v,a,n,b) for T,v,a,n,b in zip(temperatures,u,areas,[[-1,0],[1,0],[0,1]],[.001,.002,.004])]
def stagnation(ports,name):
    n=len(ports);incoming=[i for i in ports if i['u']<0]
    H0=sum(-i['area']*i['rho']*i['u']*(i['h']+.5*i['u']**2) for i in incoming)/sum(-i['area']*i['rho']*i['u'] for i in incoming)
    Pi0=C.PropsSI('P','H',H0,'S',incoming[0]['s'],'Water')
    def evaluate_stag(y):
        Pi=Pi0+1e4*y[n];H=H0+1e4*y[n+1];ts=[]
        for j,i in enumerate(ports):
            pressure=i['p']+1e4*y[j];w=wave(i,pressure);u=w['u']
            d=w if u<=0 else ph(pressure,H-.5*u*u)
            Hi=d['h']+.5*u*u
            ps=C.PropsSI('P','H',Hi,'S',d['s'],'Water')
            ts.append(dict(wave=w,material=d,u=u,q=i['area']*d['rho']*u,H=Hi,stagnationPressure_Pa=ps))
        return Pi,H,ts
    def residual(y):
        Pi,H,ts=evaluate_stag(y)
        return np.array([(t['stagnationPressure_Pa']-Pi)/1e6 for t in ts]+[sum(t['q'] for t in ts)/1000,sum(t['q']*(t['H']-H) for t in ts)/1e8])
    def jacobian(y):
        delta=1e-3
        return np.column_stack([(residual(y+delta*np.eye(n+2)[j])-residual(y-delta*np.eye(n+2)[j]))/(2*delta) for j in range(n+2)])
    y=np.zeros(n+2)
    if max(abs(v) for v in residual(y))<1e-9:evaluations=1
    else:
        lower=[(10e6-i['p'])/1e4 for i in ports]+[(10e6-Pi0)/1e4,(.1e6-H0)/1e4]
        upper=[(19e6-i['p'])/1e4 for i in ports]+[(19e6-Pi0)/1e4,(2e6-H0)/1e4]
        sol=least_squares(residual,y,jac=jacobian,bounds=(lower,upper),xtol=1e-12,ftol=1e-12,gtol=1e-12,max_nfev=40)
        if not sol.success:raise ValueError(sol.message)
        y=sol.x;evaluations=sol.nfev
    Pi,H,ts=evaluate_stag(y);mass=sum(t['q'] for t in ts);energy=sum(t['q']*t['H'] for t in ts)
    entropy=sum(t['q']*t['material']['s'] for t in ts);pressure=max(abs(t['stagnationPressure_Pa']-Pi) for t in ts)
    gross=-sum(t['q'] for t in ts if t['q']<0)
    B=sum(-t['q']*i['tracer'] for t,i in zip(ts,ports) if t['q']<0)/gross
    tracer=sum(t['q']*(i['tracer'] if t['q']<0 else B) for t,i in zip(ts,ports))
    violations=[]
    for value,limit,label in [(mass,1e-6,'mass residual'),(energy,1,'energy residual'),(pressure,1,'stagnation pressure residual'),(tracer,1e-9,'tracer residual')]:
        if abs(value)>limit:violations.append(label)
    if entropy < -1e-4:violations.append('negative junction entropy production')
    for t,i in zip(ts,ports):
        w=t['wave'];d=t['material']
        if min(w['speed'],w['headSpeed'])<=0:violations.append('wave not outgoing')
        if w['s']<i['s']-1e-7:violations.append('wave entropy decrease')
        if 0<=d['quality']<=1:violations.append('wet incoming state outside bounded alternative')
        elif abs(t['u'])>=sound(d['p'],d['s']):violations.append('supersonic trace')
        # Native stagnation reconstruction must remain stable liquid here.
        st=ph(t['stagnationPressure_Pa'],t['H'])
        if 0<=st['quality']<=1:violations.append('wet stagnation endpoint outside bounded alternative')
    force=[sum((i['area']*t['material']['p']+t['q']*t['u'])*i['normal'][axis] for t,i in zip(ts,ports)) for axis in [0,1]]
    return dict(name=name,inputs=ports,stagnationPressure_Pa=Pi,mixedH_J_kg=H,traces=ts,massResidual_kg_s=mass,energyResidual_W=energy,entropyProduction_W_K=entropy,pressureResidual_Pa=pressure,tracerResidual_kg_s=tracer,outgoingTracer=B,stationaryWallForce_N=force,wallPower_W=0,evaluations=evaluations,violations=violations,admitted=not violations)
if len(sys.argv)>1 and sys.argv[1]=='stagnation':
    matching=tee([-10,10,0]);H=matching[0]['h']+50
    Pi=C.PropsSI('P','H',H,'S',matching[0]['s'],'Water')
    d=ph(Pi,H);matching[2].update(d);matching[2]['c']=sound(Pi,d['s'])
    alternatives=[]
    for name,ports in [('matching stagnation-prepared zero-side limit',matching),('unchanged high-side-speed contrary fixture',tee([-10,10,40]))]:
        try:alternatives.append(stagnation(ports,name))
        except Exception as error:alternatives.append(dict(name=name,inputs=ports,admitted=False,error=str(error)))
    print(json.dumps(dict(candidate='ideal common-stagnation-pressure energy-recovering intersection',geometry=dict(mainArea_m2=A,developedRhrArea_m2=R,elevation_m=2.5),preparationNote='Main through state unchanged; zero-side static p/h explicitly changed to its recovered stagnation p/H. Old equal-static-p fixture is not claimed stationary.',cases=alternatives,versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__,python=sys.version)),sort_keys=True))
    sys.exit(0)
cases=[]
specs=[
 ('zero lateral throughflow',tee([-10,10,0])),
 ('forward main withdrawal',tee([-10,10,1])),
 ('reversed main withdrawal',tee([10,-10,1])),
 ('cold side combining return',tee([-10,10,-1],[hot,hot,393.15])),
 ('two cold hot inflows at cavity junction',tee([-2,-1,3],[hot,393.15,313.15],[R,R,R])),
 ('equal-bore reversed exit',tee([3,-1,-2],[313.15,393.15,hot],[R,R,R])),
 ('large side speed contrary case',tee([-10,10,40])),
]
for name,ports in specs:
    try:cases.append(solve(name,ports))
    except Exception as error:cases.append(dict(name=name,inputs=ports,admitted=False,error=str(error)))
# Pure circulation across two opposed side mouths has zero NET side mass,
# yet finite gross material/energy transfer. No restrictions/network added.
exchange=[pt(p,hot,-10,A,[-1,0],.001),pt(p,hot,10,A,[1,0],.001),pt(p,hot,-1,R,[0,-1],.004),pt(p,hot,1,R,[0,1],.004)]
# Independently prescribed equal total enthalpy with opposed gross exchange;
# branch static h includes its own smaller velocity, not copied main T.
for j in [2,3]:
    d=ph(p,exchange[0]['h']+(10**2-1**2)/2)
    exchange[j].update(d);exchange[j]['c']=sound(p,d['s'])
try:cases.append(solve('opposed side exchange, zero net branch mass is not no exchange',exchange))
except Exception as error:cases.append(dict(name='opposed side exchange',admitted=False,error=str(error)))
rest=[pt(p,T,0,a,n) for T,a,n in zip([hot,393.15,313.15],[A,A,R],[[-1,0],[1,0],[0,1]])]
allzero=dict(name='equal-pressure resting distinct temperatures',inputs=rest,pressure_Pa=p,mixedH_J_kg=None,massFluxes=[0,0,0],energyFluxes=[0,0,0],entropyProduction_W_K=0,admitted=True,meaning='Exact stationary contact convention; no mixture evaluated or finite inventory reset')
print(json.dumps(dict(candidate='ideal zero-storage native-water junction; no selected extra headloss',geometry=dict(mainArea_m2=A,developedRhrArea_m2=R,elevation_m=2.5),cases=cases,allZero=allzero,versions=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__,python=sys.version)),sort_keys=True))
`

if (import.meta.main) {
  const [python, output, mode = 'static'] = process.argv.slice(2)
  if (!python || !output) throw new Error('Usage: <research-python> <output.json>')
  const source = await Bun.file(import.meta.path).text()
  if (!['static', 'stagnation'].includes(mode)) throw new Error('Unknown candidate mode')
  const child = Bun.spawn([python, '-c', calculation, mode], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(stderr)
  if (await Bun.file(import.meta.path).text() !== source) throw new Error('Source changed during calculation')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const result = { sourceSha256: hash(source), calculationSha256: hash(calculation), ...JSON.parse(stdout) }
  await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ output, cases: result.cases.map((c: { name: string; admitted: boolean; violations?: string[]; error?: string }) => ({ name: c.name, admitted: c.admitted, violations: c.violations, error: c.error })) }))
}
