/** Bounded cold-material/finite-exchange engineering evidence, never a plant runtime. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseFuelConstruction } from './reference-design-fuel-construction'
import { coldFuelMaterialPython, fuelMaterialPython } from './reference-design-fuel-materials'

const positive = z.number().finite().positive()
const schema = z.object({
  length_m: positive, pressure_Pa: positive, film_W_m2_K: positive,
  preparationTemperature_K: z.number().min(300).max(600),
  duration_s: positive, referenceStep_s: positive,
  coldMinimum_K: z.literal(300), join_K: z.literal(500),
  hotMaximum_K: z.literal(2000),
  cooling: z.object({ fuel_K: z.number().gt(500).max(600), clad_K: z.number().min(300).max(600),
    water_K: z.number().min(300).lt(400), water_kg: positive, weakWater_kg: positive }).strict(),
  heating: z.object({ fuel_K: z.number().min(300).lt(500), clad_K: z.number().min(300).lt(500),
    water_K: z.number().gt(500).max(600), water_kg: positive }).strict(),
}).strict()
export function parseColdFuel(document: string) {
  const blocks = [...document.matchAll(/^```reference-cold-fuel\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-cold-fuel block')
  const basis = schema.parse(JSON.parse(blocks[0]![1]!))
  if (basis.cooling.weakWater_kg >= basis.cooling.water_kg) throw Error('Contrary recipient must have less water')
  return basis
}

const calculation = String.raw`
import json,sys,math,platform
import numpy as np,scipy,CoolProp
from scipy.integrate import quad,solve_ivp
from scipy.optimize import brentq
from CoolProp.CoolProp import PropsSI as P
${fuelMaterialPython}
${coldFuelMaterialPython}
d=json.load(sys.stdin); b=d['basis']; f=d['fuel']; checks=[]
def require(name,condition,**values):
    if not condition:raise ValueError(name+': '+str(values))
    checks.append(dict(name=name,**values))
require('chosen matching magnitude screen',abs(cold_match-1)<.10,matchFactor=cold_match)
for t,tabk,tabcp in [(300,7.59,236),(323,7.34,244),(373,6.83,260),(423,6.38,270),(473,5.98,279)]:
    require('unmodified source/table conductivity '+str(t),abs(cold_reference_kf(t)-tabk)<.006,value=cold_reference_kf(t),table=tabk)
    require('existing caloric independent cold table '+str(t),abs(cpf(t)/tabcp-1)<.01,value=cpf(t),table=tabcp)
grid_properties=np.linspace(300,2000,1701)
require('positive properties across full sampled domain',min(kf(t) for t in grid_properties)>0 and min(cpf(t) for t in grid_properties)>0,samples=len(grid_properties))
hot_grid=[t for t in grid_properties if t>=500]
require('exact retained hot law across all samples',all(kf(t)==hot_kf(t) and fk(t)==hot_fk(t) for t in hot_grid),samples=len(hot_grid))
for t in [300.1,323.,373.,423.,473.,499.9,500.,500.1,600.]:
    eps=1e-4
    require('conductivity primitive '+str(t),abs((fk(t+eps)-fk(t-eps))/(2*eps)-kf(t))<2e-5)
    require('caloric primitive '+str(t),abs((hf(t+eps)-hf(t-eps))/(2*eps)-cpf(t))<1e-5)
require('conductivity join has no jump',abs(kf(500-1e-8)-kf(500+1e-8))<1e-8)
left=(kf(500)-kf(500-.001))/.001;right=(kf(500+.001)-kf(500))/.001
require('join slope kink is retained',abs(left-right)>1e-5,leftSlope=left,rightSlope=right)
for t in [300,350,499.99,500,500.01,600]:
    recovered=brentq(lambda z:hf(z)-hf(t),300,2000,xtol=1e-10)
    require('monotone native fuel energy inversion '+str(t),abs(t-recovered)<1e-8)
caloric=quad(cpf,300,500,epsabs=1e-8)[0]
require('independent cold sensible integral',abs(caloric-(hf(500)-hf(300)))<1e-7,energy_J_kg=caloric)
# Independent original ANL/RE-97/2 pp5-6 molar caloric recommendation.
# Compare derivatives, not caloric zeros, using UO2 molecular mass270.3g/mol.
def anl_cp(t):
    th=516.12;z=th/t;k=8.6144e-5;ea=1.9105
    return (78.215*z*z*math.exp(z)/math.expm1(z)**2+2*.0038609*t+3.4250e8*k*math.exp(-ea/(k*t))*(1+ea/(k*t)))/.2703
anl_errors=[abs(cpf(t)/anl_cp(t)-1) for t in np.linspace(300,500,201)]
require('independent original caloric challenge',max(anl_errors)<.03,maxRelativeDifference=max(anl_errors))
for invalid in [299.99,0.,-1.]:
    try:kf(invalid)
    except ValueError:pass
    else:raise ValueError('Unadmitted cold material accepted')

rf=f['pelletDiameter_m']/2;ro=f['rodOuterDiameter_m']/2;ri=ro-f['cladThickness_m'];L=b['length_m']
mf=math.pi*rf*rf*L*f['fuelDensityFraction']*f['fuelTheoreticalDensity_kg_m3']
mc=math.pi*(ro*ro-ri*ri)*L*f['cladDensity_kg_m3']
# Declared cold construction is prepared ONCE; tests carry it unchanged.
vhe=math.pi*(ri*ri-rf*rf)*L+math.pi*ri*ri*f['plenumLength_m']*L/f['activeLength_m']
nr=f['fillPressure_Pa']*vhe/f['referenceTemperature_K'];che=1.5*nr
accommodation=.425-2.3e-4*b['preparationTemperature_K']
require('prepared open gap and accommodation',ri>rf and accommodation>0)
pressure=b['pressure_Pa']
def water(t):return P('H','P',pressure,'T',t,'Water')
def watercp(t):return P('C','P',pressure,'T',t,'Water')
def heat(tf,tc,tw):
    tg=(tf+tc)/2;khe=BTU*1.314e-3*(1.8*tg)**.668;pg=nr*tg/vhe
    jump=.3048*2.0358e-5*(khe/BTU)*math.sqrt(tg)/((pg/6894.757293168)*accommodation/math.sqrt(4.003))
    # Explicit mean-fuel/mean-clad feasibility coupon, not a radial plant solver.
    resistance=1/(8*math.pi*L*kf(tf))+(ri-rf+1.845*jump)/(2*math.pi*rf*L*khe)+math.log(ro/ri)/(4*math.pi*L*kc(tc))
    qfc=(tf-tc)/resistance
    qcw=(tc-tw)/(math.log(ro/ri)/(4*math.pi*L*kc(tc))+1/(2*math.pi*ro*L*b['film_W_m2_K']))
    return qfc,qcw
require('equal-temperature zero exchange',heat(400,400,400)==(0,0))
require('signed hot-water heating',heat(350,350,560)[1]<0)
def energy(y,mw):
    tf,tc,tw=y
    return mf*(hf(tf)-hf(300))+mc*hc(tc)+che*(tf+tc)/2+mw*water(tw)
cases=[]
for name,initial,mw in [('adequate-cooling',[b['cooling']['fuel_K'],b['cooling']['clad_K'],b['cooling']['water_K']],b['cooling']['water_kg']),
                       ('insufficient-sink',[b['cooling']['fuel_K'],b['cooling']['clad_K'],b['cooling']['water_K']],b['cooling']['weakWater_kg']),
                       ('finite-water-heating',[b['heating']['fuel_K'],b['heating']['clad_K'],b['heating']['water_K']],b['heating']['water_kg']),
                       ('equal-temperature',[400.,400.,400.],b['cooling']['water_kg'])]:
    e0=energy(initial,mw)
    equilibrium=brentq(lambda t:energy([t,t,t],mw)-e0,min(initial),max(initial),xtol=1e-10) if min(initial)<max(initial) else initial[0]
    # Independent energy root fixes the contrary distinction BEFORE dynamics.
    if name=='adequate-cooling':require('adequate finite equilibrium precheck',equilibrium<400,equilibrium_K=equilibrium)
    if name=='insufficient-sink':require('insufficient finite equilibrium precheck',equilibrium>500,equilibrium_K=equilibrium)
    if name=='finite-water-heating':require('heating finite equilibrium precheck',equilibrium>500,equilibrium_K=equilibrium)
    def rhs(t,y):
        tf,tc,tw=y
        if min(y)<300-1e-8 or max(y)>600+1e-8:raise ValueError('Apparatus domain exit; no clipped continuation')
        qfc,qcw=heat(tf,tc,tw)
        capacities=np.diag([mf*cpf(tf),mc*cpc(tc),mw*watercp(tw)])
        capacities[:2,:2]+=che*.25
        return np.linalg.solve(capacities,[-qfc,qfc-qcw,qcw])
    grid=np.linspace(0,b['duration_s'],201)
    outputs=[]
    for method,step in [('Radau',b['referenceStep_s']),('BDF',b['referenceStep_s']/2)]:
        out=solve_ivp(rhs,(0,b['duration_s']),initial,method=method,rtol=1e-9,atol=1e-10,t_eval=grid,max_step=step)
        require(name+' '+method+' advance',out.success)
        defects=[abs(energy(out.y[:,i],mw)-e0) for i in range(len(grid))]
        require(name+' '+method+' sampled trajectory finite energy',max(defects)<.002,maxDefect_J=max(defects),samples=len(grid))
        require(name+' '+method+' finite-temperature maximum principle',np.min(out.y)>=min(initial)-1e-7 and np.max(out.y)<=max(initial)+1e-7)
        outputs.append(out)
    A,Z=outputs;error=float(np.max(abs(A.y-Z.y)))
    require(name+' independent temporal realization',error<2e-5,maxTemperatureDifference_K=error)
    final=A.y[:,-1];q=heat(*final)
    require(name+' consistent finite equilibrium',max(abs(final-equilibrium))<.01,equilibrium_K=equilibrium,final_K=final.tolist())
    if name=='adequate-cooling':require('cold endpoint genuinely reached',min(A.y[0])<400 and min(A.y[0])<500)
    if name=='insufficient-sink':require('contrary sink never reaches500',min(A.y[0])>500)
    if name=='finite-water-heating':require('heating crosses join with no reset',max(A.y[0])>500)
    rho0=P('D','P',pressure,'T',initial[2],'Water');rhof=P('D','P',pressure,'T',final[2],'Water')
    work=pressure*mw*(1/rhof-1/rho0)
    du=mw*(P('U','P',pressure,'T',final[2],'Water')-P('U','P',pressure,'T',initial[2],'Water'))
    dh=mw*(water(final[2])-water(initial[2]))
    require(name+' explicit receiver boundary work',abs(dh-du-work)<1e-6,receiverDeltaH_J=dh,receiverDeltaU_J=du,workToExterior_J=work)
    crossing=None
    for i in range(1,len(grid)):
        if (A.y[0,i-1]-500)*(A.y[0,i]-500)<0:
            crossing=[float(grid[i-1]),float(grid[i])];break
    cases.append(dict(name=name,waterMass_kg=mw,initial_K=initial,final_K=final.tolist(),equilibrium_K=equilibrium,
      joinCrossingSampleBracket_s=crossing,maxTemperatureDifference_K=error,waterBoundaryWork_J=work,
      maximumEnergyDefect_J=max(abs(energy(A.y[:,i],mw)-e0) for i in range(len(grid))),
      samples=[dict(time_s=float(grid[i]),fuel_K=float(A.y[0,i]),clad_K=float(A.y[1,i]),water_K=float(A.y[2,i])) for i in [0,1,2,20,100,200]]))
print(json.dumps(dict(scope='Source-supported cold thermal material selection and fixed-geometry mean-rod/finite-water coupon only; no nuclear restart, radial accuracy, RHR duty or fuel handling qualification',
  sourceComparison=dict(matchFactor=cold_match,coldConductivity300_W_m_K=kf(300),joinConductivity500_W_m_K=kf(500),leftSlope=left,rightSlope=right,coldFuelSensible_J_kg=caloric,anlMaximumCpRelativeDifference=max(anl_errors)),
  coupon=dict(fuelMass_kg=mf,cladMass_kg=mc,heliumCapacity_J_K=che,preparedGap_m=ri-rf,preparedAccommodation=accommodation,pressure_Pa=pressure),
  cases=cases,checks=checks,packages=dict(python=platform.python_version(),scipy=scipy.__version__,numpy=np.__version__,CoolProp=CoolProp.__version__)),allow_nan=False))
`
export async function runColdFuel(fuelDocument: string, python: string) {
  const data = { basis: parseColdFuel(fuelDocument), fuel: parseFuelConstruction(fuelDocument) }
  const process = Bun.spawn([python, '-c', calculation], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  process.stdin.write(JSON.stringify(data)); process.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (code !== 0) throw Error(stderr || stdout)
  return { calculationSha256: createHash('sha256').update(calculation).digest('hex'),
    inputSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'), ...JSON.parse(stdout) }
}
if (import.meta.main) {
  const [owner, python, output, ...extra] = Bun.argv.slice(2)
  if (!owner || !python || !output || extra.length) throw Error('Usage: bun reference-design-cold-fuel.ts <fuel-construction.md> <research-python> <receipt.json>')
  const paths = [owner, import.meta.path, new URL('./reference-design-fuel-materials.ts', import.meta.url).pathname,
    new URL('./reference-design-fuel-construction.ts', import.meta.url).pathname]
  const before = await Promise.all(paths.map(path => Bun.file(path).text()))
  const result = await runColdFuel(before[0]!, python)
  const after = await Promise.all(paths.map(path => Bun.file(path).text()))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Consumed engineering inputs changed during calculation')
  const identities = paths.map((path, i) => ({ file: path.split('/').pop(), sha256: createHash('sha256').update(before[i]!).digest('hex') }))
  await Bun.write(output, JSON.stringify({ identities, ...result }, null, 2) + '\n')
}
