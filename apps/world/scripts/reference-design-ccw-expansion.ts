/** Bounded CCW vessel/pressure selection; no whole-loop transient or live plant. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
export {advanceReliefLift} from './reference-design-rhr-local-relief'

export const reliefDemand=(differential:number,previous:boolean,opening:number,reseat:number)=>{
  if(![differential,opening,reseat].every(Number.isFinite)||reseat<=0||opening<=reseat)throw new Error('Invalid relief differential')
  return differential>=opening?true:differential<=reseat?false:previous
}
export function parseExpansion(document:string){
  const blocks=[...document.matchAll(/```reference-ccw-expansion\s*\n([\s\S]*?)\n```/g)]
  if(blocks.length!==1)throw new Error('Expected one CCW expansion record')
  const b=JSON.parse(blocks[0]![1]!) as Record<string,number>
  const fields=['vesselVolume_m3','area_m2','floor_m','initialLiquid_m3','initialPressure_Pa','initialTemperature_K','sideBranchCdA_m2','equipmentPressure_Pa','equipmentTemperature_K','reliefOpenDifferential_Pa','reliefReseatDifferential_Pa','reliefCdA_m2','reliefStroke_s','outfallElevation_m','referenceOutfallPressure_Pa']
  if(Object.keys(b).length!==fields.length||Object.keys(b).some(k=>!fields.includes(k))||fields.some(k=>!Number.isFinite(b[k]))||fields.filter(k=>k!=='floor_m').some(k=>b[k]!<=0)||b.initialLiquid_m3!>=b.vesselVolume_m3!||b.reliefReseatDifferential_Pa!>=b.reliefOpenDifferential_Pa!)throw new Error('Invalid CCW expansion record')
  return b
}
const calculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import brentq,least_squares
from scipy.integrate import quad
i=json.load(sys.stdin);b=i['basis'];cells=i['cells'];g=9.80665;R=287.;cv=718.;tref=298.15
V=b['vesselVolume_m3'];A=b['area_m2'];z0=b['floor_m'];p0=b['initialPressure_Pa'];T0=b['initialTemperature_K'];Vg0=V-b['initialLiquid_m3'];pv0=P('P','T',T0,'Q',1,'Water');ma=(p0-pv0)*Vg0/(R*T0)
checks=[]
def check(n,ok):
 if not ok:raise ValueError(n)
 checks.append(n)
def vessel(T,Vg,air=ma,nitrogen=0.):
 pv=P('P','T',T,'Q',1,'Water');p=pv+(air*R+nitrogen*296.8)*T/Vg;rl=P('D','P',p,'T',T,'Water');rv=P('D','T',T,'Q',1,'Water');vl=V-Vg;ml=rl*vl;mv=rv*Vg
 zl=z0+vl/(2*A);zi=z0+vl/A;zg=(zi+z0+V/A)/2
 U=ml*P('U','P',p,'T',T,'Water')+mv*P('U','T',T,'Q',1,'Water')+(air*cv+nitrogen*742)*(T-tref)
 PE=g*(ml*zl+(mv+air+nitrogen)*zg)
 if zi==0:datum=p
 else:
  hh=P('H','P',p,'T',T,'Water');ss=P('S','P',p,'T',T,'Water')
  datum=brentq(lambda pp:P('H','P',pp,'S',ss,'Water')-hh-g*zi,p-1e4,p+1e4)
 return dict(p=p,T=T,Vg=Vg,Vl=vl,Mw=ml+mv,Ml=ml,Mv=mv,Ma=air,Mn=nitrogen,U=U,PE=PE,E=U+PE,pDatum=datum,zi=zi)
initial=vessel(T0,Vg0)
check('Wet initial total pressure and volume',abs(initial['p']-p0)<1e-6 and initial['Vl']==5)
check('Initial air is corrected, not added to old pressure',ma<p0*Vg0/(R*T0) and initial['Mv']>0)
# Existing A-only nonuniform main/jacket receipt, plus explicitly selected .03m3 casing.
for c in cells:
 check(c['name']+' native prepared mass',abs(c['M_kg']-c['V_m3']*P('D','P',c['p_Pa'],'T',c['T_K'],'Water'))<1e-4)
cells.append(dict(name='CCW.A pump casing',V_m3=.03,p_Pa=p0,T_K=T0,M_kg=.03*P('D','P',p0,'T',T0,'Water')))
M0=sum(c['M_kg'] for c in cells)+initial['Mw']
def total(Tshift,Vg):
 v=vessel(T0+Tshift,Vg);p=v['pDatum'];mass=v['Mw'];energy=v['E']
 for c in cells:
  pc=p+c['p_Pa']-p0;tc=c['T_K']+Tshift;rho=P('D','P',pc,'T',tc,'Water');m=c['V_m3']*rho
  mass+=m;energy+=m*P('U','P',pc,'T',tc,'Water')
 return dict(vessel=v,waterMass=mass,energy=energy)
base=total(0,Vg0)
check('All main jacket and casing inventories counted',abs(sum(c['V_m3'] for c in cells)-513.03)<1e-8 and abs(base['waterMass']-M0)<1e-4)
warmV=brentq(lambda vg:total(5,vg)['waterMass']-M0,1.,8.,xtol=1e-11);warm=total(5,warmV)
check('Five-kelvin fixed-inventory expansion',0<warmV<Vg0 and warm['vessel']['pDatum']>p0 and abs(warm['waterMass']-M0)<1e-5)
# Static nominal-speed shutoff is a local pressure screen, not imposed pump flow.
def outlet_at_height(p,T):
 h=P('H','P',p,'T',T,'Water');s=P('S','P',p,'T',T,'Water');target=h-g*b['outfallElevation_m']
 return brentq(lambda pp:P('H','P',pp,'S',s,'Water')-target,p-1e5,p),target,s
def pressure_screen(v):
 ps=v['pDatum'];T=v['T'];rise=.375e6*P('D','P',ps,'T',T,'Water')/1000;pd=ps+rise;pv,hh,s=outlet_at_height(pd,T)
 return dict(suction=ps,discharge=pd,valveInlet=pv,outfall=b['referenceOutfallPressure_Pa'],springDifferential=pv-b['referenceOutfallPressure_Pa'],liftEnthalpy=hh,sourceEntropy=s)
normalP=pressure_screen(initial);warmP=pressure_screen(warm['vessel'])
check('Prepared and small-warm pressure below relief opening',max(normalP['springDifferential'],warmP['springDifferential'])<b['reliefOpenDifferential_Pa'])
def opening_state(shift):
 vg=brentq(lambda vg:pressure_screen(vessel(T0+shift,vg))['springDifferential']-b['reliefOpenDifferential_Pa'],1.,9.9)
 return total(shift,vg)
hot=opening_state(40);released=M0-hot['waterMass'];hotP=pressure_screen(hot['vessel'])
check('Hot opening comparison loses real water',released>0 and hotP['discharge']<b['equipmentPressure_Pa'])
coldFull=total(0,10.);missingCold=coldFull['waterMass']-hot['waterMass']
check('Cooling without makeup cannot restore liquid-full circuit',missingCold>0)
# Isolated native vessel receives one actual water parcel, conservatively; not forced loop temperatures.
dm=250.;donorP=.7e6;donorT=313.15;h=P('H','P',donorP,'T',donorT,'Water');targetM=initial['Mw']+dm;targetE=initial['E']+dm*h
def residual(x):
 v=vessel(x[0],x[1]);return [(v['Mw']-targetM)/5000,(v['E']-targetE)/1e8]
sol=least_squares(residual,[T0+.5,Vg0-.25],bounds=([T0-2,1.],[T0+5,9.]),xtol=1e-13,ftol=1e-13,gtol=1e-13)
received=vessel(*sol.x);massDefect=received['Mw']-targetM;energyDefect=received['E']-targetE
check('Finite water displacement native mass and energy',sol.success and abs(massDefect)<1e-6 and abs(energyDefect)<.1 and received['Vg']<Vg0)
# One actual wet-gas vent parcel at 0.7MPa/40C, not gas relabeled as water or nitrogen.
gp=.7e6;gt=313.15;gv=.002;gpv=P('P','T',gt,'Q',1,'Water')
parcel={'water':gv*P('D','T',gt,'Q',1,'Water'),'air':.5*(gp-gpv)*gv/(R*gt),'nitrogen':.5*(gp-gpv)*gv/(296.8*gt)}
gasEnergy=parcel['water']*P('H','T',gt,'Q',1,'Water')+parcel['air']*(cv*(gt-tref)+R*gt)+parcel['nitrogen']*(742*(gt-tref)+296.8*gt)+sum(parcel.values())*g*(z0+V/A)
def gasResidual(x):
 v=vessel(x[0],x[1],ma+parcel['air'],parcel['nitrogen']);return [(v['Mw']-initial['Mw']-parcel['water'])/5000,(v['E']-initial['E']-gasEnergy)/1e8]
gs=least_squares(gasResidual,[T0,Vg0],bounds=([T0-2,1.],[T0+5,9.]),xtol=1e-13,ftol=1e-13,gtol=1e-13);gasReceived=vessel(*gs.x,ma+parcel['air'],parcel['nitrogen'])
gasMassDefect=gasReceived['Mw']-initial['Mw']-parcel['water'];gasEnergyDefect=gasReceived['E']-initial['E']-gasEnergy
check('Mixed vent conserves separate water air nitrogen',abs(gasMassDefect)<1e-6 and gasReceived['Ma']==ma+parcel['air'] and gasReceived['Mn']==parcel['nitrogen']>0)
check('Mixed vent native total energy recovery',gs.success and abs(gasEnergyDefect)<.1)
# Exact ideal-air partial-pressure work identity, separate from steam phase exchange.
airWork=quad(lambda vg:ma*R*T0/vg,4.,5.,epsabs=1e-7)[0];airAnalytic=ma*R*T0*math.log(5/4)
check('Air compression work and common-T reciprocal heat',abs(airWork-airAnalytic)<1e-7 and airWork>0)
# Native liquid outlet capacity at the frozen warm opening point; no relief trajectory.
pb=b['referenceOutfallPressure_Pa'];rhoOut=P('D','P',pb,'S',hotP['sourceEntropy'],'Water');hOut=P('H','P',pb,'S',hotP['sourceEntropy'],'Water');flux=b['reliefCdA_m2']*rhoOut*math.sqrt(2*(hotP['liftEnthalpy']-hOut))
expansionDemand=P('ISOBARIC_EXPANSION_COEFFICIENT','P',hotP['discharge'],'T',T0+40,'Water')*31.920e6/P('C','P',hotP['discharge'],'T',T0+40,'Water')
check('Selected area has finite frozen liquid capacity',flux>expansionDemand>0)
exportMass=.1;exportEnergy=exportMass*(hotP['liftEnthalpy']+g*b['outfallElevation_m']);sourceEnergy=exportMass*P('H','P',hotP['discharge'],'T',T0+40,'Water')
check('Outfall lift and enthalpy export counted once',abs(exportEnergy-sourceEnergy)<1e-5)
highBackPressure=.6e6;requiredLocal=highBackPressure+b['reliefOpenDifferential_Pa']
check('Raised outfall prevents opening below rating',requiredLocal>b['equipmentPressure_Pa'])
print(json.dumps(dict(libraries=dict(CoolProp=CoolProp.__version__,SciPy=scipy.__version__),initial=initial,oldDryAirMass=p0*Vg0/(R*T0),preparedCells=cells,baseWaterMass=M0,normalPressure=normalP,warmFiveK=warm,warmPressure=warmP,hotOpening=dict(state=hot,pressure=hotP,releasedWater_kg=released,meaning='Prescribed40K increase at each original thermal coordinate; hypothetical opening-pressure endpoint, not achieved relief trajectory'),coldRestoration=dict(liquidFullThreshold=coldFull,missingWater_kg=missingCold,meaning='Missing water means gas must enter main circuit through exposed vessel bottom; no negative tank water or reset'),waterParcel=dict(mass=dm,donorPressure=donorP,donorTemperature=donorT,donorEnthalpy=h,received=received,massDefect=massDefect,energyDefect=energyDefect),gasParcel=dict(donorPressure=gp,donorTemperature=gt,volume=gv,species=parcel,totalEnthalpyEnergy=gasEnergy,received=gasReceived,massDefect=gasMassDefect,energyDefect=gasEnergyDefect),airWork=dict(isothermalCompressionWork=airWork,analytic=airAnalytic,airEnergyChange=0,heatToCommonLiquid=airWork,meaning='Ideal-air-only fixedT compression; full steam/interface work remains in conservative vessel state'),relief=dict(liquidCapacity_kg_s=flux,frozen31920kWExpansionDemand_kg_s=expansionDemand,exportParcelMass=exportMass,exportTotalEnergy=exportEnergy,sourceEnergy=sourceEnergy,raisedBackPressure=highBackPressure,requiredValveInlet=requiredLocal),checks=checks)))
`
if(import.meta.main){
  const [owner,preparation,python,receipt,...extra]=process.argv.slice(2)
  if(!owner||!preparation||!python||extra.length)throw new Error('Usage: <support-owner.md> <secondary-preparation.json> <python> [receipt.json]')
  const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
  const sources=[owner,preparation,import.meta.path,resolve(import.meta.dir,'reference-design-rhr-local-relief.ts')].map(path=>({path,sha256:hash(path)}))
  const basis=parseExpansion(readFileSync(owner,'utf8'))
  const expected=['supply','return','cooler','RCP.A1 jacket','RCP.B1 jacket','FW.P1 jacket','COND.P jacket','CHARGE.P jacket'].map(s=>'CCW.A '+s)
  const all=JSON.parse(readFileSync(preparation,'utf8')).stores
  if(!Array.isArray(all))throw new Error('Missing prepared stores')
  const cells=expected.map(name=>{
    const matches=all.filter((c:{name:string})=>c.name===name)
    if(matches.length!==1||!['V_m3','p_Pa','T_K','M_kg','U_J'].every(k=>Number.isFinite(matches[0][k])))throw new Error('Invalid prepared store '+name)
    return matches[0]
  })
  const result=spawnSync(python,['-c',calculation],{input:JSON.stringify({basis,cells}),encoding:'utf8'})
  if(result.status!==0)throw new Error(result.stderr||'CCW comparison failed')
  if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Source changed during comparison')
  const output={scope:'A-only prepared inventory and prescribed state/parcel comparisons; no whole-loop heat-loss or valve transient',sources,basis,...JSON.parse(result.stdout)}
  if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
  console.log(JSON.stringify(receipt?{receipt,checks:output.checks.length,normal:output.normalPressure,warm:output.warmPressure,released:output.hotOpening.releasedWater_kg,coldDeficit:output.coldRestoration.missingWater_kg,relief:output.relief}:output,null,2))
}
