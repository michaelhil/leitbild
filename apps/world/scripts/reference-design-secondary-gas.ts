/** Offline secondary receiver selection. Local native inversions/transfer coupons, not a cycle solver. */
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {gasConstants} from './reference-design-service-pump-mixture'

export const gasSourceVolumes=(steamDensity:number,steamPressureDerivative:number,ncPressure:number,temperature:number)=>{
 if(![steamDensity,steamPressureDerivative,ncPressure,temperature].every(Number.isFinite)||steamDensity<0||steamPressureDerivative<=0||ncPressure<0||temperature<=0)throw new Error('Invalid stable gas state')
 const denominator=steamDensity*steamPressureDerivative+ncPressure
 if(denominator<=0)throw new Error('Absent gas has no source-volume derivative')
 return {steam:steamPressureDerivative/denominator,air:gasConstants.air.R*temperature/denominator,nitrogen:gasConstants.nitrogen.R*temperature/denominator}
}
const calculation=String.raw`
import json,sys,math
import CoolProp,scipy
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import least_squares,brentq
from scipy.integrate import quad
species=json.load(sys.stdin);R={k:v['R'] for k,v in species.items()};cv={k:v['cv'] for k,v in species.items()};checks=[]
def check(name,ok):
 if not ok:raise ValueError(name)
 checks.append(name)
def wet(T,Vg,ma,mn,V,gravity=False):
 pv=P('P','T',T,'Q',1,'Water');pn=(ma*R['air']+mn*R['nitrogen'])*T/Vg;p=pv+pn
 if ma+mn==0:
  rl=P('D','T',T,'Q',0,'Water');ul=P('U','T',T,'Q',0,'Water');hl=P('H','T',T,'Q',0,'Water')
 else:
  rl=P('D','P',p,'T',T,'Water');ul=P('U','P',p,'T',T,'Water');hl=P('H','P',p,'T',T,'Water')
 rv=P('D','T',T,'Q',1,'Water');uv=P('U','T',T,'Q',1,'Water');hv=P('H','T',T,'Q',1,'Water')
 ml=(V-Vg)*rl;mv=Vg*rv;U=ml*ul+mv*uv+(ma*cv['air']+mn*cv['nitrogen'])*(T-298.15)
 pe=9.80665*ml*(-5+(V-Vg)/400) if gravity else 0
 gasmass=mv+ma+mn;hgas=(mv*hv+ma*(cv['air']*(T-298.15)+R['air']*T)+mn*(cv['nitrogen']*(T-298.15)+R['nitrogen']*T))/gasmass
 return dict(T=T,V=V,Vg=Vg,water=ml+mv,liquid=ml,steam=mv,air=ma,nitrogen=mn,U=U,E=U+pe,PE=pe,p=p,pv=pv,pNC=pn,rhoSteam=rv,hLiquid=hl,hGas=hgas)
def recover(M,E,ma,mn,V,guess,gravity=False):
 def residual(x):
  s=wet(x[0],x[1],ma,mn,V,gravity)
  return [(s['water']-M)/M,(s['E']-E)/max(abs(E),1e6)]
 fit=least_squares(residual,[guess[0]+.1,guess[1]*.99],bounds=([max(273.16,guess[0]-15),.001*V],[min(647.,guess[0]+15),.9999*V]),xtol=2e-13,ftol=2e-13,gtol=2e-13)
 s=wet(*fit.x,ma,mn,V,gravity)
 check('local wet inversion mass/energy',fit.success and abs(s['water']-M)<1e-6 and abs(s['E']-E)<.1)
 return s
known=[]
for name,T,V,Vg,pn in [('SG',P('T','P',6e6,'Q',0,'Water'),120.,48.,1e4),('SEP',P('T','P',.8e6,'Q',0,'Water'),100.,90.,1e3),('COND',313.15,6000.,5000.,1e3)]:
 ma=pn*.5*Vg/(R['air']*T);mn=pn*.5*Vg/(R['nitrogen']*T)
 s=wet(T,Vg,ma,mn,V,name=='COND');r=recover(s['water'],s['E'],ma,mn,V,[T,Vg],name=='COND')
 check(name+' independent-coordinate recovery',abs(r['T']-T)<1e-7 and abs(r['p']-s['p'])<.01)
 known.append(dict(name=name,prepared=s,recovered=r))
# The clean native branch is retained exactly, including the vacuum condenser.
clean=wet(313.15,5000.,0,0,6000.,True)
pnative=P('P','D',clean['water']/6000,'U',clean['U']/clean['water'],'Water')
check('zero NC native water regression',abs(pnative-clean['p'])<.001)
# Actual separated gas parcel, not whole-cell composition. Both stores remain finite.
donor=known[0]['prepared'];receiver=known[2]['prepared'];dm=10.;mg=donor['steam']+donor['air']+donor['nitrogen']
parcel={j:dm*donor[j]/mg for j in ['steam','air','nitrogen']};parcel['energy']=dm*donor['hGas']
dafter=recover(donor['water']-parcel['steam'],donor['E']-parcel['energy'],donor['air']-parcel['air'],donor['nitrogen']-parcel['nitrogen'],120,[donor['T'],donor['Vg']])
rafter=recover(receiver['water']+parcel['steam'],receiver['E']+parcel['energy'],receiver['air']+parcel['air'],receiver['nitrogen']+parcel['nitrogen'],6000,[receiver['T'],receiver['Vg']],True)
for j in ['water','air','nitrogen','E']:check('paired '+j+' transfer',abs(dafter[j]+rafter[j]-donor[j]-receiver[j])<(1 if j=='E' else 1e-5))
check('condensation retains both NC species',rafter['steam']-receiver['steam']<parcel['steam'] and rafter['air']>receiver['air'] and rafter['nitrogen']>receiver['nitrogen'])
# A covered liquid takeoff cannot purge NC; its enthalpy differs from separated gas.
liquidParcel=dict(water=10.,air=0.,nitrogen=0.,energy=10*rafter['hLiquid'])
check('liquid takeoff is neither NC purge nor gas enthalpy',liquidParcel['air']==0 and liquidParcel['nitrogen']==0 and rafter['hLiquid']<rafter['hGas'])
# Prescribed cooling endpoints: fixed water/NC/volume, required energy removed is measured.
cooling=[]
for massEach in [50.,250.]:
 loaded=wet(313.15,5000.,massEach,massEach,6000.,True)
 VgCold=brentq(lambda vg:wet(293.15,vg,massEach,massEach,6000.,True)['water']-loaded['water'],4800,5200)
 cold=wet(293.15,VgCold,massEach,massEach,6000.,True)
 check('cooling lowers pressure without deleting NC',cold['p']<loaded['p'] and cold['E']<loaded['E'])
 check('retained NC loading changes reset outcome',(cold['p']>10000)==(massEach==250))
 cooling.append(dict(before=loaded,after=cold,removedEnergy=loaded['E']-cold['E'],aboveTripInitially=loaded['p']>=15000,aboveResetAfter=cold['p']>=10000,meaning='Prescribed cooling endpoints and fixed illustrative NC loads, no elapsed-time admission or achieved CW duty'))
# Dry steam+air+N2 and pure NC inversions, no saturation lookup for absent water.
dry=[]
for mw in [0.,1.]:
 V=100.;T=450.;ma=2.;mn=3.
 def at(t):
  uw=P('U','D',mw/V,'T',t,'Water') if mw else 0.;pv=P('P','D',mw/V,'T',t,'Water') if mw else 0.
  return dict(T=t,p=pv+(ma*R['air']+mn*R['nitrogen'])*t/V,U=mw*uw+(ma*cv['air']+mn*cv['nitrogen'])*(t-298.15),pv=pv)
 initial=at(T);found=brentq(lambda t:at(t)['U']-initial['U'],430,470);final=at(found)
 check('dry/pure NC native recovery',abs(found-T)<1e-8 and final['p']>0 and (mw==0 or final['pv']<P('P','T',found,'Q',1,'Water')))
 dry.append(dict(water=mw,air=ma,nitrogen=mn,V=V,initial=initial,recovered=final))
# Source-volume derivative belongs only to the SG residence driver, not M/E sources.
s=donor;a=P('d(P)/d(D)|T','T',s['T'],'Q',1,'Water');D=s['rhoSteam']*a+s['pNC'];vbar={'steam':a/D,'air':R['air']*s['T']/D,'nitrogen':R['nitrogen']*s['T']/D}
check('source volume pure-steam limit',abs(a/(s['rhoSteam']*a)-1/s['rhoSteam'])<1e-12)
check('source volume matched-composition limit',abs(sum(vbar[j]*s[j] for j in vbar)-s['Vg'])<1e-8)
# One-sided removal stays on the stable vapor side; addition would enter supersaturation.
dm=-.001
def pGas(vg):return P('P','D',(s['steam']+dm)/vg,'T',s['T'],'Water')+(s['air']*R['air']+s['nitrogen']*R['nitrogen'])*s['T']/vg
vg2=brentq(lambda vg:pGas(vg)-s['p'],s['Vg']-.1,s['Vg'],xtol=1e-12)
check('steam source finite-volume perturbation',abs((vg2-s['Vg'])/dm/vbar['steam']-1)<1e-5)
check('source tangent perturbation is stable undersaturated vapor',P('P','D',(s['steam']+dm)/vg2,'T',s['T'],'Water')<s['pv'])
# One mixed HP expansion: actual gas takeoff composition, fixed species ratios.
ra=donor['air']/donor['steam'];rn=donor['nitrogen']/donor['steam'];mt=1+ra+rn;Tin=donor['T'];pin=donor['p']
def gasEntropy(T,pv,pa,pn):
 return (P('S','T',T,'Q',1,'Water')+ra*((cv['air']+R['air'])*math.log(T/298.15)-R['air']*math.log(pa/101325))+rn*((cv['nitrogen']+R['nitrogen'])*math.log(T/298.15)-R['nitrogen']*math.log(pn/101325)))/mt
sin=gasEntropy(Tin,donor['pv'],donor['pNC']*.5,donor['pNC']*.5);hin=donor['hGas']
def face(p,T):
 pv=P('P','T',T,'Q',1,'Water');vg=(ra*R['air']+rn*R['nitrogen'])*T/(p-pv);mv=vg*P('D','T',T,'Q',1,'Water');ml=1-mv
 hl=P('H','P',p,'T',T,'Water');sl=P('S','P',p,'T',T,'Water');rhol=P('D','P',p,'T',T,'Water');hv=P('H','T',T,'Q',1,'Water');sv=P('S','T',T,'Q',1,'Water')
 h=(ml*hl+mv*hv)/mt;entropy=(ml*sl+mv*sv)/mt
 for m,n in [(ra,'air'),(rn,'nitrogen')]:
  pj=m*R[n]*T/vg;h+=m*(cv[n]*(T-298.15)+R[n]*T)/mt;entropy+=m*((cv[n]+R[n])*math.log(T/298.15)-R[n]*math.log(pj/101325))/mt
 return dict(T=T,h=h,s=entropy,v=(ml/rhol+vg)/mt,liquidWaterFraction=ml,vaporWaterFraction=mv)
def wetUpper(p):
 ts=P('T','P',p,'Q',1,'Water')
 return brentq(lambda T:(ra*R['air']+rn*R['nitrogen'])*T/(p-P('P','T',T,'Q',1,'Water'))*P('D','T',T,'Q',1,'Water')-1,ts-20,ts-1e-6)
def at(p):
 upper=wetUpper(p);T=brentq(lambda T:face(p,T)['s']-sin,upper-30,upper,xtol=2e-11)
 return face(p,T)
pout=.8e6;ideal=at(pout);drop=hin-ideal['h'];integral,error=quad(lambda p:at(p)['v'],pout,pin,epsabs=.01,epsrel=1e-8)
check('mixed expansion effective-work budget',abs(drop-integral)<.001*drop)
hout=hin-.85*drop;upper=wetUpper(pout);actual=face(pout,brentq(lambda T:face(pout,T)['h']-hout,upper-30,upper,xtol=2e-11))
check('mixed turbine single work incidence',abs(actual['h']+.85*drop-hin)<1e-4 and actual['s']>=sin and 0<actual['liquidWaterFraction']<1)
expansion=dict(inletPressure=pin,outletPressure=pout,inletEnthalpy=hin,inletEntropy=sin,airPerWater=ra,nitrogenPerWater=rn,ideal=ideal,actual=actual,idealWork=drop,integratedWork=integral,workDefect=drop-integral,relativeDefect=(drop-integral)/drop,quadratureError=error,efficiency=.85)
print(json.dumps(dict(dependencies={'CoolProp':CoolProp.__version__,'SciPy':scipy.__version__},known=known,cleanCondenser=clean,transfer=dict(parcel=parcel,donorAfter=dafter,receiverAfter=rafter,coveredLiquidParcel=liquidParcel),retainedGasCooling=cooling,dry=dry,sourceVolume=dict(steamDensity=s['rhoSteam'],steamPressureDerivative=a,ncPressure=s['pNC'],temperature=s['T'],vbar=vbar,perturbedVolume=vg2),expansion=expansion,checks=checks)))
`
if(import.meta.main){
 const [wiki,python,receipt,...extra]=process.argv.slice(2)
 if(!wiki||!python||extra.length)throw new Error('Usage: secondary-gas <LD-01-directory> <research-python> [receipt.json]')
 const paths=[import.meta.path,resolve(import.meta.dir,'reference-design-service-pump-mixture.ts'),...['systems/steam-generation/thermodynamics.md','systems/steam-power/turbine-and-regeneration-dynamics.md','systems/steam-power/condenser-and-cooling.md','systems/feedwater/index.md','systems/primary-coolant/two-phase-and-breaks.md'].map(p=>resolve(wiki,p))]
 const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
 const sources=paths.map(path=>({path,sha256:hash(path)}))
 const result=spawnSync(python,['-c',calculation],{input:JSON.stringify(gasConstants),encoding:'utf8'})
 if(result.status!==0)throw new Error(result.stderr||'Secondary gas comparison failed')
 if(sources.some(s=>hash(s.path)!==s.sha256))throw new Error('Owner changed during comparison')
 const data=JSON.parse(result.stdout);const d=data.sourceVolume
 const independent=gasSourceVolumes(d.steamDensity,d.steamPressureDerivative,d.ncPressure,d.temperature)
 for(const j of ['steam','air','nitrogen'] as const)if(Math.abs(independent[j]-d.vbar[j])>1e-12)throw new Error('Independent source-volume mismatch')
 const output={scope:'Local receiver and transfer selection; no whole-cycle trajectory',sources,...data}
 if(receipt)await Bun.write(receipt,JSON.stringify(output,null,2)+'\n')
 console.log(JSON.stringify(output,null,2))
}
