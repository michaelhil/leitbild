import {expect,test} from 'bun:test'
import {normalTubeDefinitions} from './reference-design-normal-tube'

const fixture=String.raw`
import math,json
from types import SimpleNamespace
# Standalone test-only integration/EOS fixtures, not replacements for research DOP853/HEOS.
def linear2(A,b):
    det=A[0][0]*A[1][1]-A[0][1]*A[1][0]
    return [(b[0]*A[1][1]-A[0][1]*b[1])/det,(A[0][0]*b[1]-b[0]*A[1][0])/det]
np=SimpleNamespace(zeros=lambda n:[0.]*n,linalg=SimpleNamespace(solve=linear2))
class FinalColumn:
    def __init__(self,y):self.final=y
    def __getitem__(self,key):return self.final
def solve_ivp(rhs,span,y,**kwargs):
    a,b=span;n=128;dx=(b-a)/n;y=list(y)
    for i in range(n):
        x=a+i*dx;k1=rhs(x,y);k2=rhs(x+dx/2,[u+dx*v/2 for u,v in zip(y,k1)])
        k3=rhs(x+dx/2,[u+dx*v/2 for u,v in zip(y,k2)]);k4=rhs(x+dx,[u+dx*v for u,v in zip(y,k3)])
        y=[u+dx*(v+2*w+2*t+s)/6 for u,v,w,t,s in zip(y,k1,k2,k3,k4)]
    return SimpleNamespace(success=True,y=FinalColumn(y),t=range(n+1))
g=9.80665;rho=606.;cp=4200.;mu=7e-5;r={'roughness_m':1.5e-6};normal={'liquidContact_W_m2K':2000.,'ambient_K':300.}
def ph(p,h):
    T=300+(h-p/rho)/cp
    return dict(p=p,h=h,T=T,rho=rho,s=cp*math.log(T/300),mu=mu,rp=0.,rh=0.)
def log_darcy_factor(Re,rough):return math.log(.02)
def heat_path(*args,**kwargs):return dict(heat_W=20.)
`+normalTubeDefinitions+String.raw`
L=16.;radius=.45;k1=3.55;k2=k1+math.pi*radius/2
def curved_z(x):
    if x<=k1:return 6.5-x
    if x<=k2:return 2.5+radius*(1-math.sin((x-k1)/radius))
    return 2.5
def curved_slope(x):
    if x<=k1:return -1.
    if x<=k2:return -math.cos((x-k1)/radius)
    return 0.
rows=[]
for geometry in ['curved','straight']:
  for q in [.108,80.]:
    z=curved_z if geometry=='curved' else lambda x:6.5-x/4
    slope=curved_slope if geometry=='curved' else lambda x:-.25
    knots=[k1,k2] if geometry=='curved' else []
    p=15e6;D=.3;area=math.pi*D*D/4;v=q/(rho*area);h=cp*(615-300)+p/rho;H=h+.5*v*v+g*z(0);minor=.9
    result=tube(p,H,q,D,L,.025,z,slope,minor,1.,knots)
    exactPressure=p-rho*g*(z(L)-z(0))-(.02/D+minor/L)*rho*v*v/2*L
    exactH=H-20*L/q
    elevationIntegral=6.5*k1-k1*k1/2+(2.5+radius)*(k2-k1)-radius*radius+2.5*(L-k2) if geometry=='curved' else 6.5*L-L*L/8
    frictionGradient=(.02/D+minor/L)*rho*v*v/2
    exactU=rho*area*((h-p/rho)*L+(frictionGradient/rho-20/q)*L*L/2)
    rows.append(dict(pressureError_Pa=result['outlet']['p']-exactPressure,totalHError_J_kg=result['outlet']['H']-exactH,
      energyResidual_W=result['energyResidual_W'],massError_kg=result['mass_kg']-area*rho*L,
      volumeError_m3=result['volume_m3']-area*L,internalEnergyError_J=result['internalEnergy_J']-exactU,
      potentialEnergyError_J=result['potentialEnergy_J']-rho*area*g*elevationIntegral,
      kineticEnergyError_J=result['kineticEnergy_J']-.5*rho*area*v*v*L,entropy=result['entropyProductionIncludingAmbient_W_K']))
refused=[]
for q,knots in [(0.,[k1,k2]),(.108,[k2,k1]),(.108,[math.nan]),(.108,[0.]),(.108,[L])]:
    try:tube(15e6,1.4e6,q,.3,L,.025,curved_z,curved_slope,.9,1.,knots);refused.append(False)
    except ValueError:refused.append(True)
print(json.dumps(dict(rows=rows,refused=refused)))
`
test('emitted tube balances retain native accumulation across authored knots and straight paths',async()=>{
  const p=Bun.spawn(['python3','-c',fixture],{stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited])
  if(code)throw Error(err)
  const r=JSON.parse(out)
  for(const x of r.rows){expect(Math.abs(x.pressureError_Pa)).toBeLessThan(.01);expect(Math.abs(x.totalHError_J_kg)).toBeLessThan(1e-6);expect(Math.abs(x.energyResidual_W)).toBeLessThan(1e-5);expect(Math.abs(x.massError_kg)).toBeLessThan(1e-6);expect(Math.abs(x.volumeError_m3)).toBeLessThan(1e-12);expect(Math.abs(x.internalEnergyError_J)).toBeLessThan(.01);expect(Math.abs(x.potentialEnergyError_J)).toBeLessThan(.01);expect(Math.abs(x.kineticEnergyError_J)).toBeLessThan(1e-6);expect(x.entropy).toBeGreaterThan(0)}
  expect(r.refused).toEqual([true,true,true,true,true])
})
