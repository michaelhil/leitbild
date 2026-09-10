/** Finite-owner, affine boundary-transfer reference; not a live PZR solver. */
import { createHash } from 'node:crypto'
import { gradientProfileFunctions } from './reference-design-pressurizer-gradient'
import { parseTransportBasis, transportProperties } from './reference-design-pressurizer-transport'

export const boundaryCalculation = `${transportProperties}${gradientProfileFunctions}${String.raw`
# Boundary histories are integrated over transferred MASS, not point samples
# of temperature. h is affine; T is obtained from the water EOS. A declared
# material jump is distinct from a numerical interval seam, including B-only
# jumps. Incoming chronology reverses into bottom-to-top vessel coordinates.
def reversed_profile(s):
    return dict(m=s['m'],h=[sum(s['h']),-s['h'][1]],
        c=[sum(s['c']),-s['c'][1]],contact=False)
def joined_inlet(arrivals,old,contact,trace):
    if not contact:
        # Validation of an explicitly declared continuous face, not a detector
        # that turns arbitrary sampled differences into contacts.
        for k in ('h','c'):
            a=arrivals[0][k][0];z=trace[k]
            if abs(a-z)>128*math.ulp(max(abs(a),abs(z))):
                raise ValueError('Declared continuous inlet does not match accepted material face')
    incoming=[]
    for i in range(len(arrivals)-1,-1,-1):
        s=reversed_profile(arrivals[i])
        s['contact']=i+1<len(arrivals) and arrivals[i+1]['contact']
        incoming.append(s)
    tail=copy.deepcopy(old);tail[0]['contact']=contact
    return incoming+tail
def inventory(s):return conserved([*s['vessel'],*s['source'],s['receiver']])
def owners(s):return [*s['vessel'],*s['source'],s['receiver']]
def make_state(n,kind):
    h0=enthalpy(b['initial']['temperature_K']);h1=enthalpy(b['cold']['temperature_K'])
    c0=b['initial']['boron_ppm']*1e-6;c1=b['cold']['boron_ppm']*1e-6
    m=b['sourceMass_kg']
    if kind in ('smooth','matched-affine'):
        if kind=='matched-affine':h1=h0+(h1-h0)/20;c1=c0
        source=[dict(m=m,h=[h0,h1-h0],c=[c0,c1-c0],contact=False)]
    elif kind=='boron-jump':
        source=[dict(m=m/2,h=[h0,(h1-h0)/2],c=[c0,0.],contact=False),
            dict(m=m/2,h=[(h0+h1)/2,(h1-h0)/2],c=[c0/2,0.],contact=True)]
    else:raise ValueError('Unknown manufactured history')
    for key in projection:projection[key]=0.
    if kind=='matched-affine':
        slope=(h0-h1)/m
        mass=brentq(lambda mass:eos([dict(m=mass,h=[h0,slope*mass],c=[c0,0.],contact=False)],16)[0]-b['initialVolume_m3'],
            1.,b['initialVolume_m3']/state(h0)[0])
        vessel,_=remap_profiles([dict(m=mass,h=[h0,slope*mass],c=[c0,0.],contact=False)],n)
    else:vessel,_=remap_profiles([constant(b['initialVolume_m3']/state(h0)[0],h0,c0)],n)
    return dict(vessel=vessel,source=source,receiver=constant(b['receiverMass_kg'],h0,c0),
        projection=copy.deepcopy(projection),outlet=[],admitted_kg=0.,withdrawn_kg=0.,
        acceptedTransfers=0,maximumRegions=len(vessel),maximumRegionsPerBand=1,
        boundaryTrace=dict(h=h0,c=c0),maximumContinuousTraceDifference_ulps=0.)
