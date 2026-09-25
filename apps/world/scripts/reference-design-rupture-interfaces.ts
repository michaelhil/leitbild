/** Offline local rupture-port selection: native face maps and packets, not a plant transient. */
import { createHash } from 'node:crypto'
import { ringArea } from './reference-design-cmt-geometry'

export const ruptureBasis = {
  gravity_m_s2: 9.80665,
  sgPrimaryStation_m: 20,
  sgPortElevation_m: 3,
  secondaryReferenceElevation_m: 0,
  secondaryContactCoordinate_m: 0.5,
  sgCdA_m2: 2e-5,
  rcsCenter_m: 3,
  rcsDiameter_m: 0.02,
  rcsCdA_m2: 1e-4,
  openingTime_s: 0.1,
} as const

/** Sharp horizontal interfaces are a geometric limit of the local phase-area integral. */
export function rupturePatches(headerSurface: number, sumpSurface: number) {
  if (![headerSurface, sumpSurface].every(Number.isFinite)) throw Error('Invalid interface')
  const b = ruptureBasis, r = b.rcsDiameter_m / 2
  const headerOffset = headerSurface - b.rcsCenter_m, sumpOffset = sumpSurface - b.rcsCenter_m
  const edges = [...new Set([-r, r, headerOffset, sumpOffset].filter(z => z >= -r && z <= r))].sort((a, b) => a - b)
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]!, mid = (lo + hi) / 2
    const area = ringArea({ holeDiameter_m: b.rcsDiameter_m, holesPerRing: 1 }, 0, lo, hi)
    return { lo_m: b.rcsCenter_m + lo, hi_m: b.rcsCenter_m + hi, header: mid < headerOffset ? 'liquid' : 'gas',
      receiver: mid < sumpOffset ? 'liquid' : 'gas', area_m2: area,
      effectiveArea_m2: b.rcsCdA_m2 * area / (Math.PI * r * r) }
  })
}

