/** Offline PRHR scalar-mixing/preparation audit; not a plant or startup solver. */
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {auditPrhrGeometry,parsePrhrGeometry} from './reference-design-prhr-geometry'
import {auditPrhrIsolation,parsePrhrIsolation} from './reference-design-prhr-isolation'

const positive=z.number().finite().positive()
const basisSchema=z.object({coefficient:positive,turbulentPrandtl:positive,turbulentSchmidt:positive,penetrationBores:positive,
  preparedBank_C:z.tuple([z.number().finite(),z.number().finite()])}).strict()
export type MixingBasis=z.infer<typeof basisSchema>
export function parsePrhrMixing(text:string):MixingBasis {
  const blocks=[...text.matchAll(/^```reference-prhr-mixing\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Exactly one PRHR scalar-mixing basis required')
  return basisSchema.parse(JSON.parse(blocks[0]![1]!))
}
export type MixingWater={temperature_K:number;density_kg_m3:number;potentialDensity_kg_m3:number;cp_J_kgK:number;conductivity_W_mK:number;concentration:number}
export function prhrScalarMixing(b:MixingBasis,a:MixingWater,c:MixingWater,g:{diameter_m:number;rise_m:number;length_m:number;start_m:number;end_m:number},mainVelocity:number) {
  basisSchema.parse(b)
  for(const w of[a,c])if(!Object.values(w).every(Number.isFinite)||w.temperature_K<=0||w.density_kg_m3<=0||w.potentialDensity_kg_m3<=0||w.cp_J_kgK<=0||w.conductivity_W_mK<=0||w.concentration<0||w.concentration>1)throw Error('Admissible water/scalar state required')
  if(!Object.values(g).every(Number.isFinite)||!Number.isFinite(mainVelocity)||g.diameter_m<=0||g.length_m<=0||Math.abs(g.rise_m)>g.length_m||g.start_m<0||g.end_m>g.length_m||g.end_m<=g.start_m)throw Error('Physical return interval required')
  const dx=g.end_m-g.start_m,A=Math.PI*g.diameter_m**2/4,l=b.penetrationBores*g.diameter_m
  const penetration=l/dx*(Math.exp(-g.start_m/l)-Math.exp(-g.end_m/l))
  // a is the lower/SG-directed coordinate end, c the bank-directed end.
  // Potential densities are recovered at one common pressure, not compared at different hydrostatic p.
  const unstable=Math.max(0,(c.potentialDensity_kg_m3-a.potentialDensity_kg_m3)*g.rise_m/g.length_m)
  const rho=(a.density_kg_m3+c.density_kg_m3)/2,cp=(a.cp_J_kgK+c.cp_J_kgK)/2
  const buoyantVelocity=Math.sqrt(9.80665*g.diameter_m*unstable/((a.potentialDensity_kg_m3+c.potentialDensity_kg_m3)/2))
  const eddy=b.coefficient*g.diameter_m*(Math.abs(mainVelocity)*penetration+buoyantVelocity)
  const molecular=2*a.conductivity_W_mK*c.conductivity_W_mK/(a.conductivity_W_mK+c.conductivity_W_mK)
  const conductance=(molecular+rho*cp*eddy/b.turbulentPrandtl)*A/dx
  const turnover=rho*eddy/b.turbulentSchmidt*A/dx
  const heat=conductance*(a.temperature_K-c.temperature_K)
  return {eddyDiffusivity_m2_s:eddy,forcedPenetrationMean:penetration,buoyantVelocity_m_s:buoyantVelocity,
    thermalConductance_W_K:conductance,equivalentScalarTurnover_kg_s:turnover,
    heatFromAToC_W:heat,scalarFromAToC_kg_s:turnover*(a.concentration-c.concentration),
    thermalEntropyProduction_W_K:heat*(1/c.temperature_K-1/a.temperature_K)}
}

export type FilmWater={density_kg_m3:number;viscosity_Pas:number;conductivity_W_mK:number;cp_J_kgK:number;expansion_K_1:number}
function checkFilm(w:FilmWater){if(!Object.values(w).every(Number.isFinite)||w.density_kg_m3<=0||w.viscosity_Pas<=0||w.conductivity_W_mK<=0||w.cp_J_kgK<=0||w.expansion_K_1<0)throw Error('Positive-expansion single-phase film properties required')}
/** Same INL film expression as retained sizing, signed thermal contact; only high-Re extension is selected. */
export function prhrLiquidFilm(bulk:FilmWater,wall:FilmWater,film:FilmWater,diameter:number,velocity:number,waterT:number,wallT:number){
  for(const w of[bulk,wall,film])checkFilm(w)
  if(![diameter,velocity,waterT,wallT].every(Number.isFinite)||diameter<=0||Math.min(waterT,wallT)<=0)throw Error('Physical liquid-film contact required')
  const Pr=bulk.viscosity_Pas*bulk.cp_J_kgK/bulk.conductivity_W_mK,Prw=wall.viscosity_Pas*wall.cp_J_kgK/wall.conductivity_W_mK
  if(Pr<.5||Pr>2000||Pr/Prw<.05||Pr/Prw>20)throw Error('Unselected film-property range')
  const Re=bulk.density_kg_m3*Math.abs(velocity)*diameter/bulk.viscosity_Pas
  const Ra=9.80665*bulk.expansion_K_1*Math.abs(waterT-wallT)*diameter**3/(bulk.viscosity_Pas/film.density_kg_m3)**2*Pr
  const natural=Math.max(.59*Ra**.25,.13*Ra**(1/3))
  const f=Re>1000?(1.58*Math.log(Re)-3.28)**-2:0
  const turbulent=Re>1000?(f/2)*(Re-1000)*Pr/(1+12.7*Math.sqrt(f/2)*(Pr**(2/3)-1))*(Pr/Prw)**.11:0
  const h=Math.max(3.66,natural,turbulent)*bulk.conductivity_W_mK/diameter
  return {Re,Pr,h_W_m2K:h,heatFluxFromWater_W_m2:h*(waterT-wallT),highReExtrapolation:Re>5e6&&turbulent>=Math.max(3.66,natural)}
}
/** Signed nonboiling external convection; nucleate/CHF/partial-wet are separate physical branches. */
export function prhrLiquidPoolConvection(film:FilmWater,diameter:number,wallT:number,poolT:number,bankEffect:number){
  checkFilm(film)
  if(![diameter,wallT,poolT,bankEffect].every(Number.isFinite)||diameter<=0||Math.min(wallT,poolT)<=0||bankEffect<=0||bankEffect>1)throw Error('Physical submerged convection contact required')
  const Pr=film.viscosity_Pas*film.cp_J_kgK/film.conductivity_W_mK,nu=film.viscosity_Pas/film.density_kg_m3,alpha=film.conductivity_W_mK/(film.density_kg_m3*film.cp_J_kgK)
  const Ra=9.80665*film.expansion_K_1*Math.abs(wallT-poolT)*diameter**3/(nu*alpha)
  const Nu=(.6+.387*Ra**(1/6)/(1+(.559/Pr)**(9/16))**(8/27))**2
  return bankEffect*Nu*film.conductivity_W_mK/diameter*(wallT-poolT)
}
export function prhrDiscContactWeights(opening:number){
  if(!Number.isFinite(opening)||opening<0||opening>1)throw Error('Actual opening must be between closed and open')
  const own=(1+Math.cos(Math.PI*opening/2))/2
  return {upstreamMaterialFace:[own,1-own],downstreamMaterialFace:[1-own,own]}
}

export const prhrPreparationPython=String.raw`
import json,sys,math
import numpy as np
from scipy.integrate import solve_ivp,quad
from CoolProp.CoolProp import PropsSI
from CoolProp import AbstractState,PT_INPUTS,DmassUmass_INPUTS
x=json.load(sys.stdin); b=x['geometry']; a=x['audit']; iso=x['isolation']; mix=x['mixing']; parent=x['parent']
assert parent['accepted'] and parent['parentOperatingPointAdmitted']
faces=parent['lastEvaluableState']['primary']['faces']
sg=next(f for f in faces if f['owner']=='SG.A.PRIMARY'); hot=next(f for f in faces if f['owner']=='HOT.A.after')
water=AbstractState('HEOS','Water'); g=9.80665; t=b['tubes']; zsg=sg['z_m']
def prop(p,T):
 water.update(PT_INPUTS,p,T)
 return dict(rho=water.rhomass(),u=water.umass(),cp=water.cpmass(),k=water.conductivity(),s=water.smass())
def filmprop(p,T):
 water.update(PT_INPUTS,p,T)
 return dict(density_kg_m3=water.rhomass(),viscosity_Pas=water.viscosity(),conductivity_W_mK=water.conductivity(),cp_J_kgK=water.cpmass(),expansion_K_1=water.isobaric_expansion_coefficient())
preparations=[]
for C in mix['preparedBank_C']:
 T=C+273.15
 # Isothermal hydrostat is path-independent: all parallel branches share p(z).
 lo=min(b['hotTerminal_m'],zsg); hi=t['top_m']
 def deriv(z,p):return [-g*prop(float(p[0]),T)['rho']]
 up=solve_ivp(deriv,[zsg,hi],[sg['p_Pa']],rtol=2e-11,atol=1e-5,dense_output=True)
 down=solve_ivp(deriv,[zsg,lo],[sg['p_Pa']],rtol=2e-11,atol=1e-5,dense_output=True)
 assert up.success and down.success
 def pz(z):return float((up if z>=zsg else down).sol(z)[0])
 def vector(z):
  v=prop(pz(z),T);return np.array([v['rho'],v['rho']*v['u'],v['rho']*g*z])
 parts=[]
 def region(name,volume,zfun):
  values=np.array([quad(lambda f:float(vector(zfun(f))[i]),0,1,epsabs=1e-5,epsrel=1e-10)[0]*volume for i in range(3)])
  parts.append(dict(name=name,volume_m3=volume,mass_kg=values[0],internalEnergy_J=values[1],potentialEnergy_J=values[2]))
 area=math.pi*b['hotConnector']['id_m']**2/4
 region('downstream seat cavity',iso['geometry']['closedHotConnectedWater_m3'],lambda f:b['hotTerminal_m'])
 region('hot riser',area*iso['geometry']['remainingHotConnector_m'],lambda f:b['hotTerminal_m']+f*(t['top_m']-b['hotTerminal_m']))
 for label,z in [('upper',t['top_m']),('lower',t['bottom_m'])]:
  for side in ['near','far']:region(label+' header '+side,a['headers']['water_m3']/4,lambda f,z=z:z)
 r=t['bendRadius_m']; straight=t['straightLeg_m']; drop=t['top_m']-t['bottom_m']-2*r
 tubeArea=math.pi*t['id_m']**2/4*t['count']
 region('upper straight tube legs',tubeArea*straight,lambda f:t['top_m'])
 region('upper tube bends',tubeArea*math.pi*r/2,lambda f:t['top_m']-r*(1-math.cos(f*math.pi/2)))
 region('vertical tube legs',tubeArea*drop,lambda f:t['top_m']-r-f*drop)
 region('lower tube bends',tubeArea*math.pi*r/2,lambda f:t['bottom_m']+r*(1-math.sin(f*math.pi/2)))
 region('lower straight tube legs',tubeArea*straight,lambda f:t['bottom_m'])
 region('cold connector',a['coldConnector']['water_m3'],lambda f:zsg+f*(t['bottom_m']-zsg))
 v=sum(p['volume_m3'] for p in parts);assert abs(v-iso['geometry']['closedBankConnectedWater_m3'])<1e-10
 # HOT-side quiescent material uses static side-tap p,T; main axial KE is not its initial KE.
 hp=prop(hot['p_Pa'],hot['T_K']);hotM=hp['rho']*iso['geometry']['closedHotConnectedWater_m3']
 bankSteel=(a['tube']['steel_m3']+a['headers']['steel_m3']+a['hotConnector']['steel_m3']+a['coldConnector']['steel_m3'])*b['steelDensity_kg_m3']*b['steelCp_J_kgK']-iso['material']['spoolShellHeatCapacity_J_K']/2
 bankSteel+=iso['material']['discHeatCapacity_J_K']/2
 hotSteel=(iso['material']['spoolShellHeatCapacity_J_K']+iso['material']['discHeatCapacity_J_K'])/2
 preparations.append(dict(bank_C=C,parts=parts,bankMass_kg=sum(p['mass_kg'] for p in parts),bankInternalEnergy_J=sum(p['internalEnergy_J'] for p in parts),bankPotentialEnergy_J=sum(p['potentialEnergy_J'] for p in parts),
  hotCavityMass_kg=hotM,hotCavityInternalEnergy_J=hotM*hp['u'],hotCavityPotentialEnergy_J=hotM*g*b['hotTerminal_m'],
  bankSteelEnergyAboveZeroC_J=bankSteel*C,hotSteelEnergyAboveZeroC_J=hotSteel*(hot['T_K']-273.15),
  bankSeatPressure_Pa=pz(b['hotTerminal_m']),seatDifferential_Pa=hot['p_Pa']-pz(b['hotTerminal_m']),
  minimumPressure_Pa=pz(hi),maximumPressure_Pa=pz(lo),waterVolume_m3=v,
  isothermalEnthalpyPlusElevationChange_J_kg=(prop(pz(hi),T)['u']+pz(hi)/prop(pz(hi),T)['rho'])-(prop(sg['p_Pa'],T)['u']+sg['p_Pa']/prop(sg['p_Pa'],T)['rho'])+g*(hi-zsg)))
 # Isothermal h+gz is NOT constant (dh/dp = v-T dv/dT): residual is diagnostic, not an acceptance test.

# Short thermal/scalar operator qualification. Fixed native masses/volumes ONLY for this isolated operator.
# Ordinary net momentum/transport is held out; this is not an installed pressure trajectory.
V=math.pi*b['coldConnector']['id_m']**2/4*.25
M=np.array([prop(15e6,T)['rho']*V for T in [423.15,424.15]])
U0=np.array([M[i]*prop(15e6,T)['u'] for i,T in enumerate([423.15,424.15])])
states=[AbstractState('HEOS','Water'),AbstractState('HEOS','Water')]
def evaluate(y,coefficient):
 w=[]
 for i in range(2):
  states[i].update(DmassUmass_INPUTS,M[i]/V,(U0[i]+y[i])/M[i])
  w.append(dict(T=states[i].T(),p=states[i].p(),rho=M[i]/V,cp=states[i].cpmass(),k=states[i].conductivity()))
 meanp=(w[0]['p']+w[1]['p'])/2
 for v in w:v['rhop']=prop(meanp,v['T'])['rho']
 D=b['coldConnector']['id_m'];dx=.25;A=math.pi*D*D/4;l=mix['penetrationBores']*D
 forced=l/dx*(1-math.exp(-dx/l))*abs(sg['velocity_m_s'])
 unstable=max(0,(w[1]['rhop']-w[0]['rhop'])*(t['bottom_m']-zsg)/b['coldConnector']['length_m'])
 eddy=coefficient*D*(forced+math.sqrt(g*D*unstable/((w[0]['rhop']+w[1]['rhop'])/2)))
 rho=sum(v['rho'] for v in w)/2;cp=sum(v['cp'] for v in w)/2
 G=(2*w[0]['k']*w[1]['k']/(w[0]['k']+w[1]['k'])+rho*cp*eddy/mix['turbulentPrandtl'])*A/dx
 q=G*(w[0]['T']-w[1]['T']);km=rho*eddy*A/dx/mix['turbulentSchmidt']
 c=[(M[0]+y[2])/M[0],y[3]/M[1]];jb=km*(c[0]-c[1])
 return np.array([-q,q,-jb,jb]),w,c,q,km
thermal=[]
for coefficient in [.003,mix['coefficient'],.03]:
 def rhs(t,y):return evaluate(y,coefficient)[0]
 runs=[solve_ivp(rhs,[0,1],np.zeros(4),method='DOP853',rtol=rtol,atol=[1e-7,1e-7,1e-12,1e-12],dense_output=True) for rtol in [1e-9,1e-11]]
 assert all(s.success for s in runs)
 samples=np.linspace(0,1,21);maxE=max(abs(sum(runs[1].sol(tt)[:2])) for tt in samples);maxB=max(abs(sum(runs[1].sol(tt)[2:])) for tt in samples)
 for tt in samples:
  _,w,c,q,km=evaluate(runs[1].sol(tt),coefficient)
  assert min(c)>=-1e-11 and max(c)<=1+1e-11 and q*(1/w[1]['T']-1/w[0]['T'])>=-1e-10
 delta=runs[1].y[:,-1];_,w,c,q,km=evaluate(delta,coefficient)
 pair=np.max(np.abs(runs[0].sol(samples)-runs[1].sol(samples)),axis=1)
 assert maxE<1e-6 and maxB<1e-10 and max(pair[:2])<.01 and max(pair[2:])<1e-8,(coefficient,maxE,maxB,pair.tolist())
 thermal.append(dict(coefficient=coefficient,duration_s=1,waterVolumeEach_m3=V,waterMass_kg=M.tolist(),energyReceivedByLowerCell_J=float(delta[0]),originReceivedByUpperCell_kg=float(delta[3]),finalPressure_Pa=[v['p'] for v in w],finalTemperature_K=[v['T'] for v in w],finalOriginFraction=c,energyResidual_J=float(maxE),originResidual_kg=float(maxB),tolerancePairMaximumDifference=pair.tolist(),rhsEvaluations=[s.nfev for s in runs]))
filmCases=[dict(waterT=T,wallT=Tw,bulk=filmprop(15e6,T),wall=filmprop(15e6,Tw),film=filmprop(15e6,(T+Tw)/2)) for T,Tw in [(298.15,423.15),(423.15,298.15),(hot['T_K'],423.15),(423.15,hot['T_K']),(423.15,423.15)]]
print(json.dumps(dict(sourcePorts={'sg':sg,'hot':hot},preparations=preparations,thermalOperator=thermal,filmCases=filmCases,numericalChecksPassed=True,
 scope='Hydrostatic independently prepared fills and one-second isolated native-energy/scalar operator; no finite startup, coupled pressure trajectory, partial-wet or two-phase qualification.'),allow_nan=False))
`

if(import.meta.main){
  const [owner,parentFile,python,output,...rest]=process.argv.slice(2)
  if(!owner||!parentFile||!python||!output||rest.length)throw Error('Usage: prhr-mixing <owner.md> <primary-pzr-normal.json> <python> <receipt.json>')
  const source=await Bun.file(import.meta.path).text(),ownerText=await Bun.file(owner).text(),parentText=await Bun.file(parentFile).text()
  const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
  const dependencyNames=['reference-design-prhr-geometry.ts','reference-design-prhr-isolation.ts']
  const dependencyBytes=Object.fromEntries(await Promise.all(dependencyNames.map(async f=>[f,await Bun.file(new URL(f,import.meta.url)).text()])))
  const geometry=parsePrhrGeometry(ownerText),input={geometry,audit:auditPrhrGeometry(geometry),isolation:auditPrhrIsolation(geometry,parsePrhrIsolation(ownerText)),mixing:parsePrhrMixing(ownerText),parent:JSON.parse(parentText)}
  const child=Bun.spawn([python,'-c',prhrPreparationPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw Error(stderr)
  if(await Bun.file(import.meta.path).text()!==source||await Bun.file(owner).text()!==ownerText||await Bun.file(parentFile).text()!==parentText)throw Error('Source or consumed input changed during calculation')
  for(const f of dependencyNames)if(await Bun.file(new URL(f,import.meta.url)).text()!==dependencyBytes[f])throw Error('Calculation dependency changed during execution')
  const dependencies=Object.fromEntries(dependencyNames.map(f=>[f,hash(dependencyBytes[f]!)]))
  const calculation=JSON.parse(stdout),disc=parsePrhrIsolation(ownerText),area=Math.PI*disc.discDiameter_m**2/4
  const filmChecks=calculation.filmCases.flatMap((c:{waterT:number;wallT:number;bulk:FilmWater;wall:FilmWater;film:FilmWater})=>[0,calculation.sourcePorts.sg.velocity_m_s,-calculation.sourcePorts.sg.velocity_m_s,20].map(velocity=>{
    const film=prhrLiquidFilm(c.bulk,c.wall,c.film,disc.discDiameter_m,velocity,c.waterT,c.wallT)
    const seriesHeat=[.5,1,2].map(factor=>(c.waterT-c.wallT)/(1/(factor*film.h_W_m2K*area)+disc.discThickness_m/(4*geometry.steelConductivity_W_mK*area)))
    if(!seriesHeat.every(Number.isFinite))throw Error('Nonfinite finite-material film sensitivity')
    return {waterT_K:c.waterT,wallT_K:c.wallT,velocity_m_s:velocity,...film,discHalfCellHeat_W_forFilmFactors_half_one_two:seriesHeat}
  }))
  const result={sourceSha256:hash(source),calculationSha256:hash(prhrPreparationPython),parentSha256:hash(parentText),dependencies,inputSha256:hash(JSON.stringify(input)),mixing:input.mixing,...calculation,filmChecks}
  await Bun.write(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}