def transfer(accepted,n,kind,dm,contact=False,q=8):
    # All physical owners, accepted diagnostic ledgers and evidence output
    # belong to ONE trial. Rejection publishes none of them.
    candidate=copy.deepcopy(accepted);saved=copy.deepcopy(projection)
    try:
        projection.update(candidate['projection'])
        if kind=='admit':
            total=conserved(candidate['source'])[0]
            if not 0<dm<total:raise ValueError('Finite donor exhausted')
            arrivals=subset(candidate['source'],0.,dm)
            candidate['source']=subset(candidate['source'],dm,total)
            if not contact:
                for k in ('h','c'):
                    a=arrivals[0][k][0];z=candidate['boundaryTrace'][k]
                    candidate['maximumContinuousTraceDifference_ulps']=max(candidate['maximumContinuousTraceDifference_ulps'],abs(a-z)/math.ulp(max(abs(a),abs(z))))
            candidate['vessel']=joined_inlet(arrivals,candidate['vessel'],contact,candidate['boundaryTrace'])
            candidate['boundaryTrace']={k:sum(arrivals[-1][k]) for k in ('h','c')}
            candidate['admitted_kg']+=dm
        elif kind=='withdraw':
            candidate['vessel'],out=remove(candidate['vessel'],dm)
            amounts=conserved([candidate['receiver'],*out])
            candidate['receiver']=constant(amounts[0],amounts[1]/amounts[0],amounts[2]/amounts[0])
            candidate['outlet'].extend(out);candidate['withdrawn_kg']+=dm
        else:raise ValueError('Unknown transfer direction')
        candidate['vessel'],local=remap_profiles(candidate['vessel'],n,q)
        if kind=='withdraw':candidate['boundaryTrace']={k:candidate['vessel'][0][k][0] for k in ('h','c')}
        candidate['projection']=copy.deepcopy(projection)
        candidate['acceptedTransfers']+=1
        candidate['maximumRegions']=max(candidate['maximumRegions'],len(candidate['vessel']))
        candidate['maximumRegionsPerBand']=max(candidate['maximumRegionsPerBand'],local)
        before=inventory(accepted);after=inventory(candidate)
        if any(abs(a-z)>tol for a,z,tol in zip(before,after,[1e-6,.5,1e-7])):
            raise ValueError('Transfer changed finite-owner inventory')
        return candidate
    finally:projection.update(saved)
def exact_outlet(kind,admitted,withdrawn):
    # Independent closed form in discharged mass, not candidate remap/cuts.
    h0=enthalpy(b['initial']['temperature_K']);h1=enthalpy(b['cold']['temperature_K'])
    c0=b['initial']['boron_ppm']*1e-6;c1=b['cold']['boron_ppm']*1e-6;m=b['sourceMass_kg']
    if kind=='matched-affine':h1=h0+(h1-h0)/20;c1=c0
    boundaries=[0.,admitted]
    if kind=='boron-jump' and admitted>m/2:boundaries.insert(1,admitted-m/2)
    pieces=[]
    for lo,hi in zip(boundaries,boundaries[1:]):
        if kind in ('smooth','matched-affine'):c=[c0+(c1-c0)*(admitted-lo)/m,-(c1-c0)*(hi-lo)/m]
        else:c=[c0/2 if admitted-(lo+hi)/2>m/2 else c0,0.]
        pieces.append(dict(m=hi-lo,h=[h0+(h1-h0)*(admitted-lo)/m,-(h1-h0)*(hi-lo)/m],c=c,contact=lo>0))
    if kind=='matched-affine':pieces.append(dict(m=withdrawn-admitted,h=[h0,(h0-h1)*(withdrawn-admitted)/m],c=[c0,0.],contact=False))
    else:pieces.append(constant(withdrawn-admitted,h0,c0,False))
    return pieces
