/** Offline sealed-vessel constitutive admission test, NOT the connected PACTEL transient. */
import { createHash } from 'node:crypto'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'

export const admissionCalculation = String.raw`
import json,sys,math,platform,iapws
import numpy as np
from scipy.integrate import solve_ivp
from iapws import IAPWS97
from iapws.iapws97 import _Region1,_Region2
b=json.load(sys.stdin);r=b['source'];p0=b['spatial']['surfacePressure_MPa'];g=9.80665
A=math.pi*r['innerRadius_m']**2;H=r['height_m'];L0=r['statedLevel_m'];Tl=r['fluidTemperature_K']
sat=IAPWS97(P=p0,x=1);liq=IAPWS97(P=p0,x=0);Tv=sat.T;zc=(L0+H)/2
if not 0<L0<H or Tl>=Tv:raise ValueError('Expected a subcooled pool below initially dry saturated vapor')
vf=liq.v;hg=sat.h*1000;hf=liq.h*1000;uf=liq.u*1000
def enthalpy(T,p):return _Region1(T,p)['h']*1000
def vapor(T,p):
    q=_Region2(T,p);return 1/q['v'],q['h']*1000-p*1e6*q['v']
# Analytic single-phase branches are used only for local derivatives at saturation.
# A tangent pointing outside their domain is rejected, never continued as a trajectory.
def calculate(count,derivativeScale):
    edges=np.linspace(0,H,count+1);tops=edges[1:][edges[:-1]<L0];tops[-1]=L0
    bottoms=edges[:-1][edges[:-1]<L0];n=len(tops)
    x0=np.r_[p0,np.full(n,Tl),Tv,L0]
    def owners(x):
        p=x[0];level=x[-1];cells=[None]*n;faces=np.zeros(n+1);faces[n]=p
        for i in range(n-1,-1,-1):
            hi=level if i==n-1 else tops[i];lo=bottoms[i];T=x[1+i]
            def rhs(z,y):
                q=_Region1(T,float(y[0]));rho=1/q['v'];u=q['h']*1000-y[0]*1e6*q['v']
                return [-rho*g/1e6,-rho*A,-rho*A*(u+g*z)]
            sol=solve_ivp(rhs,[hi,lo],[p,0.,0.],rtol=1e-10,atol=[1e-12,1e-11,1e-5])
            if not sol.success:raise ValueError(sol.message)
            p,m,e=sol.y[:,-1];cells[i]=[m,e];faces[i]=p
        rho,u=vapor(x[-2],x[0]);v=A*(H-level);m=rho*v
        return np.r_[np.asarray(cells).ravel(),m,m*(u+g*(level+H)/2)],faces
    base,faces=owners(x0);J=np.empty((2*n+2,n+3))
    steps=np.r_[1e-6,np.full(n,1e-4),1e-4,1e-5]*derivativeScale
    for j,step in enumerate(steps):
        plus=x0.copy();minus=x0.copy();plus[j]+=step;minus[j]-=step
        J[:,j]=(owners(plus)[0]-owners(minus)[0])/(2*step)
    # Finite wall receives latent heat; no direct heater-to-pool shortcut.
    wallMass=7920*math.pi*(r['outerRadius_m']**2-r['innerRadius_m']**2)*(H-L0)
    Tw=r['wallTemperature_K'];cp=6.683+.04906*Tw+80.74*math.log(Tw)
    results=[]
    for retained in [True,False]:
        matrix=np.zeros((2*n+2,2*n+2));matrix[:,:n+3]=J;rhs=np.zeros(2*n+2)
        for i in range(n-1):
            col=n+3+i;z=tops[i];e=enthalpy(Tl,faces[i+1])+g*z
            matrix[2*i,col]+=1;matrix[2*(i+1),col]-=1
            matrix[2*i+1,col]+=e;matrix[2*(i+1)+1,col]-=e
        matrix[2*n-1,n+2]+=p0*1e6*A # pool pays moving-interface work
        matrix[2*n+1,n+2]-=p0*1e6*A # vapor receives exactly the same work
        rv,uv=vapor(Tv,p0);ev=uv+g*zc
        if retained:
            # Film insertion removes vapor volume, costs p*dV, and stores u_f+gz.
            rhs[-2]=-1+rv*vf
            rhs[-1]=-hg-g*zc+p0*1e6*vf+rv*vf*ev
        else:
            rhs[2*n-2]=1;rhs[2*n-1]=hf+g*zc # fall energy is included, not discarded
            rhs[-2]=-1;rhs[-1]=-hg-g*zc
        scales=np.tile([1.,1e6],n+1)
        change=np.linalg.solve(matrix/scales[:,None],rhs/scales)
        residual=matrix@change-rhs
        if max(abs(residual[::2]))>1e-8 or max(abs(residual[1::2]))>.01:
            raise ValueError('Local conservative tangent residual failed')
        rates=J@change[:n+3]
        if retained:rates[-2]-=rv*vf;rates[-1]-=rv*vf*ev
        massResidual=float(sum(rates[::2])+(1 if retained else 0))
        energyResidual=float(sum(rates[1::2])+(uf+g*zc if retained else 0)+(hg-hf))
        if abs(massResidual)>1e-8 or abs(energyResidual)>.01:raise ValueError('Global conserved tangent failed')
        dp=change[0];dT=change[n+1];dL=change[n+2]
        dTsat=(IAPWS97(P=p0+1e-5,x=1).T-IAPWS97(P=p0-1e-5,x=1).T)/2e-5
        results.append(dict(path='wall-retained' if retained else 'drained-to-pool',
            pressureDerivative_MPa_per_kg=float(dp),vaporTemperatureDerivative_K_per_kg=float(dT),
            vaporSaturationMarginDerivative_K_per_kg=float(dT-dTsat*dp),
            surfaceDerivative_m_per_kg=float(dL),
            poolTopTemperatureDerivative_K_per_kg=float(change[n]),
            poolTopSaturationMarginDerivative_K_per_kg=float(change[n]-dTsat*dp),
            finiteWallTemperatureDerivative_K_per_kg=(hg-hf)/(wallMass*cp),
            massResidual_kg_per_kg=massResidual,energyResidual_J_per_kg=energyResidual,
            maxLocalMassResidual=float(max(abs(residual[::2]))),maxLocalEnergyResidual_J_per_kg=float(max(abs(residual[1::2]))),
            dryVaporAdmitted=bool(dT-dTsat*dp>=0)))
    return dict(sourceBands=count,occupiedLiquidBands=n,derivativeScale=derivativeScale,
        initialLiquidMass_kg=float(sum(base[:2*n:2])),initialVaporMass_kg=float(base[-2]),paths=results)
cases=[calculate(n,s) for n,s in [(r['cellCount'],1.),(r['cellCount'],.5),(2*r['cellCount'],.5)]]
for j in range(2):
    a=cases[0]['paths'][j];b=cases[1]['paths'][j];c=cases[2]['paths'][j]
    for key in ['pressureDerivative_MPa_per_kg','vaporSaturationMarginDerivative_K_per_kg','surfaceDerivative_m_per_kg']:
        if abs(a[key]-b[key])>1e-4*max(1,abs(b[key])) or abs(b[key]-c[key])>1e-3*max(1,abs(c[key])):
            raise ValueError('Derivative or spatial refinement failed')
print(json.dumps(dict(scope='Sealed native vessel, conditional unit wall-condensation extent; no rate or connected transient',
    python=platform.python_version(),iapws=iapws.__version__,
    initialPoolTopSubcooling_K=Tv-Tl,condensationCentroid_m=zc,cases=cases,
    trajectoryQualified=False,phaseMorphologySelected=False),allow_nan=False))
`

if (import.meta.main) {
  const [source, state, python] = process.argv.slice(2)
  if (!source || !state || !python) throw Error('Usage: reference-design-pressurizer-admission.ts <source-page> <state-owner> <python>')
  const input = { source: parsePressurizerBoundaries(await Bun.file(source).text()), spatial: parseSpatialBasis(await Bun.file(state).text()) }
  const child = Bun.spawn([python, '-c', admissionCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(admissionCalculation), ...JSON.parse(out) }, null, 2))
}
