/** Shared offline all-liquid reservoir equations. No live runtime or independent pressure inventory. */
export const hydrostaticLiquidPython = String.raw`
import math
import numpy as np
import CoolProp.CoolProp as CP
from scipy.optimize import root
_hydrostatic_water=CP.AbstractState('HEOS','Water')
_hydrostatic_calls=0
_hydrostatic_entropy_error=0.

def liquid_ps_si(p,s):
    global _hydrostatic_calls,_hydrostatic_entropy_error
    if not math.isfinite(p) or p<=0 or not math.isfinite(s):raise ValueError('Invalid liquid p/s')
    w=_hydrostatic_water;_hydrostatic_calls+=1
    w.update(CP.PSmass_INPUTS,p,s)
    if w.phase()!=CP.iphase_liquid:raise ValueError('Reservoir left its all-liquid branch')
    # Refine the known PS inverse roundoff against the forward PT entropy, not by clipping a phase.
    T=w.T()
    for _ in range(8):
        w.update(CP.PT_INPUTS,p,T);_hydrostatic_calls+=1
        if w.phase()!=CP.iphase_liquid:raise ValueError('Entropy refinement left the liquid branch')
        error=w.smass()-s
        if abs(error)<=1e-8:break
        T-=error*T/w.cpmass()
    _hydrostatic_entropy_error=max(_hydrostatic_entropy_error,abs(error))
    if abs(error)>1e-8:raise ValueError('Forward entropy residual exceeds 1e-8 J/kg/K')
    return dict(p=p,s=w.smass(),T=w.T(),rho=w.rhomass(),u=w.umass(),h=w.hmass())

def liquid_pt_si(p,T):
    global _hydrostatic_calls
    if not all(math.isfinite(v) for v in [p,T]) or p<=0 or T<=0:raise ValueError('Invalid liquid p/T')
    _hydrostatic_water.update(CP.PT_INPUTS,p,T);_hydrostatic_calls+=1
    if _hydrostatic_water.phase()!=CP.iphase_liquid:raise ValueError('Reservoir seed is not liquid')
    return liquid_ps_si(p,_hydrostatic_water.smass())

def make_liquid_reservoir(area,bottom,top,reference,g=9.80665,order=8):
    if not all(math.isfinite(v) for v in [area,bottom,top,reference,g]) or area<=0 or top<=bottom or g<=0:
        raise ValueError('Invalid finite reservoir geometry')
    if not bottom<=reference<=top or not isinstance(order,int) or order<2:raise ValueError('Invalid reference/quadrature')
    gx,gw=np.polynomial.legendre.leggauss(order)
    nodes=bottom+(gx+1)*(top-bottom)/2;weights=gw*(top-bottom)*area/2
    volume=area*(top-bottom)
    def forward(p,s):
        base=liquid_ps_si(p,s);H=base['h']+g*reference;cache={reference:base};max_head_error=0.
        def at(z):
            nonlocal max_head_error
            if not math.isfinite(z) or not bottom<=z<=top:raise ValueError('Port outside reservoir envelope')
            if z in cache:return cache[z]
            target=H-g*z;pp=p-base['rho']*g*(z-reference)
            for _ in range(8):
                q=liquid_ps_si(pp,s);error=q['h']-target
                if abs(error)*q['rho']<=.001:break
                pp-=q['rho']*error
            head_error=abs(error)*q['rho'];max_head_error=max(max_head_error,head_error)
            if head_error>.001:raise ValueError('Hydrostatic face residual exceeds 0.001 Pa')
            cache[z]=q;return q
        states=[at(float(z)) for z in nodes]
        M=sum(a*q['rho'] for a,q in zip(weights,states))
        U=sum(a*q['rho']*q['u'] for a,q in zip(weights,states))
        PE=sum(a*q['rho']*g*z for a,z,q in zip(weights,nodes,states))
        lower=at(bottom);upper=at(top)
        return dict(M=M,U=U,PE=PE,E=U+PE,V=volume,p_reference=p,s=s,
            bottom=lower,top=upper,at=at,initialHeadResidual_Pa=max_head_error)
    def recover(M,E,guess):
        if not math.isfinite(M) or M<=0 or not math.isfinite(E):raise ValueError('Invalid native reservoir inventory')
        p0,s0=guess
        def residual(x):
            q=forward(x[0]*1e6,x[1]*1000)
            return np.array([(q['M']-M)/M,(q['E']-E)/max(abs(E),1.)])
        def jacobian(x):
            # Fixed physical 100 Pa /0.001 J/kg/K probes, independently of solver coordinates.
            steps=np.array([1e-4,1e-6]);columns=[]
            for j,step in enumerate(steps):
                dx=np.zeros(2);dx[j]=step
                columns.append((residual(x+dx)-residual(x-dx))/(2*step))
            return np.array(columns).T
        solution=root(residual,np.array([p0/1e6,s0/1000]),jac=jacobian,options=dict(xtol=1e-8))
        q=forward(solution.x[0]*1e6,solution.x[1]*1000)
        if not solution.success or abs(q['M']-M)>1e-6 or abs(q['E']-E)>.01:
            raise ValueError(dict(reason='Native reservoir recovery rejected',solver=str(solution.message),
                massResidual_kg=q['M']-M,energyResidual_J=q['E']-E))
        return q
    return dict(forward=forward,recover=recover,volume=volume)
`