def experiment(n,steps,kind,q=8,restore=False):
    accepted=make_state(n,kind);initial=inventory(accepted);v0,_,u0=eos(owners(accepted),q)
    # Retain finite source inventory; withdraw through all admitted material
    # and 500 kg of original vessel water. Zero-flow holds are genuine no-ops.
    admitted=.9*b['sourceMass_kg'];withdrawn=admitted+500.
    for i in range(steps):
        accepted=transfer(accepted,n,'admit',admitted/steps,accepted['source'][0]['contact'],q)
        if restore:accepted=json.loads(json.dumps(accepted))
    afterInlet=copy.deepcopy(accepted)
    for i in range(steps):
        accepted=transfer(accepted,n,'withdraw',withdrawn/steps,q=q)
        if restore:accepted=json.loads(json.dumps(accepted))
    now=inventory(accepted);v,_,u=eos(owners(accepted),q)
    errors=[abs(now[0]-initial[0]),abs(now[1]-initial[1]),abs(now[2]-initial[2]),abs(u-u0+p*(v-v0))]
    if any(x>tol for x,tol in zip(errors,[1e-6,.5,1e-7,.5])):raise ValueError('Finite-owner ledger failed '+str(errors))
    comparison=compare(accepted['outlet'],exact_outlet(kind,admitted,withdrawn))
    passed=bool(comparison['meanAbsoluteTemperatureError_K']<=b['maximumOutletMeanAbsoluteError_K'] and comparison['relativeWithdrawnEnthalpyError']<=b['maximumRelativeWithdrawnEnthalpyError'])
    if kind=='matched-affine' and (comparison['maximumSampledTemperatureError_K']>1e-6 or comparison['meanAbsoluteBoronFractionError']>1e-12):
        raise ValueError('Globally affine boundary history changed with subdivision '+str(comparison))
    jumpCheck=None
    if kind=='boron-jump':
        jump=admitted-b['sourceMass_kg']/2;c0=b['initial']['boron_ppm']*1e-6
        def outlet_boron(mass):
            for s in accepted['outlet']:
                if mass<s['m']:return poly(s['c'],mass/s['m'])
                mass-=s['m']
            raise ValueError('Point beyond discharged mass')
        sides=[outlet_boron(jump-.5),outlet_boron(jump+.5)]
        expectedB=jump*c0/2+(withdrawn-jump)*c0
        jumpCheck=dict(beforeFraction=sides[0],afterFraction=sides[1],withdrawnBoron_kg=conserved(accepted['outlet'])[2],expectedWithdrawnBoron_kg=expectedB)
        if comparison['meanAbsoluteBoronFractionError']>1e-12 or abs(sides[0]-c0/2)>1e-12 or abs(sides[1]-c0)>1e-12 or abs(jumpCheck['withdrawnBoron_kg']-expectedB)>1e-8:
            raise ValueError('Boron-only contact lost its independent withdrawal signature')
    if accepted['maximumRegions']>3*n:raise ValueError('Unbounded spatial material state')
    return dict(bands=n,subdivisions=steps,history=kind,quadrature=q,**comparison,passesFrozenHistoryScreens=passed,
        maximumRegions=accepted['maximumRegions'],maximumRegionsPerBand=accepted['maximumRegionsPerBand'],
        massResidual_kg=errors[0],enthalpyResidual_J=errors[1],boronResidual_kg=errors[2],
        internalEnergyPlusPistonWorkResidual_J=errors[3],projection=accepted['projection'],
        maximumContinuousTraceDifference_ulps=accepted['maximumContinuousTraceDifference_ulps'],boronJump=jumpCheck),accepted,afterInlet

rows=[]
for kind in ('matched-affine','smooth','boron-jump'):
    for n,steps in [(48,4),(48,16),(48,64),(96,16)]:
        start=time.perf_counter();row,_,_=experiment(n,steps,kind)
        rows.append(dict(**row,wallSeconds=time.perf_counter()-start))
# One additional remap-frequency challenge because 48/64 approaches the
# unchanged 3 K screen. Preserve a failing result, never relax or tune the gate.
start=time.perf_counter();row,_,_=experiment(48,128,'smooth')
rows.append(dict(**row,wallSeconds=time.perf_counter()-start))
normal,physical,_=experiment(48,16,'boron-jump')
restored,checkpoint,_=experiment(48,16,'boron-jump',restore=True)
if normal!=restored or physical!=checkpoint:raise ValueError('Checkpoint changed boundary/material continuation')
quad,_,_=experiment(48,16,'boron-jump',q=16)
quadDifference=abs(quad['maximumSampledTemperatureError_K']-normal['maximumSampledTemperatureError_K'])
if quadDifference>1e-6:raise ValueError('Boundary quadrature not resolved')

# Start/stop preserves the same affine trace; explicit reversal reconnects
# different material and therefore creates a real contact, not a timestep seam.
s=make_state(48,'smooth');s=transfer(s,48,'admit',1000.)
paused=json.loads(json.dumps(s))
if paused!=s:raise ValueError('Stopped boundary changed state')
s=transfer(paused,48,'admit',1000.)
s=transfer(s,48,'withdraw',500.)
before=copy.deepcopy(s)
try:transfer(s,48,'admit',500.,False)
except ValueError as error:
    if 'continuous inlet' not in str(error):raise
else:raise ValueError('False continuity across reversal was accepted')
if s!=before:raise ValueError('Rejected false continuity mutated accepted state')
s=transfer(s,48,'admit',500.,True)
if not any(x['contact'] for x in s['vessel']):raise ValueError('Reversal interface was lost')
# Reversal alone is NOT a contact event. The matching finite-fluid case stays
# uniform and contains no contact through the same direction changes.
uniform=make_state(48,'smooth')
uniform['source']=[constant(b['sourceMass_kg'],uniform['boundaryTrace']['h'],uniform['boundaryTrace']['c'])]
uniformInitial=inventory(uniform)
for direction,mass in [('admit',1000.),('withdraw',500.),('admit',500.)]:
    uniform=transfer(uniform,48,direction,mass,False)
if any(x['contact'] for x in uniform['vessel']):raise ValueError('Uniform reversal invented a contact')
if any(abs(a-z)>tol for a,z,tol in zip(inventory(uniform),uniformInitial,[1e-6,.5,1e-7])):raise ValueError('Uniform reversal changed inventory')