const calculation = String.raw`
import json,sys,math,CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,minimize_scalar
from scipy.integrate import quad,solve_ivp
b=json.loads(sys.argv[1]);g=b['gravity_m_s2'];z=b['sgPortElevation_m'];checks=[]
def check(name,value,bound):
 if not math.isfinite(value) or abs(value)>bound:raise ValueError((name,value,bound))
 checks.append(dict(name=name,value=value,bound=bound))
def state(p,h):
 return dict(p=p,h=h,rho=P('D','P',p,'H',h,'Water'),T=P('T','P',p,'H',h,'Water'),u=P('U','P',p,'H',h,'Water'),s=P('S','P',p,'H',h,'Water'),phase=P('Phase','P',p,'H',h,'Water'))
def face(p0,h0,height):
 s=P('S','P',p0,'H',h0,'Water');target=h0-g*height
 pp=brentq(lambda p:P('H','P',p,'S',s,'Water')-target,.8*p0,1.2*p0,xtol=1e-6)
 return state(pp,target)
def capacity(p,h,back):
 if p==back:return dict(flow=0.,throat=p)
 if p<back:raise ValueError('Caller must select actual donor')
 s=P('S','P',p,'H',h,'Water')
 def flux(q):
  if q==p:return 0. # Exact zero-drop endpoint, before an inverse-EOS round trip.
  drop=h-P('H','P',q,'S',s,'Water')
  if drop < -1e-6:raise ValueError(('Negative available work',drop))
  return P('D','P',q,'S',s,'Water')*math.sqrt(2*max(0,drop))
 fit=minimize_scalar(lambda q:-flux(q),bounds=(back,p),method='bounded',options={'xatol':.001})
 if not fit.success:raise ValueError('Throat search failed')
 throat=max([back,p,fit.x],key=flux)
 return dict(flow=b['sgCdA_m2']*flux(throat),throat=throat)

# The same retained-secondary state defines the lifted port under either direction.
# Native water uses its exact entropy potential; this is the zero-NC native-energy limit.
maps=[]
for name,p0,h0 in [('saturated-liquid',6e6,P('H','P',6e6,'Q',0,'Water')),
                    ('saturated-steam',6e6,P('H','P',6e6,'Q',1,'Water')),
                    ('dry-steam',1e6,P('H','P',1e6,'T',500,'Water'))]:
 f=face(p0,h0,z);back=face(f['p'],f['h'],-z);s=P('S','P',p0,'H',h0,'Water')
 check(name+' reversible pressure',back['p']-p0,.01)
 check(name+' reversible enthalpy',back['h']-h0,1e-6)
 check(name+' shared total enthalpy',f['h']+g*z-h0,1e-8)
 work=quad(lambda p:1/P('D','P',p,'S',s,'Water'),p0,f['p'],epsabs=1e-7)[0]
 check(name+' independent native work integral',work+g*z,1e-5)
 sol=solve_ivp(lambda zz,pp:[-g*P('D','P',pp[0],'S',s,'Water')],(0,z),[p0],rtol=1e-10,atol=1e-5)
 if not sol.success:raise ValueError(sol.message)
 check(name+' independent head ODE',sol.y[0,-1]-f['p'],.01)
 check(name+' mapped zero-drive flow',capacity(f['p'],f['h'],f['p'])['flow'],0)
 maps.append(dict(name=name,reference_p=p0,reference_h=h0,face=f,back=back,headIntegral_J_kg=work))

# Exact water-free common-temperature air/N2 endpoint. No water property query.
R=.4*287+.6*296.8;cv=.4*718+.6*742;cp=R+cv;T0=450.;p0=2e5
Tf=T0-g*z/cp;pf=p0*(Tf/T0)**(cp/R)
h0=cv*(T0-298.15)+R*T0;hf=cv*(Tf-298.15)+R*Tf
check('water-free NC reversible head',hf+g*z-h0,1e-8)
check('water-free NC roundtrip',pf*(T0/Tf)**(cp/R)-p0,1e-8)
nc=dict(airMassFraction=.4,nitrogenMassFraction=.6,p0=p0,T0=T0,pface=pf,Tface=Tf,Ht=h0)

# A common bulk pressure is NOT the equal-drive condition after the port lift.
liquid=maps[0]['face'];equalBulk=capacity(6e6,P('H','P',6e6,'T',500,'Water'),liquid['p'])
if not equalBulk['flow']>0:raise ValueError('Lift did not change local drive')
forward=capacity(15e6,P('H','P',15e6,'T',563.15,'Water'),liquid['p'])
reverse=capacity(liquid['p'],liquid['h'],2e6)
if not forward['flow']>0 or not reverse['flow']>0:raise ValueError('Missing signed capacity')

# Prescribed 10g transfers between native fixed-volume water owners.
# Primary axial momentum is debited with actual donor velocity. Lateral reverse
# receipt brings zero axial momentum, rather than cloning the receiver velocity.
def native(V,p,h,velocity,height):
 q=state(p,h);M=q['rho']*V
 return dict(M=M,P=M*velocity,E=M*(q['u']+velocity**2/2+g*height),V=V,z=height)
def recover(q):
 U=q['E']-q['P']**2/(2*q['M'])-q['M']*g*q['z']
 return dict(U=U,p=P('P','D',q['M']/q['V'],'U',U/q['M'],'Water'),T=P('T','D',q['M']/q['V'],'U',U/q['M'],'Water'))
def packet(direction,datum):
 dm=.01;vp=10.;pp=15e6 if direction=='forward' else 2e6;Tp=563.15 if direction=='forward' else 500.
 primary=native(1.,pp,P('H','P',pp,'T',Tp,'Water'),vp,z+datum)
 # Independently prepared 120m3 secondary, 60% saturated liquid by volume.
 ps=6e6;Ml=72*P('D','P',ps,'Q',0,'Water');Mv=48*P('D','P',ps,'Q',1,'Water');Ms=Ml+Mv
 Us=Ml*P('U','P',ps,'Q',0,'Water')+Mv*P('U','P',ps,'Q',1,'Water')
 secondary=dict(M=Ms,P=0.,E=Us+Ms*g*datum,V=120.,z=datum)
 a=dict(primary);c=dict(secondary)
 if direction=='forward':
  H=P('H','P',pp,'T',Tp,'Water')+vp**2/2+g*(z+datum)
  a['M']-=dm;a['P']-=dm*vp;a['E']-=dm*H;c['M']+=dm;c['E']+=dm*H
 else:
  H=liquid['h']+g*(z+datum)
  a['M']+=dm;a['E']+=dm*H;c['M']-=dm;c['E']-=dm*H
 ar=recover(a);cr=recover(c)
 check(direction+' native packet M',a['M']+c['M']-primary['M']-secondary['M'],1e-8)
 check(direction+' native packet E',a['E']+c['E']-primary['E']-secondary['E'],5e-5)
 if direction=='forward':check('primary carries its own axial momentum',a['P']/a['M']-vp,1e-10)
 else:
  check('reverse does not clone primary axial velocity',a['P']-primary['P'],0)
  if not a['P']/a['M']<vp:raise ValueError('Expected receiving dilution of axial momentum')
 return dict(scope='Prescribed local 10g native water coupon, not solved branch duration or two-temperature header advancement',packet_kg=dm,Ht=H,primary=ar,secondary=cr,primaryVelocity=a['P']/a['M'])
packets={}
for direction in ['forward','reverse']:
 row=packet(direction,0.);shift=packet(direction,100.)
 for owner in ['primary','secondary']:
  for key,bound in [('p',.1),('T',1e-6),('U',.0001)]:check(direction+' '+owner+' datum '+key,shift[owner][key]-row[owner][key],bound)
 check(direction+' carried datum shift',shift['Ht']-row['Ht']-g*100,1e-7)
 packets[direction]=row

# Separate prescribed patch transactions demonstrate species/tracer preservation
# when net mass vanishes. They are not solved header or containment states.
patches=[dict(m=.01,water=1.,air=0.,nitrogen=0.,B=.002,h=1.3e6,v=2.),
         dict(m=-.01,water=.7,air=.2,nitrogen=.1,B=0.,h=2.4e6,v=0.)]
net={k:sum(q['m']*q[k] for q in patches) for k in ['water','air','nitrogen','B']}
net['M']=sum(q['m'] for q in patches);net['E']=sum(q['m']*(q['h']+q['v']**2/2+g*3) for q in patches)
check('opposed patch total species',sum(net[k] for k in ['water','air','nitrogen'])-net['M'],1e-15)
check('opposed patch zero net M',net['M'],0)
if net['E']==0 or net['B']==0 or net['air']==0 or net['nitrogen']==0:raise ValueError('Gross donor transfers erased')
print(json.dumps(dict(maps=maps,waterFreeNC=nc,capacity=dict(equalBulkPressure=equalBulk,forward=forward,reverse=reverse),packets=packets,prescribedOpposedPatch=net,checks=checks,dependencies=dict(CoolProp=CoolProp.__version__,scipy=scipy.__version__)),allow_nan=False))
`