export const hydrostaticLiquidChecks = String.raw`
import json,sys
from scipy.integrate import quad
checks=[];rows=[]
def check(label,error,limit):
    if not math.isfinite(error) or abs(error)>limit:raise ValueError(dict(check=label,error=error,limit=limit))
    checks.append(dict(check=label,error=float(error),limit=limit))
# Explicit comparison fixtures from the selected finite envelopes, not new plant defaults.
for label,area,bottom,top,reference,T in [('lower',14.25,-4.,-2.,-2.,563.15),
    ('upper',16.75,2.,4.,2.5,593.15),('cold-header',4.,2.5,3.5,3.,563.15),
    ('finite-cold-receiver',.5,2.5,3.5,3.,313.15)]:
    seed=liquid_pt_si(15.2e6,T);p=seed['p'];s=seed['s']
    model=make_liquid_reservoir(area,bottom,top,reference);q=model['forward'](p,s);M=q['M']
    fine=make_liquid_reservoir(area,bottom,top,reference,order=16)['forward'](p,s)
    check(label+' spatial refinement mass kg',fine['M']-M,1e-6)
    check(label+' spatial refinement energy J',fine['E']-q['E'],.01)
    check(label+' hydrostatic column weight Pa',q['bottom']['p']-q['top']['p']-9.80665*M/area,.001)
    # Independent mass coordinate: pressure is linear in overlying mass, not solved at spatial nodes.
    def atmass(m):return liquid_ps_si(q['bottom']['p']-9.80665*m/area,s)
    volume=quad(lambda m:1/atmass(m)['rho'],0,M,epsabs=1e-10,epsrel=1e-12)[0]
    internal=quad(lambda m:atmass(m)['u'],0,M,epsabs=.0001,epsrel=1e-12)[0]
    potential=9.80665*bottom*M+9.80665/area*quad(lambda m:(M-m)/atmass(m)['rho'],0,M,epsabs=1e-7,epsrel=1e-12)[0]
    check(label+' independent volume m3',volume-q['V'],1e-8)
    check(label+' independent total energy J',internal+potential-q['E'],.02)
    recovered=model['recover'](M,q['E'],(p+2000,s+.01))
    check(label+' inverse reference pressure Pa',recovered['p_reference']-p,.01)
    check(label+' inverse entropy J/kg/K',recovered['s']-s,1e-7)
    perturbations=[]
    for name,dm,de in [('heat',0.,10000.),('cool',0.,-10000.),
        ('inflow',.01,.01*(seed['h']+9.80665*reference)),('outflow',-.01,-.01*(seed['h']+9.80665*reference))]:
        new=model['recover'](M+dm,q['E']+de,(p,s));dp=new['p_reference']-p
        if dp*(de if dm==0 else dm)<=0:raise ValueError('Physical pressure feedback lost')
        check(label+' '+name+' native mass kg',new['M']-M-dm,1e-6)
        check(label+' '+name+' native energy J',new['E']-q['E']-de,.01)
        perturbations.append(dict(case=name,pressureChange_Pa=dp,massChange_kg=dm,energyChange_J=de))
    shifted=make_liquid_reservoir(area,bottom+100,top+100,reference+100)['forward'](p,s)
    check(label+' datum mass kg',shifted['M']-M,1e-6)
    check(label+' datum energy J',shifted['E']-q['E']-M*9.80665*100,.02)
    rows.append(dict(owner=label,M_kg=M,E_J=q['E'],bottomPressure_Pa=q['bottom']['p'],
        topPressure_Pa=q['top']['p'],volume_m3=q['V'],perturbations=perturbations))
for action in [lambda:make_liquid_reservoir(0,0,1,0),lambda:make_liquid_reservoir(1,0,1,2),
    lambda:liquid_pt_si(1e5,500),lambda:model['forward'](float('nan'),s),lambda:q['at'](top+1)]:
    rejected=False
    try:action()
    except ValueError:rejected=True
    if not rejected:raise ValueError('Invalid reservoir input was accepted')
    check('invalid geometry, phase or port rejected',0,0)
print(json.dumps(dict(results=rows,checks=checks,maximumForwardEntropyResidual_J_kgK=_hydrostatic_entropy_error,
    propertyCalls=_hydrostatic_calls,scope='All-liquid finite reservoir storage/recovery and physical face checks; no transient',
    transientQualified=False),allow_nan=False))
`

if (import.meta.main) {
  const [python, ...extra] = Bun.argv.slice(2)
  if (!python || extra.length) throw Error('Usage: hydrostatic-liquid.ts <research-python>')
  const { createHash } = await import('node:crypto')
  const calculation = hydrostaticLiquidPython + hydrostaticLiquidChecks
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const identity = { sourceSha256: hash(await Bun.file(import.meta.path).text()), calculationSha256: hash(calculation) }
  const child = Bun.spawn([python, '-c', calculation], { stdout: 'pipe', stderr: 'inherit' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw Error('Hydrostatic reservoir verification failed')
  console.log(JSON.stringify({ ...identity, ...JSON.parse(out) }, null, 2))
}
