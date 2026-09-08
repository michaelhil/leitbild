/** Offline spatial initialization, steel conduction and surface-event verification. Not a water transient solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'

const schema = z.object({ surfacePressure_MPa: z.number().finite().positive(),
  verificationGasGamma: z.number().finite().gt(1),
  wallDuration_s: z.number().finite().positive(),
}).strict()
export function parseSpatialBasis(document: string) {
  const blocks = [...document.matchAll(/^```reference-pressurizer-spatial\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected exactly one reference-pressurizer-spatial block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export const spatialCalculation = String.raw`
import json,sys,math,platform,iapws
import numpy as np
from scipy.integrate import solve_ivp,quad
from scipy.optimize import brentq
from iapws import IAPWS97
b=json.load(sys.stdin);r=b['source'];s=b['spatial'];g=9.80665
A=math.pi*r['innerRadius_m']**2;H=r['height_m'];L=r['statedLevel_m']
p=s['surfacePressure_MPa'];T=r['fluidTemperature_K'];v=IAPWS97(P=p,x=1)
if not 0<L<H or T>=v.T:raise ValueError('Initial liquid profile is outside admitted strictly subcooled domain')
# p is MPa; integrate downward from the free-surface pressure datum.
def field(tol):
    def rhs(z,y):return [-IAPWS97(P=float(y[0]),T=T).rho*g/1e6]
    sol=solve_ivp(rhs,[L,0],[p],rtol=tol,atol=tol/100,dense_output=True)
    if not sol.success:raise ValueError(sol.message)
    def quantities(z):
        q=IAPWS97(P=float(sol.sol(z)[0]),T=T)
        return q.rho*A,np.array([q.u*1000,g*z])*q.rho*A
    cells=[];edges=np.linspace(0,H,r['cellCount']+1)
    for lo,top in zip(edges[:-1],edges[1:]):
        hi=min(top,L)
        if hi<=lo:continue # no EOS state exists for an empty liquid band
        m=quad(lambda z:quantities(z)[0],lo,hi,epsabs=1e-9)[0]
        u=quad(lambda z:quantities(z)[1][0],lo,hi,epsabs=1e-5)[0]
        pe=quad(lambda z:quantities(z)[1][1],lo,hi,epsabs=1e-7)[0]
        cells.append(dict(bottom_m=float(lo),top_m=float(hi),mass_kg=m,internalEnergy_J=u,potentialEnergy_J=pe))
    m=sum(c['mass_kg'] for c in cells);pb=float(sol.sol(0)[0])
    residual=(pb-p)*1e6-m*g/A
    if abs(residual)>.001:raise ValueError('Hydrostatic weight/pressure disagreement')
    flat=IAPWS97(P=p,T=T)
    return dict(bottomPressure_MPa=pb,liquidMass_kg=m,
        liquidInternalEnergy_J=sum(c['internalEnergy_J'] for c in cells),
        liquidPotentialEnergy_J=sum(c['potentialEnergy_J'] for c in cells),
        uniformPressureLiquidMassDifference_kg=m-A*L*flat.rho,
        hydrostaticResidual_Pa=residual,cells=cells)
coarse=field(1e-7);fine=field(1e-10)
if abs(coarse['liquidMass_kg']-fine['liquidMass_kg'])>1e-7:raise ValueError('Hydrostatic refinement failed')
initial=dict(**fine,initialLiquidTemperature_K=T,initialVaporTemperature_K=v.T,
    vaporRoundingAdjustment_K=v.T-T,vaporMass_kg=v.rho*A*(H-L),
    vaporInternalEnergy_J=v.u*1000*v.rho*A*(H-L),
    neglectedVaporHydrostaticHeadEstimate_Pa=v.rho*g*(H-L))

# IAEA TECDOC-949 p132, eq4.4.1-5/-7. Fixed geometry and density7900kg/m3.
# Integrate cp rather than mix it with the separately rounded enthalpy polynomial.
def cp(T):
    if np.any(np.asarray(T)<300) or np.any(np.asarray(T)>=1558):raise ValueError('Steel outside selected solid-property interval')
    return 326+.298*T-9.56e-5*T*T
def k(T):cp(T);return 7.58+.0189*T
def e(T):
    cp(T)
    return 326*(T-300)+.149*(T*T-300**2)-9.56e-5/3*(T**3-300**3)
def K(T):return 7.58*T+.0189*T*T/2
wall=[]
for n,tol in [(4,1e-8),(8,1e-8),(16,1e-8),(16,1e-10),(32,1e-10)]:
    edges=np.linspace(r['innerRadius_m'],r['outerRadius_m'],n+1)
    centers=np.sqrt((edges[:-1]**2+edges[1:]**2)/2)
    masses=7900*math.pi*(edges[1:]**2-edges[:-1]**2)*H
    def outside(outerCell):
        def residual(surface):
            conduction=2*math.pi*H*(K(outerCell)-K(surface))/math.log(edges[-1]/centers[-1])
            convection=2*math.pi*edges[-1]*H*r['outerHeatTransfer_W_m2K']*(surface-r['ambientTemperature_K'])
            return conduction-convection
        return brentq(residual,300.,float(outerCell),xtol=1e-10)
    def rates(t,y):
        temps=y[:n];cp(temps)
        # Insulated inside, source ambient/lateral convection outside; no heater or fluid reservoir.
        internal=2*math.pi*H*(K(temps[:-1])-K(temps[1:]))/np.log(centers[1:]/centers[:-1])
        surface=outside(temps[-1])
        if surface<300:raise ValueError('Wall boundary outside material law')
        loss=2*math.pi*edges[-1]*H*r['outerHeatTransfer_W_m2K']*(surface-r['ambientTemperature_K'])
        net=np.zeros(n);net[:-1]-=internal;net[1:]+=internal;net[-1]-=loss
        return np.r_[net/(masses*cp(temps)),loss]
    y0=np.r_[np.full(n,r['wallTemperature_K']),0.]
    sol=solve_ivp(rates,[0,s['wallDuration_s']],y0,method='Radau',rtol=tol,atol=tol,max_step=2)
    if not sol.success:raise ValueError(sol.message)
    final=sol.y[:n,-1];stored=float(np.dot(masses,e(final)-e(y0[:n])));loss=float(sol.y[-1,-1])
    residual=stored+loss
    if abs(residual)>.02 or np.max(final)>r['wallTemperature_K'] or np.min(final)<=300:raise ValueError('Wall storage/heat comparison failed')
    wall.append(dict(radialCells=n,tolerance=tol,meanTemperature_K=float(np.dot(masses,final)/sum(masses)),
        innerCellTemperature_K=float(final[0]),outerCellTemperature_K=float(final[-1]),
        outerSurfaceTemperature_K=outside(final[-1]),
        storedEnergyChange_J=stored,integratedHeatLoss_J=loss,energyResidual_J=residual))
if abs(wall[2]['meanTemperature_K']-wall[3]['meanTemperature_K'])>1e-5:raise ValueError('Wall time integration disagreement')
refined={key:abs(wall[4][key]-wall[3][key]) for key in ['meanTemperature_K','outerSurfaceTemperature_K']}
refined['relativeHeatLossDifference']=abs(wall[4]['integratedHeatLoss_J']/wall[3]['integratedHeatLoss_J']-1)
if max(refined['meanTemperature_K'],refined['outerSurfaceTemperature_K'])>.01 or refined['relativeHeatLossDifference']>1e-4:
    raise ValueError('Held-out 32-cell wall comparison failed declared numerical resolution target')

# Independent mechanical limiting case: incompressible isothermal liquid under an
# adiabatic ideal gas, zero gravity, insulated stationary walls. NOT water/steam EOS.
# A finite prescribed reservoir supplies the liquid; source inlet is directly here,
# not the upstream PACTEL FILL across its surge line.
rho=IAPWS97(P=p,T=T).rho;u=IAPWS97(P=p,T=T).u*1000
gamma=s['verificationGasGamma']
def initial_cells(n,level):
    dz=H/n
    return np.array([rho*A*dz if (i+1)*dz<=level else rho*A*max(0.,level-i*dz) for i in range(n)])
def crossing(n,segments,initial_level=L):
    vg0=A*(H-initial_level)
    def analytic(vol):return p*1e6*(vg0/(A*H-vol))**gamma
    def gas_energy(vol):return analytic(vol)*(A*H-vol)/(gamma-1)
    masses=initial_cells(n,initial_level);energies=masses*u;gas=p*1e6*vg0/(gamma-1);boundary=0.;reservoir=100.;sourceEnergy=100*u
    crossings=0;maxResidual=0.;maxGasError=0.;peakPressure=p*1e6;peakLevel=initial_level;startTotal=float(sum(energies)+gas+sourceEnergy)
    capacity=rho*A*H/n;wallEnergy=np.arange(n,dtype=float)+10 # unequal markers must never be remapped
    initialWall=wallEnergy.copy();totalTransferred=0.
    exactFaceStart=bool(all(m==0 or m==capacity for m in masses))
    for dm in segments:
        remaining=dm
        while remaining!=0:
            occupied=np.flatnonzero(masses>0)
            top=int(occupied[-1]) if len(occupied) else -1
            if remaining>0:
                i=top if top>=0 and masses[top]<capacity else top+1
                if i>=n:raise ValueError('Full liquid phase boundary reached')
                available=capacity-masses[i];amount=min(remaining,available)
            else:
                i=top
                if i<0:raise ValueError('Empty liquid phase boundary reached')
                available=masses[i];amount=-min(-remaining,available)
            if amount==0:raise ValueError('Surface event made no progress')
            if abs(amount)==available and ((amount>0 and i==n-1) or (amount<0 and i==0)):
                raise ValueError('Phase exhaustion requires a different admitted model')
            oldVol=float(sum(masses))/rho;newVol=oldVol+amount/rho
            if not 0<newVol<A*H:raise ValueError('Phase exhaustion is outside two-phase test')
            # Integrate physical port work independently of gas's analytic energy.
            work=quad(analytic,oldVol,newVol,epsabs=1e-9)[0]
            reservoir-=amount;sourceEnergy-=amount*u
            masses[i]+=amount;energies[i]+=amount*u;gas+=work;boundary+=work
            remaining-=amount;totalTransferred+=amount
            if abs(amount)==available:
                # Event identity gives exact zero/full state; no epsilon inventory or energy removal.
                masses[i]=capacity if amount>0 else 0.;energies[i]=masses[i]*u;crossings+=1
            residual=sum(energies)+gas+sourceEnergy-startTotal-boundary
            maxResidual=max(maxResidual,abs(float(residual)))
            vol=float(sum(masses))/rho
            maxGasError=max(maxGasError,abs(gas-gas_energy(vol)))
            peakPressure=max(peakPressure,analytic(vol));peakLevel=max(peakLevel,vol/A)
            if reservoir<=0 or maxResidual>1e-5 or maxGasError>1e-5:raise ValueError('Finite source or intermediate energy check failed')
    vol=float(sum(masses))/rho
    gasError=gas-gas_energy(vol)
    if abs(gasError)>1e-5 or not np.array_equal(wallEnergy,initialWall):raise ValueError('Gas work or wall ownership failure')
    return dict(bands=n,crossings=crossings,exactFaceStart=exactFaceStart,transferredMass_kg=totalTransferred,level_m=vol/A,
        pressure_MPa=analytic(vol)/1e6,gasEnergyError_J=float(gasError),
        maximumIntermediateGasEnergyError_J=float(maxGasError),peakPressure_MPa=peakPressure/1e6,peakLevel_m=peakLevel,
        totalEnergyResidual_J=maxResidual,liquidSpecificEnergyError_J_kg=float(max(abs(energies[masses>0]/masses[masses>0]-u))),
        sourceMass_kg=reservoir,wallEnergyUnchanged=bool(np.array_equal(wallEnergy,initialWall)))
# Same finite displacement with independent subdivision and spatial placement.
mechanical=[]
for n in [12,16,30,61]:
    for parts in [1,16]:
        initial_level=6*(H/16) if n==16 else L
        result=crossing(n,[30/parts]*parts+[-30/parts]*parts,initial_level)
        if n==16 and not result['exactFaceStart']:raise ValueError('Exact-face initial fixture was not exact')
        if abs(result['level_m']-L)>1e-12 or result['crossings']<2:raise ValueError('Crossing/recrossing failed')
        mechanical.append(result)
rejected=0
for dm in [-100,100]:
    try:crossing(16,[dm])
    except ValueError as ex:
        if 'phase boundary' not in str(ex) and 'Phase exhaustion' not in str(ex):raise
        rejected+=1
    else:raise ValueError('Phase exhaustion silently continued')
print(json.dumps(dict(scope='Native spatial initialization, isolated material wall and mechanical surface-event verification only',
    python=platform.python_version(),iapws=iapws.__version__,initial=initial,wall=wall,wallRefinement=refined,
    steel=dict(cp547_J_kgK=float(cp(547)),conductivity547_W_mK=float(k(547)),density_kg_m3=7900),
    reversibleSurfaceCrossings=mechanical,phaseBoundaryCasesRejected=rejected,coupledWaterTrajectoryQualified=False),allow_nan=False))
`

if (import.meta.main) {
  const [sourcePage, ownerPage, python] = process.argv.slice(2)
  if (!sourcePage || !ownerPage || !python) throw Error('Usage: reference-design-pressurizer-spatial.ts <source-page> <state-owner> <python>')
  const input = { source: parsePressurizerBoundaries(await Bun.file(sourcePage).text()), spatial: parseSpatialBasis(await Bun.file(ownerPage).text()) }
  const child = Bun.spawn([python, '-c', spatialCalculation], { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const hash = (x: string) => createHash('sha256').update(x).digest('hex')
  console.log(JSON.stringify({ input, inputHash: hash(JSON.stringify(input)), calculationHash: hash(spatialCalculation), ...JSON.parse(out) }, null, 2))
}
