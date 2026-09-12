/** Stationary actual-series pressure allocation. Not cold-plug displacement or a transient solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { phasePathCalculation, phasePathSetup } from './reference-design-cmt-phase-path.ts'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry.ts'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const parentSchema = z.object({ sourceHash: z.string(), calculationHash: z.string(), inputHash: z.string(),
  input: z.record(z.string(), z.unknown()), calibrations: z.array(z.object({ name: z.string(), effectiveArea_m2: z.number().finite().positive(),
    result: z.object({ admitted: z.literal(true) }) })) })
export function phaseSeriesParent(value: unknown) {
  const p = parentSchema.parse(value)
  if (p.inputHash !== hash(JSON.stringify(p.input)) || p.calculationHash !== hash(phasePathCalculation))
    throw new Error('Phase-series parent input/calculation identity mismatch')
  const bore = z.number().finite().positive().parse(p.input.bore_m), area = Math.PI * bore * bore / 4
  if (p.calibrations.some(c => c.effectiveArea_m2 >= area)) throw new Error('Parent effective throat is not smaller than physical bore')
  for (const name of ['isolation', 'check', 'CMT-meter'])
    if (p.calibrations.filter(c => c.name === name).length !== 1) throw new Error('Missing/ambiguous physical series device')
  return p
}

export const phaseSeriesCalculation = phasePathSetup + String.raw`
import time
from scipy.integrate import solve_ivp
began=time.monotonic();r=d['serial'];g=9.80665;L=d['delivery']['length_m'];D=d['delivery']['bore_m']
z0=r['mouth_m'];z1=d['delivery']['dviPort_m'];slope=(z1-z0)/L
areas=r['areas'];pReceiver=r['receiverPressure_Pa'];z=lambda l:z0+slope*l
def budget():
    if time.monotonic()-began>90:raise TimeoutError('Frozen 90 s stationary comparison budget')
def material(q):
    x=q['x'];p=q['p']
    if 0<x<1:
        f=pq(p,0);drf=w.first_saturation_deriv(C.iDmass,C.iP);dsf=w.first_saturation_deriv(C.iSmass,C.iP);muf=w.viscosity()
        v=pq(p,1);drv=w.first_saturation_deriv(C.iDmass,C.iP);dsv=w.first_saturation_deriv(C.iSmass,C.iP);muv=w.viscosity()
        vf=1/f['rho'];vg=1/v['rho'];dx=-((1-x)*dsf+x*dsv)/(v['s']-f['s'])
        vp=(1-x)*(-drf/f['rho']**2)+x*(-drv/v['rho']**2)+(vg-vf)*dx
        vs=(vg-vf)/(v['s']-f['s']);c2=-(1/q['rho'])**2/vp
        mu=1/((1-x)/muf+x/muv)
    else:
        ps(p,q['s']);c2=w.speed_sound()**2
        vs=-w.first_partial_deriv(C.iDmass,C.iSmass,C.iP)/q['rho']**2;mu=w.viscosity()
    guard(c2>0 and mu>0 and math.isfinite(vs),'Stationary material derivatives')
    return c2,vs,mu
def friction(m,q):
    c2,vs,mu=material(q);Re=m*D/(A*mu)
    if Re==0:return 0.,c2,vs,mu
    lam=64/Re
    if Re<=2300:f=lam
    else:
        rr=d['delivery']['roughness_m']/D
        turbulent=brentq(lambda f:1/math.sqrt(f)+2*math.log10(rr/3.7+2.51/(Re*math.sqrt(f))),.001,.2)
        f=turbulent if Re>=4000 else lam+(turbulent-lam)*(Re-2300)/1700
    return f,c2,vs,mu
def state_at(p,H,m,l):
    guard(pReceiver*.999<=p<=b['pressure_Pa']*1.001,'Frozen stationary pressure domain')
    q,err=downstream(p,H-g*z(l),m)
    guard(abs(err)<1e-5,'Native stationary enthalpy coordinate');return q
def pipe_back(pEnd,H,m,end,start):
    G=m/A
    def terms(l,p):
        budget();q=state_at(p,H,m,l);u=G/q['rho'];f,c2,vs,mu=friction(m,q)
        sonic=1-u*u/c2;guard(sonic>0,'Actual pipe sonic denominator outside selected branch')
        F=f*u*u/(2*D)
        derivative=(-q['rho']*(g*slope+F)-G*G*vs*F/q['T'])/sonic
        return q,u,F,derivative,sonic,mu
    solution=solve_ivp(lambda l,y:[terms(l,float(y[0]))[3]],(end,start),[pEnd],method='DOP853',
        rtol=1e-8,atol=.01,max_step=.25,dense_output=True)
    guard(solution.success,'Stationary spatial integration status')
    sampled=[]
    for l in np.linspace(start,end,17):
        p=float(solution.sol(l)[0]);q,u,F,dp,sonic,mu=terms(float(l),p)
        sampled.append(dict(l_m=float(l),z_m=z(float(l)),state=q,velocity_m_s=u,sonicMargin=sonic,
            viscosity_Pa_s=mu,momentumGradient_Pa_m=dp,entropyGradient_J_kgKm=F/q['T']))
    sums=dict(V=0.,M=0.,P=0.,U=0.,K=0.,PE=0.,liquidM=0.,entropy=0.,force=0.)
    xn,xw=np.polynomial.legendre.leggauss(16);half=(end-start)/2;mid=(end+start)/2
    for node,weight in zip(xn,xw):
        l=mid+half*float(node);p=float(solution.sol(l)[0]);q,u,F,dp,sonic,mu=terms(l,p);dl=half*float(weight)
        dm=q['rho']*A*dl
        for key,value in dict(V=A*dl,M=dm,P=dm*u,U=dm*(q['h']-p/q['rho']),K=dm*u*u/2,
            PE=dm*g*z(l),liquidM=dm*(1-q['x']),entropy=dl*F/q['T'],force=-dl*q['rho']*(g*slope+F)).items():sums[key]+=value
    qa=sampled[0]['state'];qb=sampled[-1]['state']
    entropyError=qb['s']-qa['s']-sums['entropy']
    momentumError=(qb['p']+G*G/qb['rho'])-(qa['p']+G*G/qa['rho'])-sums['force']
    guard(abs(entropyError)<1e-5 and abs(momentumError)<.1,'Independent integrated pipe balance')
    guard(abs(sums['P']-m*(end-start))<1e-8 and sums['M']>0,'Finite passage momentum/inventory')
    sums['E']=sums['U']+sums['K']+sums['PE']
    return float(solution.sol(start)[0]),dict(start_m=start,end_m=end,points=sampled,native=sums,
        entropyResidual_J_kgK=entropyError,momentumResidual_Pa=momentumError,nfev=solution.nfev)
def device_back(pd,H,m,l,name,crack=0.):
    a=areas[name];localH=H-g*z(l);low=pd+crack
    def residual(p):
        budget()
        if p==low:return m*(a/A-1)
        up=state_at(p,H,m,l);G,t,choked=throat(up,localH,low,True)
        return a*G-m
    hi=b['pressure_Pa'];guard(residual(hi)>0,'No pressure bracket for actual series device')
    pu=brentq(residual,low,hi,xtol=1e-5);up=state_at(pu,H,m,l);down=state_at(pd,H,m,l)
    G,t,choked=throat(up,localH,low,True);vu=m/(A*up['rho']);vd=m/(A*down['rho'])
    guard(abs(a*G-m)<1e-6 and down['s']>=up['s']-1e-7,'Serial device capacity/entropy')
    guard(vu*vu<material(up)[0] and vd*vd<material(down)[0],'Actual device full-bore recovery outside selected branch')
    return pu,dict(name=name,pu_Pa=pu,pd_Pa=pd,up=up,down=down,throat=t,choked=choked,
        massFlow_kg_s=m,energyFlow_W=m*H,capacityResidual_kg_s=a*G-m,
        entropyRise_J_kgK=down['s']-up['s'],wallOnFluid_N=A*(pd-pu)+m*(vd-vu),
        rawDP_Pa=pu-pd,overrange=abs(pu-pd)>b['cmtRawDPSpan_Pa'] if name=='CMT-meter' else None)
def one_case(name,source):
    H=source['h']+g*z0;maxG,t,unused=throat(source,source['h'],pReceiver,True)
    mCritical=areas['isolation']*maxG
    def bore(m):
        def equation(p):
            q=ps(p,source['s']);return q['h']+.5*(m/(A*q['rho']))**2-source['h']
        p=brentq(equation,t['p'],source['p'],xtol=1e-5);q=ps(p,source['s'])
        guard(abs(equation(p))<1e-5,'Bulk-to-bore energy');return q
    def back(m):
        pCheck,check=device_back(pReceiver,H,m,L,'check',d['checkCrack_Pa'])
        pMeterDown,last=pipe_back(pCheck,H,m,L,7.)
        pMeterUp,meter=device_back(pMeterDown,H,m,7.,'CMT-meter')
        pIsoDown,first=pipe_back(pMeterUp,H,m,7.,0.)
        inlet=bore(m);G,th,choked=throat(inlet,source['h'],pIsoDown,True)
        return m-areas['isolation']*G,dict(massFlow_kg_s=m,source=source,sourceHt_J_kg=H,
            inlet=inlet,isolationDownstream_Pa=pIsoDown,isolationThroat=th,isolationChoked=choked,
            check=check,meter=meter,pipes=[first,last])
    residual,result=back(mCritical)
    # The source choke is a physical endpoint of the SAME capacity relation.
    # If this hardware requires greater backpressure, solve its subcritical branch once.
    if abs(residual)>1e-6:
        lower=mCritical*.01
        guard(back(lower)[0]<0 and residual>0,'No bracket in frozen series mass interval')
        m=brentq(lambda m:back(m)[0],lower,mCritical,xtol=1e-7)
        residual,result=back(m)
    guard(abs(residual)<1e-6,'Whole-series isolation capacity')
    result['sourceCapacityResidual_kg_s']=residual
    result['pipeVolume_m3']=sum(p['native']['V'] for p in result['pipes'])
    result['pipeMass_kg']=sum(p['native']['M'] for p in result['pipes'])
    result['pipeEnergy_J']=sum(p['native']['E'] for p in result['pipes'])
    result['pipeBoron_kg']=result['pipeMass_kg']*(1-source['x'])*b['boronLiquidFraction']
    guard(abs(result['pipeVolume_m3']-A*L)<1e-12,'Actual outlet water envelope retained once')
    result['admitted']=True;result['name']=name
    result['actualSeparatedTankSource']=name=='established-steam'
    return result
cases=[]
for name,source in [('established-steam',pt(b['pressure_Pa'],pq(b['pressure_Pa'],1)['T']+b['steamSuperheat_K'])),
                    ('local-mixed-port-sensitivity',pq(b['pressure_Pa'],b['mixedQuality']))]:
    try:cases.append(one_case(name,source))
    except (ValueError,RuntimeError,TimeoutError) as error:cases.append(dict(name=name,source=source,admitted=False,error=str(error)))
json.dump(dict(cases=cases,stationarySerialEnvelopeAdmitted=all(c['admitted'] for c in cases),
    coldPlugDisplacementQualified=False,sustainedFiniteSourceDeliveryQualified=False,
    elapsed_s=time.monotonic()-began,versions=dict(Python=platform.python_version(),CoolProp=CoolProp.__version__)),sys.stdout,indent=2,allow_nan=False)
`

if (import.meta.main) {
  const [parentPath, python, output] = process.argv.slice(2)
  if (!parentPath || !python || !output) throw new Error('Usage: phase-series.ts phase-path.json python output.json')
  const parentText = await Bun.file(parentPath).text(), parent = phaseSeriesParent(JSON.parse(parentText))
  const geometry = parseGeometryBasis('```reference-cmt-geometry\n' + JSON.stringify(parent.input.geometry) + '\n```')
  const areas = Object.fromEntries(parent.calibrations.map(c => [c.name, c.effectiveArea_m2]))
  const input = { ...parent.input, serial: { mouth_m: tankGeometry(geometry).mouth, receiverPressure_Pa: 1e6, areas } }
  const identities = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(phaseSeriesCalculation),
    inputHash: hash(JSON.stringify(input)), parentReceiptHash: hash(parentText), parentSourceHash: parent.sourceHash,
    phaseHelperSourceHash: hash(await Bun.file(new URL('./reference-design-cmt-phase-path.ts', import.meta.url)).text()),
    geometrySourceHash: hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()) }
  const child = Bun.spawn([python, '-c', phaseSeriesCalculation], { stdin: new Response(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(stderr)
  await Bun.write(output, JSON.stringify({ ...identities, input, ...JSON.parse(stdout) }, null, 2) + '\n')
}
