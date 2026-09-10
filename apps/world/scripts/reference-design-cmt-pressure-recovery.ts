/** Offline density-first scalar pressure recovery; no transport or installed plant solver. */
import { createHash } from 'node:crypto'
import { parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry.ts'
import { reconstructionMesh, reconstructionSetup } from './reference-design-cmt-reconstruction.ts'

export const pressureRecoveryCalculation = reconstructionSetup + String.raw`
from scipy.optimize import brentq
from CoolProp import DmassP_INPUTS,iUmass,iP,iDmass
PLO,PHI=data['centerPressureInterval_Pa']
if not 0<PLO<PHI:raise ValueError('Invalid declared pressure interval')

def density_props(rho,p):
    if not math.isfinite(rho) or rho<=0:raise ValueError('Nonpositive or invalid reconstructed density')
    water.update(DmassP_INPUTS,float(rho),float(p))
    if water.phase()!=CoolProp.iphase_liquid:raise ValueError('Reconstructed state outside admitted liquid domain')
    derivative=water.first_partial_deriv(iUmass,iP,iDmass)
    if not math.isfinite(derivative) or derivative<=0:raise ValueError('Nonmonotone or invalid liquid energy derivative')
    return water.umass(),water.T(),derivative

def recover(mesh,native):
    # Native inventories and geometry are the entire information interface.
    if len(native)!=len(mesh['cells']):raise ValueError('Native inventory count mismatch')
    cells,S,_=prepared(mesh);mean=np.array([M/c['V'] for c,(M,U) in zip(cells,native)])
    if not np.all(np.isfinite(native)) or np.any(mean<=0):raise ValueError('Invalid native inventory')
    slopes=S@mean;fields=[]
    for c,rhoc,slope,(M,U) in zip(cells,mean,slopes,native):
        def rho(z):return rhoc+slope*(z-c['z'])
        def offset(z):
            x=z-c['z'];return -g*(rhoc*x+.5*slope*x*x)
        locations=sorted(set(c['nodes'].tolist()+[c['lo'],c['z'],c['hi']]))
        for face in mesh['faces']:
            if mesh['cells'][face['left']] is c['c'] or mesh['cells'][face['right']] is c['c']:locations+=face['sampleHeights_m']
        # Check the declared interval, not a guessed/adaptively widened pressure bracket.
        minDerivative=float('inf');minTemperature=float('inf');maxTemperature=-float('inf')
        for pc in np.linspace(PLO,PHI,9):
            for z in locations:
                u,T,du=density_props(rho(z),pc+offset(z));minDerivative=min(minDerivative,du)
                minTemperature=min(minTemperature,T);maxTemperature=max(maxTemperature,T)
        def energy(pc,order=8):
            return integral(c['c'],lambda z,A,Ap:rho(z)*density_props(rho(z),pc+offset(z))[0]*A,order)
        lower=energy(PLO)-U;upper=energy(PHI)-U
        if not lower<=0<=upper:raise ValueError('Native energy outside declared liquid pressure bracket')
        pc=brentq(lambda p:energy(p)-U,PLO,PHI,xtol=1e-6,rtol=1e-14)
        derivative=integral(c['c'],lambda z,A,Ap:rho(z)*density_props(rho(z),pc+offset(z))[2]*A,8)
        # Retain coefficients as values; no closures over the loop's changing cell.
        fields.append(dict(pc=pc,rhoc=rhoc,slope=slope,z=c['z'],M=integral(c['c'],lambda z,A,Ap:rho(z)*A,8),U=energy(pc),
            lowerEnergyResidual_J=lower,upperEnergyResidual_J=upper,minimumSampledSpecificDerivative_J_kg_Pa=minDerivative,
            pressureSensitivity_Pa_per_J_kg=M/derivative,minimumSampledTemperature_K=minTemperature,maximumSampledTemperature_K=maxTemperature))
    return cells,fields

def state(f,z):
    x=z-f['z'];rho=f['rhoc']+f['slope']*x;p=f['pc']-g*(f['rhoc']*x+.5*f['slope']*x*x)
    return rho,p,*density_props(rho,p)

def audit(mesh,native,p,T):
    cells,fields=recover(mesh,native);pError=tError=massError=energyError=forceError=faceJump=0.
    for c,f,(M,U) in zip(cells,fields,native):
        massError=max(massError,abs(integral(c['c'],lambda z,A,Ap:state(f,z)[0]*A,16)-M))
        energyError=max(energyError,abs(integral(c['c'],lambda z,A,Ap:state(f,z)[0]*state(f,z)[2]*A,16)-U))
        for z in [c['lo'],c['z'],c['hi']]:
            pError=max(pError,abs(state(f,z)[1]-p(z)));tError=max(tError,abs(state(f,z)[3]-T(z)))
        reaction=0.
        for q in c['c']['pieces']:
            lo,hi=q['lo'],q['hi'];pressure=lambda z:state(f,z)[1]-f['pc']
            reaction+=pressure(lo)*shape(q,lo)[0]-pressure(hi)*shape(q,hi)[0]+quad(lambda z:pressure(z)*shape(q,z)[1],lo,hi,epsabs=1e-7)[0]
        forceError=max(forceError,abs(reaction-g*M))
    for face in mesh['faces']:
        a,b=fields[face['left']],fields[face['right']]
        faceJump=max(faceJump,max(abs(state(a,z)[1]-state(b,z)[1]) for z in face['sampleHeights_m']))
    check('density-first independent native mass kg',massError,1e-6);check('density-first independent native energy J',energyError,.1)
    check('density-first full cut-cell pressure reaction N',forceError,.001)
    # Independent pressure sensitivity derivative through symmetric energy differences at one representative cell.
    i=max(range(len(cells)),key=lambda i:cells[i]['V']);c,f=cells[i],fields[i]
    def e(delta):return integral(c['c'],lambda z,A,Ap:state(f,z)[0]*density_props(state(f,z)[0],state(f,z)[1]+delta)[0]*A,16)
    d=(e(100)-e(-100))/200;pred=native[i][0]/f['pressureSensitivity_Pa_per_J_kg']
    check('specific EOS derivative versus independent energy difference relative',(d-pred)/pred,1e-6)
    return dict(cells=len(cells),maximumPressureError_Pa=pError,maximumTemperatureError_K=tError,
        maximumActualFacePressureJump_Pa=faceJump,maximumIndependentMassResidual_kg=massError,maximumIndependentEnergyResidual_J=energyError,
        maximumFullBoundaryForceResidual_N=forceError,minimumSpecificDerivative_J_kg_Pa=min(f['minimumSampledSpecificDerivative_J_kg_Pa'] for f in fields),
        sampledTemperatureRange_K=[min(f['minimumSampledTemperature_K'] for f in fields),max(f['maximumSampledTemperature_K'] for f in fields)],
        centerPressureRange_Pa=[min(f['pc'] for f in fields),max(f['pc'] for f in fields)],
        bracketEnergyResidualRange_J=[min(f['lowerEnergyResidual_J'] for f in fields),max(f['upperEnergyResidual_J'] for f in fields)],
        pressureSensitivityRange_Pa_per_J_kg=[min(f['pressureSensitivity_Pa_per_J_kg'] for f in fields),max(f['pressureSensitivity_Pa_per_J_kg'] for f in fields)],
        maximumResidualToExisting100PaExcitation=faceJump/100),cells,fields

profiles=[]
cases=[('cold',lambda z:cold,p0),('hot-top',lambda z:cold+(hot-cold)*(z-zlo)/(ztop-zlo),p0),
    ('hot-bottom',lambda z:hot-(hot-cold)*(z-zlo)/(ztop-zlo),p0),
    ('withheld-quadratic-temperature',lambda z:cold+(hot-cold)*((z-zlo)/(ztop-zlo))**2,p0),
    ('withheld-nonpolynomial-temperature',lambda z:cold+(hot-cold)*((z-zlo)/(ztop-zlo)+.07*math.sin(2*math.pi*(z-zlo)/(ztop-zlo))),p0),
    ('shifted-pressure-and-temperature',lambda z:cold+2+(hot-cold-4)*(z-zlo)/(ztop-zlo),p0+200000),
    ('grid-aligned-contact',lambda z:cold if z<8 else hot,p0)]
for label,T,pTop in cases:
    results=[]
    for mesh in data['meshes']:
        print(label+' '+str(len(mesh['cells']))+' cells',file=sys.stderr,flush=True)
        native,p=exact_native(mesh,T,pTop)
        try:result,_,_=audit(mesh,native,p,T);results.append(dict(status='recovered',**result))
        except ValueError as error:
            if label!='grid-aligned-contact':raise
            results.append(dict(status='rejected',reason=str(error),cells=len(mesh['cells'])))
    profiles.append(dict(name=label,unchangedAnalyticInventories=True,
        accuracyAssessment='qualitative domain challenge only; continuous ODE initializer not segmented at contact' if label=='grid-aligned-contact' else 'independent analytic inventory comparison',meshes=results))
# A compatible density field is a separate fixture, never a replacement of the original analytic M/U.
compatible=[];rhob=props(p0,cold)[0];rhot=props(p0,hot)[0];slope=(rhot-rhob)/(ztop-zlo)
def compatible_p(z):return p0+g*(rhob*(ztop-z)+.5*slope*((ztop-zlo)**2-(z-zlo)**2))
def compatible_rho(z):return rhob+slope*(z-zlo)
def compatible_T(z):return density_props(compatible_rho(z),compatible_p(z))[1]
for mesh in data['meshes']:
    native=[(integral(c,lambda z,A,Ap:compatible_rho(z)*A,16),
        integral(c,lambda z,A,Ap:compatible_rho(z)*density_props(compatible_rho(z),compatible_p(z))[0]*A,16)) for c in mesh['cells']]
    result,cells,fields=audit(mesh,native,compatible_p,compatible_T)
    check('compatible density equilibrium pressure recovered independently Pa',result['maximumPressureError_Pa'],.1)
    check('compatible density equilibrium actual face agreement Pa',result['maximumActualFacePressureJump_Pa'],.1)
    face=max(mesh['faces'],key=lambda f:min(mesh['cells'][f['left']]['volume_m3'],mesh['cells'][f['right']]['volume_m3']))
    i,j=face['left'],face['right'];changed=list(native);changed[i]=(native[i][0],native[i][1]-10000);changed[j]=(native[j][0],native[j][1]+10000)
    _,perturbed=recover(mesh,changed)
    total=sum(f['U']-U for f,(M,U) in zip(perturbed,native));check('finite local heat exchange total energy retained J',total,.1)
    mass=max(abs(f['M']-M) for f,(M,U) in zip(perturbed,changed));check('finite local heat exchange native mass retained kg',mass,1e-6)
    energy=max(abs(f['U']-U) for f,(M,U) in zip(perturbed,changed));check('finite local heat exchange individual energy retained J',energy,.1)
    untouched=max(abs(a['pc']-b['pc']) for k,(a,b) in enumerate(zip(fields,perturbed)) if k not in [i,j]);check('unchanged cells not globally re-equilibrated Pa',untouched,1e-6)
    jump=max(abs(state(perturbed[i],z)[1]-state(perturbed[j],z)[1]) for z in face['sampleHeights_m'])
    if jump<1:raise ValueError('Finite heat exchange erased')
    compatible.append(dict(**result,localHeatExchange_J=10000,localHeatExchangeFaceJump_Pa=jump,totalEnergyResidual_J=total,
        unchangedCellMaximumPressureChange_Pa=untouched,donorCell=i,receiverCell=j))
# Reject energy outside the declared interval rather than clamping pressure or inventing a fallback.
mesh=data['meshes'][0];native,_=exact_native(mesh,lambda z:cold,p0)
for label,bad in [('negative-mass',[(-1,native[0][1])]+native[1:]),('wrong-count',native[:-1]),
    ('nonfinite-energy',[(native[0][0],float('nan'))]+native[1:]),('unbracketed-energy',[(native[0][0],native[0][1]+1e12)]+native[1:])]:
    try:recover(mesh,bad)
    except ValueError as error:checks.append(dict(name=label,rejected=True,reason=str(error)))
    else:raise ValueError(label+' unexpectedly accepted')
print(json.dumps(dict(scope='Density-first scalar pressure recovery only; no advancing nonlinear fluid operator',
    versions=dict(CoolProp=CoolProp.__version__,numpy=np.__version__,scipy=scipy.__version__),
    declaredCenterPressureInterval_Pa=[PLO,PHI],profiles=profiles,compatibleDensityFixture=compatible,checks=checks,
    verificationChecksPassed=True,verificationScope='Smooth and compatible fixtures retain M/U and local force; adversarial inputs rejected. This is not a general pressure-fidelity pass.',
    nonlinearTransportQualified=False,generalAnalyticProfileRecoveryQualified=False),allow_nan=False))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: reference-design-cmt-pressure-recovery.ts geometry-owner.md python')
  const document = await Bun.file(owner).text(), geometry = parseGeometryBasis(document), basis = parseAcousticBasis(document)
  const input = { basis, geometry, mouth_m: tankGeometry(geometry).mouth, centerPressureInterval_Pa: [10e6, 20e6],
    meshes: [reconstructionMesh(geometry), reconstructionMesh(geometry, true)] }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const files = ['reference-design-cmt-reconstruction.ts', 'reference-design-cmt-hydrostatic.ts', 'reference-design-cmt-acoustics.ts', 'reference-design-cmt-geometry.ts']
  const identity = { inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    sharedSourceHashes: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await Bun.file(new URL(file, import.meta.url)).text())]))),
    calculationHash: hash(pressureRecoveryCalculation) }
  const child = Bun.spawn([python, '-c', pressureRecoveryCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT density-first pressure recovery failed')
  console.log(JSON.stringify({ input, ...identity, ...JSON.parse(stdout) }, null, 2))
}
