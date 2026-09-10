/** Offline native-M/U smooth hydrostatic reconstruction discriminator, not a flow solver. */
import { createHash } from 'node:crypto'
import { acousticCoordinates, parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import { hydrostaticMesh, hydrostaticSetup } from './reference-design-cmt-hydrostatic.ts'
import { parseGeometryBasis, tankGeometry, type GeometryBasis } from './reference-design-cmt-geometry.ts'

export function reconstructionMesh(b: GeometryBasis, fine = false) {
  const mesh = hydrostaticMesh(b, fine), g = tankGeometry(b), { rr, zz } = acousticCoordinates(b, fine)
  const faces = mesh.faces.map(face => {
    const c = mesh.cells[face.left]!
    if (face.direction === 1) return { ...face, sampleHeights_m: [zz[c.zIndex]!] }
    const r = rr[c.rIndex]!, lower = zz[c.zIndex - 1]!, upper = zz[c.zIndex]!
    const cuts = [...new Set([lower, upper, ...g.breaks([r])])].filter(z => z >= lower && z <= upper).sort((a, b) => a - b)
    const open = cuts.slice(1).map((hi, i) => ({ lo: cuts[i]!, hi })).filter(({ lo, hi }) => g.radialFace(r, lo, hi) > 0)
    const area = open.reduce((sum, { lo, hi }) => sum + 2 * Math.PI * r * (hi - lo), 0)
    if (!open.length || Math.abs(area - face.area_m2) > 1e-10) throw new Error('Incomplete physical radial face traces')
    return { ...face, sampleHeights_m: [...new Set(open.flatMap(({ lo, hi }) => [lo, (lo + hi) / 2, hi]))] }
  })
  return { ...mesh, faces }
}

export const reconstructionSetup = hydrostaticSetup + String.raw`
from scipy.optimize import root

def prepared(mesh,quadratic=False):
    cells=[]
    for c in mesh['cells']:
        V=c['volume_m3'];zc=integral(c,lambda z,A,Ap:z*A,8)/V
        x,w=leggauss(8);nodes=[];weights=[]
        for q in c['pieces']:
            mid=(q['hi']+q['lo'])/2;h=(q['hi']-q['lo'])/2
            nodes.extend(mid+h*x);weights.extend([h*ww*shape(q,mid+h*xx)[0] for xx,ww in zip(x,w)])
        cells.append(dict(c=c,V=V,z=zc,lo=min(q['lo'] for q in c['pieces']),hi=max(q['hi'] for q in c['pieces']),
            nodes=np.array(nodes),weights=np.array(weights)))
    neighbors=[set() for c in cells]
    for f in mesh['faces']:neighbors[f['left']].add(f['right']);neighbors[f['right']].add(f['left'])
    slopes=np.zeros((len(cells),len(cells)));curvatures=np.zeros_like(slopes)
    for i,c in enumerate(cells):
        group=set(neighbors[i]);front=set(group)
        def design(ids):
            dz=np.array([cells[j]['z']-c['z'] for j in ids]);scale=max(abs(dz),default=0.)
            if scale<1e-7:return None,scale
            x=dz/scale;return np.column_stack([x,x*x]) if quadratic else x[:,None],scale
        while True:
            ids=sorted(j for j in group if abs(cells[j]['z']-c['z'])>1e-7)
            A,scale=design(ids)
            if A is not None and np.linalg.matrix_rank(A)==(2 if quadratic else 1):break
            new=set().union(*(neighbors[j] for j in front))-group-{i}
            if not new:raise ValueError('No geometrically independent vertical stencil')
            group|=new;front=new
        weights=np.linalg.pinv(A);a=weights[0]/scale
        c['oneSidedStencil']=not (np.any(A[:,0]<0) and np.any(A[:,0]>0))
        slopes[i,ids]=a;slopes[i,i]=-sum(a)
        if quadratic:
            a=weights[1]/scale**2;curvatures[i,ids]=a;curvatures[i,i]=-sum(a)
    check('stencil annihilates constant',np.max(abs(slopes@np.ones(len(cells)))),1e-12)
    check('stencil reproduces affine temperature gradient',np.max(abs(slopes@np.array([c['z'] for c in cells])-1)),1e-11)
    if quadratic:
        z=np.array([c['z'] for c in cells]);center=z-np.mean(z)
        check('curvature annihilates constant',np.max(abs(curvatures@np.ones(len(cells)))),1e-8)
        check('curvature annihilates affine',np.max(abs(curvatures@center)),1e-8)
        check('curvature reproduces quadratic',np.max(abs(curvatures@(center*center)-1)),1e-8)
    return cells,slopes,curvatures

def field(c,pc,Tc,slope,curvature=0):
    def T(z):return Tc+slope*(z-c['z'])+curvature*(z-c['z'])**2
    def rhs(z,y):return [-g*props(y[0],T(z))[0]]
    low=solve_ivp(rhs,(c['z'],c['lo']),[pc],method='DOP853',rtol=2e-12,atol=1e-6,dense_output=True)
    high=solve_ivp(rhs,(c['z'],c['hi']),[pc],method='DOP853',rtol=2e-12,atol=1e-6,dense_output=True)
    if not low.success or not high.success:raise ValueError('Hydrostatic cell integration failed')
    def p(z):return float((low if z<c['z'] else high).sol(z)[0])
    ru=np.array([props(p(z),T(z)) for z in c['nodes']]);rho=ru[:,0];u=ru[:,1]
    return dict(p=p,T=T,M=float(c['weights']@rho),U=float(c['weights']@(rho*u)),pc=pc,Tc=Tc,slope=slope)

def invert(c,M,U,slope,guess,curvature=0):
    if M<=0 or not math.isfinite(M) or not math.isfinite(U):raise ValueError('Invalid native inventory')
    def residual(x):
        f=field(c,x[0]*1e6,x[1]*1000,slope,curvature)
        return [(f['M']-M)/(c['V']*1000),(f['U']-U)/(c['V']*1e9)]
    sol=root(residual,[guess[0]/1e6,guess[1]/1000],tol=1e-10)
    if np.max(np.abs(residual(sol.x)))>2e-12:raise ValueError('Native inventory inverse failed: '+str(sol.message))
    return field(c,sol.x[0]*1e6,sol.x[1]*1000,slope,curvature)

def reconstruct(mesh,native,quadratic=False,coupled=False):
    # This function receives no initializer field, reference pressure or profile identity.
    if len(native)!=len(mesh['cells']):raise ValueError('Native inventory count differs from mesh')
    cells,S,C=prepared(mesh,quadratic);guesses=[]
    for c,(M,U) in zip(cells,native):
        if M<=0 or not math.isfinite(M) or not math.isfinite(U):raise ValueError('Invalid native inventory')
        water.update(DmassUmass_INPUTS,M/c['V'],U/M)
        if water.phase()!=CoolProp.iphase_liquid:raise ValueError('Native mean outside admitted liquid domain')
        guesses.append([water.p(),water.T()])
    guesses=np.array(guesses);iterations=0
    if coupled:
        # One supported solver comparison: all native M/U constraints solved simultaneously.
        # No analytic-profile guess, handwritten damping, clipping or extra thermodynamic state.
        evaluations=0
        def residual(x):
            nonlocal evaluations
            evaluations+=1;q=np.asarray(x).reshape((-1,2));p=q[:,0]*1e6;T=q[:,1]*1000
            s=S@T;k=C@T
            fields=[field(c,pc,Tc,a,d) for c,pc,Tc,a,d in zip(cells,p,T,s,k)]
            return np.array([[(f['M']-M)/(c['V']*1000),(f['U']-U)/(c['V']*1e9)] for c,f,(M,U) in zip(cells,fields,native)]).ravel()
        initial=guesses/np.array([1e6,1000])
        try:solved=root(residual,initial.ravel(),method='krylov',options={'fatol':2e-12,'maxiter':40})
        except ValueError as error:raise ValueError('Coupled native reconstruction trial rejected after '+str(evaluations)+' residual evaluations: '+str(error)) from error
        if not solved.success or np.max(np.abs(residual(solved.x)))>2e-12:raise ValueError('Coupled native reconstruction rejected: '+solved.message)
        q=solved.x.reshape((-1,2));p=q[:,0]*1e6;T=q[:,1]*1000;s=S@T;k=C@T
        fields=[field(c,pc,Tc,a,d) for c,pc,Tc,a,d in zip(cells,p,T,s,k)]
        return cells,fields,evaluations
    while True:
        gradients=S@guesses[:,1];curvatures=C@guesses[:,1]
        fields=[invert(c,M,U,s,guess,k) for c,(M,U),s,k,guess in zip(cells,native,gradients,curvatures,guesses)]
        new=np.array([[f['pc'],f['Tc']] for f in fields]);iterations+=1
        change=float(np.max(abs(new-guesses),axis=0)[1]);guesses=new
        if change<1e-10:break
        if iterations>=40:raise ValueError('Smooth reconstruction iteration did not converge')
    return cells,fields,iterations

def exact_native(mesh,T,pTop):
    sol=solve_ivp(lambda z,y:[-g*props(y[0],T(z))[0]],(ztop,zlo),[pTop],method='DOP853',rtol=1e-12,atol=1e-6,dense_output=True)
    if not sol.success:raise ValueError(sol.message)
    p=lambda z:float(sol.sol(z)[0]);native=[]
    for c in mesh['cells']:
        M=integral(c,lambda z,A,Ap:props(p(z),T(z))[0]*A,16)
        U=integral(c,lambda z,A,Ap:np.prod(props(p(z),T(z)))*A,16)
        native.append((M,U))
    return native,p

def evaluate(mesh,native,p,T,quadratic=False):
    cells,fields,iterations=reconstruct(mesh,native,quadratic,coupled=quadratic)
    pError=max(abs(f['p'](z)-p(z)) for c,f in zip(cells,fields) for z in [c['lo'],c['z'],c['hi']])
    tError=max(abs(f['T'](z)-T(z)) for c,f in zip(cells,fields) for z in [c['lo'],c['z'],c['hi']])
    massError=max(abs(f['M']-M) for f,(M,U) in zip(fields,native));energyError=max(abs(f['U']-U) for f,(M,U) in zip(fields,native))
    # Independent 16-point integration and complete curved-wall reaction, not the inverse's 8-point moments.
    mass16=energy16=forceError=jump=0.
    for c,f,(M,U) in zip(cells,fields,native):
        mass16=max(mass16,abs(integral(c['c'],lambda z,A,Ap:props(f['p'](z),f['T'](z))[0]*A,16)-M))
        energy16=max(energy16,abs(integral(c['c'],lambda z,A,Ap:np.prod(props(f['p'](z),f['T'](z)))*A,16)-U))
        reaction=0.
        for q in c['c']['pieces']:
            lo,hi=q['lo'],q['hi'];gauge=f['pc'];pressure=lambda z:f['p'](z)-gauge
            reaction+=pressure(lo)*shape(q,lo)[0]-pressure(hi)*shape(q,hi)[0]+quad(lambda z:pressure(z)*shape(q,z)[1],lo,hi,epsabs=1e-7)[0]
        forceError=max(forceError,abs(reaction-g*M))
    for face in mesh['faces']:
        i,j=face['left'],face['right'];a,b=cells[i],cells[j]
        for z in face['sampleHeights_m']:jump=max(jump,abs(fields[i]['p'](z)-fields[j]['p'](z)))
    check('native mass inverse kg',massError,1e-6);check('native energy inverse J',energyError,.1)
    check('independent reconstructed mass quadrature kg',mass16,1e-6);check('independent reconstructed energy quadrature J',energy16,.1)
    check('local full pressure reaction versus native weight N',forceError,.001)
    # Split end-stencil and interior errors; do not blame every failure on a boundary.
    end=[i for i,c in enumerate(cells) if c['oneSidedStencil']]
    centerError=[abs(f['p'](c['z'])-p(c['z'])) for c,f in zip(cells,fields)]
    return dict(cells=len(cells),iterationsOrCoupledResidualEvaluations=iterations,maximumPressureError_Pa=pError,maximumTemperatureError_K=tError,
        oneSidedStencilCentroidPressureError_Pa=max(centerError[i] for i in end),twoSidedStencilCentroidPressureError_Pa=max(e for i,e in enumerate(centerError) if i not in end),
        maximumUnaveragedFacePressureJump_Pa=jump,maximumNativeMassResidual_kg=massError,maximumNativeEnergyResidual_J=energyError,
        independentMassResidual_kg=mass16,independentEnergyResidual_J=energy16,maximumFullBoundaryForceResidual_N=forceError),cells,fields

`
export const reconstructionCalculation = reconstructionSetup + String.raw`
iterationDiagnostics=[]
for mesh in data['meshes']:
    cells,S,C=prepared(mesh,True)
    variance=np.array([integral(c['c'],lambda z,A,Ap:(z-c['z'])**2*A,8)/c['V'] for c in cells])
    linearMap=-np.diag(variance)@C;eigenvalues,eigenvectors=np.linalg.eig(linearMap);dominant=int(np.argmax(abs(eigenvalues)))
    radius=float(abs(eigenvalues[dominant]));seed=eigenvectors[:,dominant];growth=float(np.linalg.norm(linearMap@linearMap@seed)/np.linalg.norm(seed))
    iterationDiagnostics.append(dict(cells=len(cells),linearTemperatureMeanIterationSpectralRadius=radius,
        seededLinearModeTwoIterationAmplification=growth,
        interpretation='Geometric temperature-mean linearization, not the full nonlinear EOS Jacobian; radius above one predicts no contractive fixed-point guarantee.'))
native,_=exact_native(data['meshes'][1],lambda z:cold,p0)
try:reconstruct(data['meshes'][1],native,True)
except ValueError as error:iterationDiagnostics.append(dict(coldFineFixedPointRejected=True,error=str(error)))
else:iterationDiagnostics.append(dict(coldFineFixedPointCompleted=True,caveat='A cold fixed point does not prove stability against perturbed inventories or rounding.'))
profiles=[]
cases=[('cold',lambda z:cold,p0),('hot-top',lambda z:cold+(hot-cold)*(z-zlo)/(ztop-zlo),p0),
    ('hot-bottom',lambda z:hot-(hot-cold)*(z-zlo)/(ztop-zlo),p0),
    ('withheld-curved',lambda z:cold+(hot-cold)*((z-zlo)/(ztop-zlo))**2,p0),
    ('shifted-pressure-and-temperature',lambda z:cold+2+(hot-cold-4)*(z-zlo)/(ztop-zlo),p0+200000),
    ('withheld-nonpolynomial',lambda z:cold+(hot-cold)*((z-zlo)/(ztop-zlo)+.07*math.sin(2*math.pi*(z-zlo)/(ztop-zlo))),p0)]
for label,T,pTop in cases:
    results=[]
    for mesh in data['meshes']:
        print('affine '+label+' '+str(len(mesh['cells']))+' cells',file=sys.stderr,flush=True)
        native,p=exact_native(mesh,T,pTop);result,cells,fields=evaluate(mesh,native,p,T);results.append(result)
        if label not in ['withheld-curved','withheld-nonpolynomial']:
            check(label+' recovered pressure without initializer Pa',result['maximumPressureError_Pa'],.1)
            check(label+' recovered temperature without initializer K',result['maximumTemperatureError_K'],1e-6)
            check(label+' unaveraged common-face pressure jump Pa',result['maximumUnaveragedFacePressureJump_Pa'],.1)
        if label=='hot-top' and len(cells)==39:
            # Same native M/U and unchanged neighboring inventories do not specify arbitrary internal curvature.
            i=max(range(len(cells)),key=lambda i:cells[i]['hi']-cells[i]['lo']);c=cells[i];f=fields[i];M,U=native[i]
            alternative=invert(c,M,U,f['slope'],[f['pc'],f['Tc']],curvature=5.)
            ambiguity=dict(cell=i,curvature_K_m2=5.,pressureDifference_Pa=alternative['pc']-f['pc'],
                centerTemperatureDifference_K=alternative['Tc']-f['Tc'],massDifference_kg=alternative['M']-M,energyDifference_J=alternative['U']-U,
                caveat='Alternative is local mechanical equilibrium, not common-face-compatible global equilibrium; proves M/U is not an arbitrary subcell profile.')
            check('ambiguous profile retains same mass kg',ambiguity['massDifference_kg'],1e-6)
            check('ambiguous profile retains same energy J',ambiguity['energyDifference_J'],.1)
            if abs(ambiguity['pressureDifference_Pa'])<100:raise ValueError('Ambiguity discriminator too weak')
    profiles.append(dict(name=label,reconstruction='affine-neighbor',meshes=results))
# Deliberately do not require curved-profile errors to vanish or quietly fit their field.
for profile in [p for p in profiles if p['name']=='withheld-nonpolynomial' or (p['name']=='withheld-curved' and p['reconstruction']=='affine-neighbor')]:
    curved=profile['meshes']
    for key in ['maximumPressureError_Pa','maximumTemperatureError_K','maximumUnaveragedFacePressureJump_Pa']:
        if curved[1][key]>=curved[0][key]:raise ValueError('Withheld reconstruction does not refine: '+key)
        checks.append(dict(name=profile['reconstruction']+' '+profile['name']+' refines '+key,coarse=curved[0][key],fine=curved[1][key]))
perturbations=[]
for mesh in data['meshes']:
    native,p=exact_native(mesh,lambda z:cold+(hot-cold)*(z-zlo)/(ztop-zlo),p0)
    # Equal/opposite finite heat exchange leaves the rigid tank's total M/U unchanged; it is not another prescribed equilibrium.
    face=max(mesh['faces'],key=lambda f:min(mesh['cells'][f['left']]['volume_m3'],mesh['cells'][f['right']]['volume_m3']))
    i,j=face['left'],face['right'];exchange=10000.;changed=list(native)
    changed[i]=(native[i][0],native[i][1]-exchange);changed[j]=(native[j][0],native[j][1]+exchange)
    cells,fields,iterations=reconstruct(mesh,changed)
    mass=max(abs(f['M']-M) for f,(M,U) in zip(fields,changed));energy=max(abs(f['U']-U) for f,(M,U) in zip(fields,changed))
    check('local heat exchange native mass retained kg',mass,1e-6);check('local heat exchange native energy retained J',energy,.1)
    total=sum(f['U']-U for f,(M,U) in zip(fields,native));check('local heat exchange closed total energy J',total,.1)
    z=face['sampleHeights_m'][len(face['sampleHeights_m'])//2]
    jump=abs(fields[i]['p'](z)-fields[j]['p'](z))
    if jump<1.:raise ValueError('Finite heat exchange incorrectly erased as equilibrium')
    perturbations.append(dict(cells=len(cells),heatExchange_J=exchange,donorCell=i,receiverCell=j,iterations=iterations,
        maximumMassResidual_kg=mass,maximumEnergyResidual_J=energy,totalEnergyChangeResidual_J=total,unaveragedExchangeFacePressureJump_Pa=jump))
# One supported-solver diagnostic separates fixed-point failure from proof of representation impossibility.
# A failed attempt is explicit evidence, not a silent fallback or a qualified reconstruction.
mesh=data['meshes'][1];T=lambda z:cold+(hot-cold)*((z-zlo)/(ztop-zlo))**2
native,p=exact_native(mesh,T,p0)
print('coupled quadratic diagnostic 138 cells',file=sys.stderr,flush=True)
try:
    result,_,_=evaluate(mesh,native,p,T,True)
    coupledAttempt=dict(status='completed',result=result,caveat='One case alone does not qualify the quadratic reconstruction or nonlinear time advancement.')
except ValueError as error:coupledAttempt=dict(status='rejected',reason=str(error),caveat='A numerical trial failure does not prove the prescribed all-liquid equilibrium or native inventories physically invalid.')
mesh=data['meshes'][0];native,p=exact_native(mesh,lambda z:cold,p0)
for label,bad in [('negative mass',(-1,native[0][1])),('nonfinite energy',(native[0][0],float('nan')))]:
    try:reconstruct(mesh,[bad]+native[1:])
    except ValueError:checks.append(dict(name=label,rejected=True))
    else:raise ValueError(label+' admitted')
for bad in [native[:-1],native+[native[0]]]:
    try:reconstruct(mesh,bad)
    except ValueError:checks.append(dict(name='inventory count mismatch rejected',rejected=True))
    else:raise ValueError('Inventory count mismatch admitted')
try:field(prepared(mesh)[0][0],p0,900,0)
except ValueError:checks.append(dict(name='nonliquid reconstructed field rejected',rejected=True))
else:raise ValueError('Nonliquid reconstructed field admitted')
print(json.dumps(dict(scope='Local native-inventory smooth hydrostatic reconstruction; no nonlinear advancement or open-port qualification',
    versions=dict(CoolProp=CoolProp.__version__,numpy=np.__version__,scipy=scipy.__version__),
    profiles=profiles,iterationDiagnostics=iterationDiagnostics,coupledQuadraticAttempt=coupledAttempt,
    conservativeLocalHeatExchanges=perturbations,nonIdentifiability=ambiguity,checks=checks,referenceChecksPassed=True,
    nonlinearTransportQualified=False,quadraticReconstructionQualified=False,arbitrarySubcellProfilesIdentifiable=False),allow_nan=False))
`

if (import.meta.main) {
  const [owner, python] = process.argv.slice(2)
  if (!owner || !python || process.argv.length !== 4) throw new Error('Usage: reference-design-cmt-reconstruction.ts geometry-owner.md python')
  const document = await Bun.file(owner).text(), geometry = parseGeometryBasis(document), basis = parseAcousticBasis(document)
  const input = { basis, geometry, mouth_m: tankGeometry(geometry).mouth, meshes: [reconstructionMesh(geometry), reconstructionMesh(geometry, true)] }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { inputHash: hash(JSON.stringify(input)), sourceHash: hash(await Bun.file(import.meta.path).text()),
    hydrostaticSourceHash: hash(await Bun.file(new URL('./reference-design-cmt-hydrostatic.ts', import.meta.url)).text()),
    acousticSourceHash: hash(await Bun.file(new URL('./reference-design-cmt-acoustics.ts', import.meta.url)).text()),
    geometrySourceHash: hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()), calculationHash: hash(reconstructionCalculation) }
  const child = Bun.spawn([python, '-c', reconstructionCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'inherit' })
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('CMT native-inventory reconstruction failed')
  console.log(JSON.stringify({ input, ...identity, ...JSON.parse(stdout) }, null, 2))
}