# A real discontinuity is not classified by size. Keep a sub-roundoff-scale
# B-only contact marker even when that distinction cannot be EOS-resolved.
tiny=make_state(48,'smooth');tiny['source'][0]['c']=[tiny['vessel'][0]['c'][0]+math.ulp(tiny['vessel'][0]['c'][0]),0.]
tiny=transfer(tiny,48,'admit',10.,True)
if not any(x['contact'] for x in tiny['vessel']):raise ValueError('Declared small contact was erased')

# Unsupported multiple sharp contacts must reject atomically, including donor,
# receiver, cumulative output and projection counters, and after JSON restart.
def overloaded():
    x=make_state(48,'smooth');h=enthalpy(500.)
    x['vessel']=[constant(1.,h,0.),constant(1.,h,.001,True),constant(1000.,h,.002,True)]
    x['source']=[constant(100.,h,.003,True)]
    x['boundaryTrace']=dict(h=h,c=0.)
    return x
failures=[]
for late in (False,True):
    for restart in (False,True):
        candidate=overloaded()
        if late:
            h=enthalpy(500.);first=b['vesselVolume_m3']/48/state(h)[0]-1.5
            candidate['vessel'],_=remap_profiles([constant(first,h,0.),constant(1.,h,.001,True),constant(1.,h,.002,True),constant(1000.,h,.003,True)],48)
            candidate['source']=[constant(100.,h,0.)]
        if restart:candidate=json.loads(json.dumps(candidate))
        original=copy.deepcopy(candidate);diagnostics=copy.deepcopy(projection)
        try:transfer(candidate,48,'admit',3. if late else 1.,not late)
        except ValueError as error:failures.append(str(error))
        else:raise ValueError('Unresolved contacts silently mixed or grew')
        if candidate!=original or projection!=diagnostics:raise ValueError('Rejected transfer published partial state')
if failures!=['More than two material contacts in one geometric band']*4:raise ValueError('Restart changed overflow failure')

# Negative comparator: replacing each exact affine interval by its midpoint
# constant does conserve its M/H/B but invents steps and exhausts contact slots.
sampled=make_state(48,'smooth');failedAt=None
for i in range(64):
    original=copy.deepcopy(sampled);dm=.9*b['sourceMass_kg']/64
    interval=subset(sampled['source'],0.,dm)[0]
    moved=constant(dm,integral(interval['h']),integral(interval['c']))
    sourceMass=conserved(sampled['source'])[0]
    sampled['source']=subset(sampled['source'],dm,sourceMass)
    sampled['vessel'][0]['contact']=True
    sampled['vessel']=[moved,*sampled['vessel']]
    try:sampled['vessel'],_=remap_profiles(sampled['vessel'],48)
    except ValueError as error:
        if 'two material contacts' not in str(error):raise
        failedAt=i+1;sampled=original;break
if failedAt is None:raise ValueError('Sampled-constant negative control did not expose false contacts')
print(json.dumps(dict(scope='Finite affine inlet histories and atomic material transfer at fixed pressure; no phase/wall/hydraulic qualification',
    Python=platform.python_version(),CoolProp=CoolProp.__version__,rows=rows,
    quadratureDifference_K=quadDifference,sampledConstantRejectedAtAdmission=failedAt,
    checks=dict(checkpointRoundtrip=True,explicitBoronOnlyContact=True,smallDeclaredContactRetained=True,
        startStopContinuity=True,reversalRequiresActualFaceContinuity=True,uniformReversalHasNoContact=True,atomicOverflowRejection=True,
        restartSameOverflow=True,independentAnalyticWithdrawal=True,finiteOwnerLedgers=True),
    propertyChecks=propertyChecks,coupledPZRQualified=False),allow_nan=False))
`}`

if (import.meta.main) {
  const [page, python, output] = process.argv.slice(2)
  if (!page || !python || process.argv.length > 5)
    throw Error('Usage: reference-design-pressurizer-boundary.ts owner.md python [evidence.json]')
  const input = parseTransportBasis(await Bun.file(page).text())
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  // Capture identities with the dispatched calculation, not after a potentially
  // long experiment while another author could have changed a source file.
  const identity = { input, inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    profileSourceHash: hash(await Bun.file(new URL('./reference-design-pressurizer-gradient.ts', import.meta.url)).text()),
    propertySourceHash: hash(await Bun.file(new URL('./reference-design-pressurizer-transport.ts', import.meta.url)).text()),
    calculationHash: hash(boundaryCalculation) }
  const child = Bun.spawn([python, '-c', boundaryCalculation], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw Error(err)
  const result = { ...identity, ...JSON.parse(out) }
  if (output) await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
