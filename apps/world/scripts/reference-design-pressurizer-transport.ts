/** Offline fixed-height liquid-history reference. No live Pack or PZR pressure solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const positive = z.number().finite().positive()
const fluid = z.object({ temperature_K: positive, boron_ppm: z.number().finite().nonnegative().max(5000) }).strict()
const stroke = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('admit'), source: z.enum(['cold', 'warm']), mass_kg: positive }).strict(),
  z.object({ kind: z.literal('withdraw'), mass_kg: positive }).strict(),
  z.object({ kind: z.literal('hold'), duration_s: positive }).strict(),
])
const schema = z.object({ pressure_MPa: positive, vesselVolume_m3: positive, area_m2: positive,
  initialVolume_m3: positive, initial: fluid, cold: fluid, warm: fluid,
  sourceMass_kg: positive, receiverMass_kg: positive, strokeRate_kg_s: positive,
  strokes: z.array(stroke).min(1), bands: z.array(positive.int()).min(3),
  subdivisions: z.array(positive.int()).min(3),
  costBands: z.array(positive.int()).length(3), costSubdivisions: positive.int(),
  maximumOutletMeanAbsoluteError_K: positive, maximumRelativeWithdrawnEnthalpyError: positive,
}).strict().superRefine((b, ctx) => {
  if (b.initialVolume_m3 >= b.vesselVolume_m3)
    ctx.addIssue({ code: 'custom', message: 'Initial liquid must leave a free surface' })
  for (const levels of [b.bands, b.subdivisions, [b.bands.at(-1)!, ...b.costBands], [b.subdivisions.at(-1)!, b.costSubdivisions]])
    if (levels.some((n, i) => i > 0 && n <= levels[i - 1]!))
      ctx.addIssue({ code: 'custom', message: 'Refinement levels must strictly increase' })
  for (const source of ['cold', 'warm'] as const)
    if (b.strokes.reduce((sum, s) => sum + (s.kind === 'admit' && s.source === source ? s.mass_kg : 0), 0) >= b.sourceMass_kg)
      ctx.addIssue({ code: 'custom', message: 'Finite donor must retain positive inventory' })
  const sequence = b.strokes.map(s => s.kind === 'hold' ? 'hold' : s.kind === 'admit' ? `${s.source}:${s.mass_kg}` : `withdraw:${s.mass_kg}`)
  if (sequence.join(',') !== 'cold:2500,hold,withdraw:1500,warm:2000,hold,withdraw:3500')
    ctx.addIssue({ code: 'custom', message: 'This frozen benchmark requires cold2500/hold/out1500/warm2000/hold/out3500; changing it also requires a reviewed analytical comparator' })
})

export function parseTransportBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-pressurizer-transport\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected exactly one reference-pressurizer-transport block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

// This is a numerical reference, executed with the research environment's pinned
// property library. It is not shipped as a Python production service.
export const transportProperties = String.raw`
import sys,json,math,platform,copy,time
import CoolProp,CoolProp.CoolProp as CP
from scipy.optimize import brentq
from functools import lru_cache
b=json.load(sys.stdin); p=b['pressure_MPa']*1e6
water=CP.AbstractState('HEOS','Water')
water.update(CP.PQ_INPUTS,p,0);hs=water.hmass();ts=water.T()
water.specify_phase(CP.iphase_liquid)
propertyChecks={'maximumInitialFlashEnthalpyResidual_J_kg':0.,'maximumFinalEnthalpyResidual_J_kg':0.}
@lru_cache(maxsize=4096)
def state(h):
    if not math.isfinite(h) or h>=hs:raise ValueError('Single-phase liquid enthalpy boundary')
    water.update(CP.HmassP_INPUTS,h,p)
    # CoolProp's default p/h flash tolerance is coarser than this conservation
    # comparator. Refine the SAME EOS state, rather than relax entropy tests or
    # round input enthalpies. cp is the exact fixed-p Newton derivative.
    propertyChecks['maximumInitialFlashEnthalpyResidual_J_kg']=max(propertyChecks['maximumInitialFlashEnthalpyResidual_J_kg'],abs(water.hmass()-h))
    for iteration in range(4):
        error=water.hmass()-h
        if abs(error)<1e-5:break
        water.update(CP.PT_INPUTS,p,water.T()-error/water.cpmass())
    error=abs(water.hmass()-h)
    if error>=1e-5:raise ValueError('HEOS enthalpy inversion did not converge')
    propertyChecks['maximumFinalEnthalpyResidual_J_kg']=max(propertyChecks['maximumFinalEnthalpyResidual_J_kg'],error)
    t=water.T()
    if not 300<t<ts:raise ValueError('Outside selected liquid-property envelope')
    return 1/water.rhomass(),t,water.smass(),water.umass()
def enthalpy(t):
    if not 300<t<ts:raise ValueError('Initial/source liquid is not strictly subcooled')
    water.update(CP.PT_INPUTS,p,t);return water.hmass()
def parcel(m,h,c):return [m,m*h,m*c]
def vol(x):return x[0]*state(x[1]/x[0])[0] if x[0]>0 else 0.
def totals(xs):return [math.fsum(x[i] for x in xs) for i in range(3)]
def entropy(xs):return math.fsum(x[0]*state(x[1]/x[0])[2] for x in xs if x[0]>0)
def add(a,c):return [a[i]+c[i] for i in range(3)]
def scaled(a,m):return [m,a[1]*m/a[0],a[2]*m/a[0]]
`

export const transportCalculation = `${transportProperties}${String.raw`
def reconstruct(xs,q):
    # Monotone linear reconstruction of cell averages in NONUNIFORM mass
    # coordinates; quadrature pieces are temporary integration data only.
    if q==1:return copy.deepcopy(xs)
    out=[]
    for i,x in enumerate(xs):
        avg=[x[j]/x[0] for j in (1,2)];slopes=[0.,0.]
        if 0<i<len(xs)-1:
            for k,j in enumerate((1,2)):
                left=xs[i-1][j]/xs[i-1][0];right=xs[i+1][j]/xs[i+1][0]
                dl=(avg[k]-left)/((x[0]+xs[i-1][0])/2)
                dr=(right-avg[k])/((x[0]+xs[i+1][0])/2)
                dc=(right-left)/(x[0]+(xs[i-1][0]+xs[i+1][0])/2)
                if dl*dr>0:
                    slopes[k]=math.copysign(min(abs(2*dl),abs(dc),abs(2*dr),
                        2*abs(avg[k]-left)/x[0],2*abs(right-avg[k])/x[0]),dl)
        pieces=[]
        for k in range(q):
            offset=x[0]*((k+.5)/q-.5)
            pieces.append(parcel(x[0]/q,avg[0]+slopes[0]*offset,avg[1]+slopes[1]*offset))
        # Correct only floating-point summation of conserved means, not values
        # or physical inventory, using the final quadrature remainder.
        partial=totals(pieces[:-1]);pieces[-1]=[x[j]-partial[j] for j in range(3)]
        for j in (1,2):
            bounds=[a[j]/a[0] for a in xs[max(0,i-1):i+2]]
            roundoff=4*q*math.ulp(max(abs(v) for v in bounds))
            if any(a[j]/a[0]<min(bounds)-roundoff or a[j]/a[0]>max(bounds)+roundoff for a in pieces):
                raise ValueError('Reconstruction created a scalar overshoot '+str((j,min(bounds),max(bounds),[a[j]/a[0] for a in pieces])))
        out.extend(pieces)
    return out

def remap(xs,n):
    # Ordered donors exist only for this remap. Persistent state is <=n fixed
    # spatial liquid bands. EOS volume of a mixed band is NOT additive volume.
    capacity=b['vesselVolume_m3']/n;out=[];cell=[0.,0.,0.]
    before=totals(xs);beforeS=entropy(xs)
    for original in xs:
        donor=original.copy()
        while donor[0]>0:
            mixed=add(cell,donor)
            if vol(mixed)<=capacity:
                cell=mixed;break
            if len(out)>=n-1:raise ValueError('Full liquid boundary: phase model must change')
            mass=brentq(lambda m:vol(add(cell,scaled(donor,m)))-capacity,
                0.,donor[0],xtol=1e-10,rtol=1e-13)
            if mass<=0:raise ValueError('Remap made no progress')
            used=scaled(donor,mass);cell=add(cell,used);out.append(cell)
            donor=[donor[i]-used[i] for i in range(3)];cell=[0.,0.,0.]
    if cell[0]>0:out.append(cell)
    if not out or sum(vol(x) for x in out)>=b['vesselVolume_m3']:
        raise ValueError('Empty or full liquid boundary')
    errors=[abs(x-y) for x,y in zip(before,totals(out))]
    if errors[0]>1e-7 or errors[1]>.1 or errors[2]>1e-8:
        raise ValueError('Remap changed conserved inventory')
    ds=entropy(out)-beforeS
    if ds<-.001:raise ValueError('Mixing destroyed entropy: '+str(ds)+' J/K')
    return out,ds

def withdraw(xs,m):
    # Always bottom first, even if the cut surface is falling. No top-water or
    # whole-vessel-average substitution. Split only actual donor material.
    if m>=sum(x[0] for x in xs):raise ValueError('Empty liquid boundary')
    out=[];segments=[];left=m
    for x in xs:
        take=min(left,x[0]);left-=take
        if take>0:segments.append(scaled(x,take))
        if take<x[0]:out.append(scaled(x,x[0]-take))
    if left>1e-8:raise ValueError('Withdrawal exceeded available inventory')
    return out,segments

def outlet_error(actual,exact):
    # Compare the piecewise outlet history against the independent material
    # ordering on cumulative discharged mass, not matching arbitrary timesteps.
    a=copy.deepcopy(actual);e=copy.deepcopy(exact);i=j=0;err=peak=mass=boronError=0.
    while i<len(a) and j<len(e):
        dm=min(a[i][0],e[j][0]);dt=abs(state(a[i][1]/a[i][0])[1]-state(e[j][1]/e[j][0])[1])
        err+=dm*dt;peak=max(peak,dt);mass+=dm
        boronError+=dm*abs(a[i][2]/a[i][0]-e[j][2]/e[j][0])
        am=a[i][0]-dm;em=e[j][0]-dm
        if am<=1e-8:i+=1
        else:a[i]=scaled(a[i],am)
        if em<=1e-8:j+=1
        else:e[j]=scaled(e[j],em)
    if abs(mass-sum(x[0] for x in actual))>1e-5:raise ValueError('Outlet comparison lost mass')
    return dict(meanAbsoluteTemperatureError_K=err/mass,peakTemperatureError_K=peak,meanAbsoluteBoronFractionError=boronError/mass)

contactCoalescing={'maximumEnthalpyDistinction_J_kg':0.,'maximumBoronFractionDistinction':0.,'absoluteEntropyChange_J_K':0.}
def contact_remap(xs,n,limit=3):
    # A geometric band owns at most two sharp contacts (three unmixed subcells).
    # Unlike uniform-band mixing, separate physical volumes ARE additive here.
    # Never use source identity, merge unlike material, or retain input packets.
    capacity=b['vesselVolume_m3']/n;bands=[];cell=[];occupied=0.
    for original in xs:
        donor=original.copy()
        while donor[0]>0:
            v=state(donor[1]/donor[0])[0]
            take=min(donor[0],(capacity-occupied)/v)
            if take<=0:raise ValueError('Contact remap made no progress')
            used=scaled(donor,take)
            same=bool(cell) and all(abs(cell[-1][j]/cell[-1][0]-used[j]/used[0])<=
                32*math.ulp(max(abs(cell[-1][j]/cell[-1][0]),abs(used[j]/used[0]))) for j in (1,2))
            if same:
                contactCoalescing['maximumEnthalpyDistinction_J_kg']=max(contactCoalescing['maximumEnthalpyDistinction_J_kg'],abs(cell[-1][1]/cell[-1][0]-used[1]/used[0]))
                contactCoalescing['maximumBoronFractionDistinction']=max(contactCoalescing['maximumBoronFractionDistinction'],abs(cell[-1][2]/cell[-1][0]-used[2]/used[0]))
                merged=add(cell[-1],used)
                contactCoalescing['absoluteEntropyChange_J_K']+=abs(entropy([merged])-entropy([cell[-1],used]))
                cell[-1]=merged
            elif len(cell)<limit:cell.append(used)
            else:raise ValueError('Contact capacity exceeded: '+str(limit)+' subcells in a spatial band '+str(
                [(x[0],x[1]/x[0],x[2]/x[0]) for x in [*cell,used]]))
            occupied+=take*v
            if take==donor[0]:donor=[0.,0.,0.]
            # Preserve the donor's intensive state on a small remainder rather
            # than obtain H/M by subtracting two nearly equal extensive H values.
            # Conservation remains checked independently; no tolerance is widened.
            else:donor=scaled(donor,donor[0]-take)
            if capacity-occupied<=32*math.ulp(capacity):
                bands.append(cell);cell=[];occupied=0.
                if len(bands)>=n:raise ValueError('Full liquid boundary')
    if cell:bands.append(cell)
    if not bands:raise ValueError('Empty liquid boundary')
    flat=[x for band in bands for x in band]
    errors=[abs(x-y) for x,y in zip(totals(xs),totals(flat))]
    if errors[0]>1e-7 or errors[1]>.1 or errors[2]>1e-8:
        raise ValueError('Contact remap changed conserved inventory')
    return bands

def contact_run(n,steps,uniform=False,roundtrip=False,limit=3):
    hi=enthalpy(b['initial']['temperature_K']);ci=b['initial']['boron_ppm']*1e-6
    bands=contact_remap([parcel(b['initialVolume_m3']/state(hi)[0],hi,ci)],n,limit)
    sources={k:parcel(b['sourceMass_kg'],hi if uniform else enthalpy(b[k]['temperature_K']),
        ci if uniform else b[k]['boron_ppm']*1e-6) for k in ['cold','warm']}
    receiver=parcel(b['receiverMass_kg'],hi,ci);outlet=[];snapshots=[]
    def cells():return [x for band in bands for x in band]
    def allstates():return cells()+list(sources.values())+[receiver]
    def energy():return math.fsum(x[0]*state(x[1]/x[0])[3]+p*vol(x) for x in allstates())
    initial=totals(allstates());initialE=energy();initialS=entropy(allstates())
    maxErr=[0.,0.,0.];maxE=0.;maxBands=len(bands);maxSubcells=len(cells());maxLocal=1;elapsed=0.
    hmin=min(enthalpy(b[k]['temperature_K']) for k in ['initial','cold','warm'])
    hmax=max(enthalpy(b[k]['temperature_K']) for k in ['initial','cold','warm'])
    for index,s in enumerate(b['strokes']):
        if s['kind']=='hold':
            before=copy.deepcopy(bands);elapsed+=s['duration_s']
            if bands!=before:raise ValueError('Hold modified contact history')
        else:
            for step in range(steps):
                dm=s['mass_kg']/steps;flat=cells()
                if s['kind']=='admit':
                    source=sources[s['source']]
                    if dm>=source[0]:raise ValueError('Finite source exhausted')
                    moved=scaled(source,dm);sources[s['source']]=scaled(source,source[0]-dm)
                    flat=[moved]+flat
                else:
                    flat,delivered=withdraw(flat,dm);outlet.extend(delivered);receiver=add(receiver,totals(delivered))
                bands=contact_remap(flat,n,limit);elapsed+=dm/b['strokeRate_kg_s']
                if roundtrip:
                    # Persist physical contact state AND finite external owners;
                    # no reconstruction from averages or hidden source labels.
                    bands,sources,receiver=json.loads(json.dumps([bands,sources,receiver]))
                for x in cells():
                    h=x[1]/x[0]
                    if not hmin-1e-6<=h<=hmax+1e-6:raise ValueError('Contact scalar overshoot')
                current=totals(allstates())
                maxErr=[max(maxErr[j],abs(current[j]-initial[j])) for j in range(3)]
                maxE=max(maxE,abs(energy()-initialE));maxBands=max(maxBands,len(bands))
                maxSubcells=max(maxSubcells,len(cells()));maxLocal=max(maxLocal,max(map(len,bands)))
        snapshots.append(dict(stroke=index,elapsed_s=elapsed,level_m=sum(vol(x) for x in cells())/b['area_m2']))
    if maxErr[0]>1e-6 or maxErr[1]>.5 or maxErr[2]>1e-7 or maxE>.5:
        raise ValueError('Contact finite-owner ledger failed')
    if maxBands>n or maxSubcells>limit*n or maxLocal>limit:raise ValueError('Unbounded persistent contact state')
    return dict(bands=n,subdivisions=steps,subcellCapacityPerBand=limit,maximumOccupiedBands=maxBands,maximumPersistentSubcells=maxSubcells,
        maximumSubcellsPerBand=maxLocal,maximumMassResidual_kg=maxErr[0],maximumEnthalpyResidual_J=maxErr[1],
        maximumBoronResidual_kg=maxErr[2],maximumInternalEnergyPlusPistonWorkResidual_J=maxE,
        closedSetEntropyChange_J_K=entropy(allstates())-initialS,
        withdrawnEnthalpy_J=sum(x[1] for x in outlet),snapshots=snapshots,outlet=outlet,finalBands=bands)

def run(n,steps,uniform=False,ordered=False,quadrature=1):
    hi=enthalpy(b['initial']['temperature_K']);ci=b['initial']['boron_ppm']*1e-6
    initial=parcel(b['initialVolume_m3']/state(hi)[0],hi,ci)
    sources={k:parcel(b['sourceMass_kg'],hi if uniform else enthalpy(b[k]['temperature_K']),
        ci if uniform else b[k]['boron_ppm']*1e-6) for k in ['cold','warm']}
    receiver=parcel(b['receiverMass_kg'],hi,ci)
    cells=[initial] if ordered else remap([initial],n)[0]
    def allstates():return cells+list(sources.values())+[receiver]
    start=totals(allstates());v0=sum(vol(x) for x in allstates())
    def eosU():return sum(x[0]*state(x[1]/x[0])[3] for x in allstates())
    u0=eosU();startS=entropy(allstates())
    maxErr=[0.,0.,0.];maxEnergy=0.;maxCells=len(cells);mixS=0.;elapsed=0.;outlet=[];snapshots=[];holdDelta=0.
    reconstructionS=0.;remapVolume=0.;reconstructionVolume=0.
    for index,s in enumerate(b['strokes']):
        if s['kind']=='hold':
            prior=copy.deepcopy(cells);elapsed+=s['duration_s']
            holdDelta=max(holdDelta,max(abs(x-y) for a,c in zip(cells,prior) for x,y in zip(a,c)))
        else:
            for step in range(steps):
                dm=s['mass_kg']/steps
                if not ordered:
                    beforeS=entropy(cells);beforeV=sum(vol(x) for x in cells)
                    cells=reconstruct(cells,quadrature)
                    reconstructionS+=entropy(cells)-beforeS
                    reconstructionVolume+=sum(vol(x) for x in cells)-beforeV
                if s['kind']=='admit':
                    donor=sources[s['source']]
                    if dm>=donor[0]:raise ValueError('Finite source exhausted')
                    moved=scaled(donor,dm);sources[s['source']]=[donor[i]-moved[i] for i in range(3)]
                    cells=[moved]+cells
                else:
                    cells,delivered=withdraw(cells,dm);outlet.extend(delivered)
                    receiver=add(receiver,totals(delivered))
                if not ordered:
                    beforeV=sum(vol(x) for x in cells)
                    cells,ds=remap(cells,n);mixS+=ds
                    remapVolume+=sum(vol(x) for x in cells)-beforeV
                if sum(vol(x) for x in cells)>=b['vesselVolume_m3']:raise ValueError('Full liquid boundary')
                maxCells=max(maxCells,len(cells));elapsed+=dm/b['strokeRate_kg_s']
                t=totals(allstates());v=sum(vol(x) for x in allstates());u=eosU()
                # Each finite reservoir/vessel has a constant-pressure piston.
                # Port enthalpy already includes flow work; external piston work
                # on the whole closed material set is -p*(Vtotal-Vtotal0).
                maxEnergy=max(maxEnergy,abs(u-u0+p*(v-v0)))
                maxErr=[max(maxErr[i],abs(t[i]-start[i])) for i in range(3)]
        snapshots.append(dict(stroke=index,kind=s['kind'],elapsed_s=elapsed,liquidMass_kg=sum(x[0] for x in cells),
            level_m=sum(vol(x) for x in cells)/b['area_m2'],bottomTemperature_K=state(cells[0][1]/cells[0][0])[1],
            topTemperature_K=state(cells[-1][1]/cells[-1][0])[1]))
    if maxErr[0]>1e-6 or maxErr[1]>.5 or maxErr[2]>1e-7 or maxEnergy>.5:
        raise ValueError('Finite donor/vessel/receiver ledger failed')
    if not ordered and maxCells>n:raise ValueError('Persistent representation grew beyond spatial bands')
    return dict(bands=n,subdivisions=steps,quadrature=quadrature,orderedMaterial=ordered,maximumPersistentCells=maxCells,
        maximumMassResidual_kg=maxErr[0],maximumEnthalpyResidual_J=maxErr[1],maximumBoronResidual_kg=maxErr[2],
        maximumInternalEnergyPlusPistonWorkResidual_J=maxEnergy,remapAverageEntropyIncrease_J_K=mixS,
        reconstructionAverageEntropyChange_J_K=reconstructionS,closedSetEntropyChange_J_K=entropy(allstates())-startS,
        cumulativeRemapVolumeChange_m3=remapVolume,cumulativeReconstructionVolumeChange_m3=reconstructionVolume,
        holdStateChange=holdDelta,withdrawnEnthalpy_J=sum(x[1] for x in outlet),snapshots=snapshots,
        outlet=outlet,finalCells=cells)

exact=run(1,1,ordered=True)
# Independent literal source order, not a second call to withdraw(): first cold
#1500, then warm2000/cold1000/original500. Also catches wrong boron donors.
expected=[(1500,b['cold']), (2000,b['warm']), (1000,b['cold']), (500,b['initial'])]
if len(exact['outlet'])!=len(expected):raise ValueError('Analytic outlet sequence length differs')
for actual,(mass,f) in zip(exact['outlet'],expected):
    if abs(actual[0]-mass)>1e-6 or abs(actual[1]/mass-enthalpy(f['temperature_K']))>1e-5 or abs(actual[2]-mass*f['boron_ppm']*1e-6)>1e-9:
        raise ValueError('Independent analytical bottom-donor sequence failed')
try:contact_run(b['bands'][0],b['subdivisions'][0],limit=2)
except ValueError as error:
    if 'Contact capacity exceeded' not in str(error):raise
    rejectedTwoSubcellReason=str(error)
else:raise ValueError('Two-subcell benchmark unexpectedly fits: review geometry/comparator')
contactRows=[]
for subdivisions in [*b['subdivisions'],b['costSubdivisions']]:
    started=time.perf_counter();r=contact_run(b['bands'][0],subdivisions);r['wallSeconds']=time.perf_counter()-started
    r.update(outlet_error(r['outlet'],exact['outlet']))
    r['relativeWithdrawnEnthalpyError']=abs(r['withdrawnEnthalpy_J']/exact['withdrawnEnthalpy_J']-1)
    r['withinUnchangedAccuracyScreens']=(r['meanAbsoluteTemperatureError_K']<=b['maximumOutletMeanAbsoluteError_K'] and
        r['relativeWithdrawnEnthalpyError']<=b['maximumRelativeWithdrawnEnthalpyError'])
    if r['meanAbsoluteBoronFractionError']>1e-12 or abs(sum(x[2] for x in r['outlet'])-sum(x[2] for x in exact['outlet']))>1e-9:
        raise ValueError('Contact withdrawal boron donor history differs from analytical reference')
    r.pop('outlet');r.pop('finalBands');contactRows.append(r)
checkpoint=contact_run(b['bands'][0],b['subdivisions'][1])
restored=contact_run(b['bands'][0],b['subdivisions'][1],roundtrip=True)
if checkpoint!=restored:raise ValueError('Contact-state serialization changed accepted trajectory')
if restored['maximumSubcellsPerBand']<2:raise ValueError('Restore test never exercised an actual contact')
uniformContact=contact_run(b['bands'][0],b['subdivisions'][0],uniform=True)
if any(abs(state(x[1]/x[0])[1]-b['initial']['temperature_K'])>1e-7 for band in uniformContact['finalBands'] for x in band):
    raise ValueError('Contact uniform-state invariance failed')
# Deliberate four-state occupancy tests representability, not a physical limit.
overload=[parcel(1,enthalpy(b[k]['temperature_K']),b[k]['boron_ppm']*1e-6) for k in ['cold','warm','initial']]+[parcel(1,enthalpy(500),.0003)]
before=copy.deepcopy(overload)
try:contact_remap(overload,b['bands'][0])
except ValueError as error:
    if 'Contact capacity exceeded' not in str(error):raise
else:raise ValueError('Contact overflow silently accepted')
if overload!=before:raise ValueError('Rejected contact remap mutated accepted input')
def must_reject_contact(label,materials):
    try:contact_remap(materials,b['bands'][0])
    except ValueError as error:
        if 'Contact capacity exceeded' not in str(error):raise
    else:raise ValueError('Unrepresentable contact state accepted: '+label)
# Repeated short alternating admissions cannot grow a persistent material list.
must_reject_contact('alternating admissions',[overload[i%2].copy() for i in range(20)])
# A resolved smooth profile cannot be projected to two states without an explicit
# approximation. Refuse it instead of claiming general wall-heating support.
gradient=[parcel(1,enthalpy(500+i*.1),.0006) for i in range(8)]
must_reject_contact('smooth within-band profile',gradient)
splitChecks={'maximumRelativeLedgerResidual':0.,'maximumEnthalpyRatioResidual_J_kg':0.,'maximumBoronRatioResidual':0.}
donor=parcel(5000,enthalpy(520),.0006)
for exponent in [1,10,20,30,40]:
    remainder=scaled(donor,donor[0]*2.**(-exponent));removed=scaled(donor,donor[0]-remainder[0])
    combined=add(remainder,removed)
    for j in range(3):
        error=abs(combined[j]-donor[j])/abs(donor[j])
        splitChecks['maximumRelativeLedgerResidual']=max(splitChecks['maximumRelativeLedgerResidual'],error)
        if error>8*math.ulp(1.):raise ValueError('Conditioned split lost conserved inventory')
    for j,key in [(1,'maximumEnthalpyRatioResidual_J_kg'),(2,'maximumBoronRatioResidual')]:
        error=abs(remainder[j]/remainder[0]-donor[j]/donor[0]);splitChecks[key]=max(splitChecks[key],error)
        if error>4*math.ulp(donor[j]/donor[0]):raise ValueError('Conditioned split fabricated a different state')
if scaled(donor,0.)!=[0.,0.,0.]:raise ValueError('Zero split retained ghost inventory')
try:contact_remap([scaled(donor,0.)],b['bands'][0])
except ValueError as error:
    if 'Empty liquid boundary' not in str(error):raise
else:raise ValueError('Zero contact state silently retained')
contactRejected=[]
for label,case in [('phase',lambda:state(hs)),('temperature',lambda:enthalpy(ts+1)),
    ('full',lambda:contact_remap([scaled(donor,2*b['vesselVolume_m3']/state(donor[1]/donor[0])[0])],b['bands'][0])),
    ('emptyWithdrawal',lambda:withdraw([donor],donor[0]))]:
    try:case()
    except ValueError:contactRejected.append(label)
    else:raise ValueError('Unsupported contact boundary silently accepted: '+label)
contactChecks=dict(checkpointRoundtrip=True,uniform=True,capacityOverflowRejected=True,rejectedInputUnchanged=True,
    alternatingAdmissionOverflowRejected=True,smoothWithinBandProfileRejected=True,rejectedTwoSubcellReason=rejectedTwoSubcellReason,
    conditionedSplit=splitChecks,zeroSplitRejected=True,unsupportedBoundariesRejected=contactRejected)
if len(sys.argv)>1 and sys.argv[1]=='contact':
    print(json.dumps(dict(scope='Bounded two-contact-per-spatial-band isobaric piston reference only',
        python=platform.python_version(),CoolProp=CoolProp.__version__,propertyBackend='HEOS::Water',
        exactOrderedMaterial=exact,boundedContact=contactRows,contactChecks=contactChecks,contactCoalescing=contactCoalescing,
        coupledPZRQualified=False),allow_nan=False))
    sys.exit(0)
rows=[]
# Independent spatial and stroke refinement, with the common corner run only once.
levels=[(n,b['subdivisions'][-1]) for n in b['bands']]+[(b['bands'][-1],s) for s in b['subdivisions'][:-1]]
for q in [1,8]:
  for n,s in levels:
    result=run(n,s,quadrature=q);result.update(outlet_error(result['outlet'],exact['outlet']))
    result['relativeWithdrawnEnthalpyError']=abs(result['withdrawnEnthalpy_J']/exact['withdrawnEnthalpy_J']-1)
    result['entropyChangeExcessOverOrdered_J_K']=result['closedSetEntropyChange_J_K']-exact['closedSetEntropyChange_J_K']
    result.pop('outlet');result.pop('finalCells');rows.append(result)
quad=run(b['bands'][-1],b['subdivisions'][-1],quadrature=16)
quad.update(outlet_error(quad['outlet'],exact['outlet']));quad.pop('outlet');quad.pop('finalCells')
cost=[]
for n,s in [(n,b['subdivisions'][-1]) for n in b['costBands']]+[(b['costBands'][-1],b['costSubdivisions'])]:
    started=time.perf_counter();r=run(n,s,quadrature=8);r['wallSeconds']=time.perf_counter()-started
    r.update(outlet_error(r['outlet'],exact['outlet']))
    r['relativeWithdrawnEnthalpyError']=abs(r['withdrawnEnthalpy_J']/exact['withdrawnEnthalpy_J']-1)
    r['withinUnchangedAccuracyScreens']=(r['meanAbsoluteTemperatureError_K']<=b['maximumOutletMeanAbsoluteError_K'] and
        r['relativeWithdrawnEnthalpyError']<=b['maximumRelativeWithdrawnEnthalpyError'])
    r.pop('outlet');r.pop('finalCells');cost.append(r)
finest=next(x for x in rows if x['bands']==b['bands'][-1] and x['subdivisions']==b['subdivisions'][-1] and x['quadrature']==8)
uniform=run(b['bands'][-1],b['subdivisions'][0],uniform=True,quadrature=8)
uniformError=max(abs(state(c[1]/c[0])[1]-b['initial']['temperature_K']) for c in uniform['finalCells'])
if uniformError>1e-7 or uniform['holdStateChange']!=0:raise ValueError('Uniform/hold invariance failed')
rejected=[]
for name,case in [('empty',lambda:withdraw(exact['finalCells'],sum(x[0] for x in exact['finalCells']))),
    ('full',lambda:remap([parcel(2*b['vesselVolume_m3']/state(enthalpy(570))[0],enthalpy(570),0)],48)),
    ('phase',lambda:state(hs)),('temperature',lambda:enthalpy(ts+1))]:
    try:case()
    except ValueError:rejected.append(name)
    else:raise ValueError('Unsupported boundary silently accepted: '+name)
spatial=[x for x in rows if x['subdivisions']==b['subdivisions'][-1] and x['quadrature']==8]
passed=(finest['meanAbsoluteTemperatureError_K']<=b['maximumOutletMeanAbsoluteError_K'] and
    finest['relativeWithdrawnEnthalpyError']<=b['maximumRelativeWithdrawnEnthalpyError'] and
    spatial[-1]['meanAbsoluteTemperatureError_K']<spatial[0]['meanAbsoluteTemperatureError_K'])
exact.pop('finalCells')
print(json.dumps(dict(scope='Isobaric zero-gravity1D piston/advection liquid-history reference, not installed PZR dynamics',
    python=platform.python_version(),CoolProp=CoolProp.__version__,propertyBackend='HEOS::Water',
    saturationTemperature_K=ts,exactOrderedMaterial=exact,refinement=rows,quadratureCheck=quad,resolutionCost=cost,
    boundedContact=contactRows,contactChecks=contactChecks,contactCoalescing=contactCoalescing,
    uniformTemperatureError_K=uniformError,rejectedBoundaries=rejected,propertyChecks=propertyChecks,
    numericalTransportGatePassed=passed,coupledPZRQualified=False),allow_nan=False))
`}`

if (import.meta.main) {
  const [page, python, output, study = 'all'] = process.argv.slice(2)
  if (!page || !python || process.argv.length > 6 || !['all', 'contact'].includes(study))
    throw Error('Usage: reference-design-pressurizer-transport.ts owner.md python [evidence.json] [all|contact]')
  const input = parseTransportBasis(await Bun.file(page).text())
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const sourceHash = hash(await Bun.file(import.meta.path).text())
  const child = Bun.spawn([python, '-c', transportCalculation, study], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const result = { input, inputHash: hash(JSON.stringify(input)), sourceHash, calculationHash: hash(transportCalculation), ...JSON.parse(out) }
  if (output) await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