if (import.meta.main) {
  const [python, output, ...extra] = Bun.argv.slice(2)
  if (!python || !output || extra.length) throw Error('Usage: rupture-interfaces <research-python> <receipt.json>')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const source = await Bun.file(import.meta.path).text()
  const geometry = await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()
  const child = Bun.spawn([python, '-c', calculation, JSON.stringify(ruptureBasis)], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const result = JSON.parse(out)
  const surfaces = [2.98, 2.99, 2.995, 3, 3.005, 3.01, 3.02]
  const geometryRows = surfaces.flatMap(header => surfaces.map(receiver => ({ header, receiver, patches: rupturePatches(header, receiver) })))
  const fullArea = Math.PI * (ruptureBasis.rcsDiameter_m / 2) ** 2
  for (const row of geometryRows) {
    if (Math.abs(row.patches.reduce((s, q) => s + q.area_m2, 0) - fullArea) > 1e-15 ||
      Math.abs(row.patches.reduce((s, q) => s + q.effectiveArea_m2, 0) - ruptureBasis.rcsCdA_m2) > 1e-15) throw Error('Lost aperture area')
  }
  if (source !== await Bun.file(import.meta.path).text() || geometry !== await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()) throw Error('Consumed source changed')
  const receipt = { sourceSha256: hash(source), geometrySha256: hash(geometry), calculationSha256: hash(calculation), input: ruptureBasis,
    inputSha256: hash(JSON.stringify(ruptureBasis)), resultSha256: hash(JSON.stringify(result)), geometryRows, result }
  await Bun.write(output, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ output, source: receipt.sourceSha256, calculation: receipt.calculationSha256, checks: result.checks.length,
    geometryRows: geometryRows.length, maps: result.maps, capacity: result.capacity, packets: result.packets }))
}
