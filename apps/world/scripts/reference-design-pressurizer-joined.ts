/** Offline sealed hydrostatic vapor/film/steel/receiving-pool reference; no live plant. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parsePressurizerBoundaries } from './reference-design-pressurizer-boundaries'
import { parseSpatialBasis } from './reference-design-pressurizer-spatial'
import { phaseStorageThermodynamics,parsePhaseStorageBasis } from './reference-design-pressurizer-phase-storage'
import { filmDefinitions } from './reference-design-pressurizer-film'
const schema=z.object({duration_s:z.number().positive().finite(),timeStep_s:z.number().positive().finite(),
  axialCells:z.number().int().min(4),radialCells:z.number().int().min(4),upperSuperheat_K:z.number().positive().finite()}).strict()
export function parseJoinedPressurizer(text:string){
  const blocks=[...text.matchAll(/^```reference-pressurizer-joined\s*\n([\s\S]*?)^```\s*$/gm)]
  if(blocks.length!==1)throw Error('Expected one reference-pressurizer-joined block')
  const result=schema.parse(JSON.parse(blocks[0]![1]!))
  if(result.timeStep_s>result.duration_s)throw Error('Step exceeds joined reference duration')
  return result
}
export const joinedDefinitions=phaseStorageThermodynamics+filmDefinitions+String.raw`
from scipy.optimize import root
from functools import lru_cache
cfg=b['joined'];A=math.pi*r['innerRadius_m']**2;height=r['height_m'];Lsource=r['statedLevel_m'];p0=b['pressure_MPa'];sourceT=r['fluidTemperature_K']
def enthalpy(q):return 1000*q.u+q.P*1e6*q.v
@lru_cache(maxsize=512)
def sat(p):
    q=W(P=p,x=0);return q.T,enthalpy(q)
@lru_cache(maxsize=128)
def saturationPressure(s):return brentq(lambda p:W(P=p,x=0).s-s,.1,16,xtol=1e-10)
def annulus(d):return math.pi*(2*r['innerRadius_m']*d-d*d)
def contact_surface_root(balance,oldSteel,liquidTemperatures,vaporSaturation=None,liquidSaturation=()):
    temperatures=[*oldSteel,*liquidTemperatures]
    lower=float(min(temperatures));upper=float(max(temperatures)) if vaporSaturation is None else vaporSaturation
    if liquidSaturation:upper=min(upper,*liquidSaturation)
    if lower>upper:raise ValueError('No shared nonboiling surface interval')
    return lower if lower==upper else brentq(balance,lower,upper,xtol=1e-10)
def submerged_convection(pressure,bulk,surface,length):
    if length<=0 or not all(math.isfinite(v) for v in [pressure,bulk,surface,length]):raise ValueError('Invalid submerged contact')
    ts=sat(pressure)[0]
    if surface>ts:raise ValueError(f'Submerged wall boiling is not selected: p={pressure}, bulk={bulk}, surface={surface}, Tsat={ts}')
    drive=bulk-surface
    if drive==0:return dict(h=0.,Ra=0.,layerOverRadius=None,flux=0.)
    temp=(bulk+surface)/2
    if temp>=ts:raise ValueError('No subcooled liquid boundary-layer property state')
    pp=pressure*1e6
    # The guarded subcooled liquid branch is explicit, avoiding ambiguous near-saturation PT flashes.
    dens=CP.PropsSI('D','P',pp,'T|liquid',temp,'Water');cap=CP.PropsSI('C','P',pp,'T|liquid',temp,'Water');visc=CP.PropsSI('V','P',pp,'T|liquid',temp,'Water');cond=CP.PropsSI('L','P',pp,'T|liquid',temp,'Water')
    beta=CP.PropsSI('ISOBARIC_EXPANSION_COEFFICIENT','P',pp,'T|liquid',temp,'Water')
    nu=visc/dens;alpha=cond/(dens*cap);Pr=nu/alpha;Gr=g*beta*abs(drive)*length**3/nu**2;Ra=Gr*Pr
    Nu=(.825+.387*Ra**(1/6)/(1+(.492/Pr)**(9/16))**(8/27))**2
    h=Nu*cond/length
    return dict(h=h,Ra=Ra,layerOverRadius=3*length*(4/Gr)**.25/r['innerRadius_m'],flux=h*drive)
def exposure(hi,lo,L,oldL,oldThickness):
    low=max(L,lo);oldLow=max(oldL,lo)
    length=max(0.,hi-low);sweptLength=max(0.,min(L,hi)-oldLow)
    return dict(lo=low,ell=length,sweptVolume=annulus(oldThickness)*sweptLength,
        sweepZ=oldLow+sweptLength/2,poolOutlet=length>0 and low==L)
def route_outflow(contact,out,energy):
    if contact['ell']==0:
        if out!=0 or energy!=0:raise ValueError('Submerged strip cannot generate runoff')
        return 0.,0.,0.,0.
    return (0.,0.,out,energy) if contact['poolOutlet'] else (out,energy,0.,0.)
def submerged_strip(contact,incoming,oldSteel,wallSolve,dt,oldEnergy,sweptEnergy,pressure):
    if contact['ell']!=0 or incoming!=0:raise ValueError('Runoff incorrectly routed below physical pool surface')
    route_outflow(contact,0.,0.)
    lo=float(min(oldSteel));hi=float(max(oldSteel))
    surface=lo if hi==lo else brentq(lambda t:wallSolve(oldSteel,t,dt)[1][0],lo,hi,xtol=1e-10)
    steel,qw,rw=wallSolve(oldSteel,surface,dt)
    return dict(steel=steel,surface=surface,condensation=0.,remainingFilmMass=0.,
        residual=max(abs(oldEnergy-sweptEnergy+pressure*contact['sweptVolume']),rw,abs(qw[0]*dt)))
def run(n,nr,dt,nq=4,cold=False,zero=False,bandCount=None,submerged=False,subcooling=0.):
    gx,gw=np.polynomial.legendre.leggauss(nq)
    def gauss(lo,hi):return lo+(gx+1)*(hi-lo)/2,gw*(hi-lo)/2
    edges=sorted(set([float(z) for z in np.linspace(0,height,(bandCount or r['cellCount'])+1) if z<Lsource]+[Lsource]+([Lsource/2] if cold else [])))
    native=[];ps=p0
    for lo,hi in reversed(list(zip(edges[:-1],edges[1:]))):
        temp=sourceT-subcooling-(b['phase']['coldLowerOffset_K'] if cold and hi<=Lsource/2 else 0)
        sol=solve_ivp(lambda z,y:[-W(P=float(y[0]),T=temp).rho*g/1e6],(hi,lo),[ps],rtol=1e-10,atol=1e-12,dense_output=True)
        zs,weights=gauss(lo,hi);qs=[W(P=float(sol.sol(z)[0]),T=temp) for z in zs]
        mass=sum(w*q.rho*A for w,q in zip(weights,qs));s=sum(w*q.rho*A*q.s for w,q in zip(weights,qs))/mass
        native.append(dict(mass=mass,entropy=s));ps=float(sol.y[0,-1])
    native.reverse();Mbase=sum(v['mass'] for v in native);sR0=native[-1]['entropy']
    def pool(ps,sR,mu,sLower=None):
        material=[dict(c) for c in native];material[-1]['mass']+=mu;material[-1]['entropy']=sR
        if sLower is not None:
            for c,s in zip(material[:-1],sLower):c['entropy']=s
        if material[-1]['mass']<=0:raise ValueError('Receiving band exhausted')
        total=Mbase+mu;bottom=0.;V=U=PE=steam=0.;temps=[];bands=[]
        for c in material:
            top=bottom+c['mass'];cross=total-(saturationPressure(c['entropy'])-ps)*1e6*A/g
            splits=[bottom]+([cross] if bottom<cross<top else [])+[top];eu=ep=vv=tmean=0.;below=V;quality=void=0.
            for a,z in zip(splits[:-1],splits[1:]):
                points,weights=gauss(a,z)
                for m,w in zip(points,weights):
                    q=W(P=ps+g*(total-m)/A/1e6,s=c['entropy'])
                    if q.x>=1:raise ValueError('Lower material exhausted liquid')
                    volume=w*q.v;energy=w*q.u*1000+w*g/A*(total-m)*q.v
                    V+=volume;U+=w*q.u*1000;PE+=w*g/A*(total-m)*q.v;steam+=w*q.x;temps.append(q.T);vv+=volume;eu+=w*q.u*1000;ep+=w*g/A*(top-m)*q.v
                    tmean+=w*q.T;quality=max(quality,q.x)
                    if q.x>0:void=max(void,q.x*W(P=q.P,x=1).v/q.v)
            bands.append(dict(M=c['mass'],s=c['entropy'],V=vv,E=eu+ep+g/A*c['mass']*below,
                belowVolume=below,aboveVolume=V,temperatureMean=tmean/c['mass'],qualityMax=quality,voidMax=void,pressureBelow=(ps+g*(total-bottom)/A/1e6)*1e6,pressureAbove=(ps+g*(total-top)/A/1e6)*1e6));bottom=top
        return dict(M=total,V=V,E=U+PE,L=V/A,steam=steam,temperatureMin=min(temps),temperatureMax=max(temps),bands=bands)
    initialPool=pool(p0,sR0,0);L0=initialPool['L'];dx=(height-L0)/n
    ze=np.linspace(height,L0,n+1);sv0=W(P=p0,T=W(P=p0,x=1).T+cfg['upperSuperheat_K']).s
    if submerged:ze=np.r_[ze,np.array(edges[:-1])[::-1]]
    wallDefinitions=[make_wall(nr,float(ze[i]-ze[i+1])) for i in range(len(ze)-1)]
    wallMass=np.array([item[1] for item in wallDefinitions]);nwall=len(wallDefinitions)
    def vaporProfile(ps,sv,L):
        sol=solve_ivp(lambda z,y:[-W(P=float(y[0]),s=sv).rho*g/1e6],(L,height),[ps],rtol=1e-10,atol=1e-12,dense_output=True)
        if not sol.success:raise ValueError(sol.message)
        def state(z):return W(P=float(sol.sol(z)[0]),s=sv)
        return state
    def vapor(profile,L,ds):
        mass=energy=volume=0.;margin=1e9
        for i,d in enumerate(ds):
            lo=max(L,ze[i+1]);hi=ze[i]
            if hi<=lo:continue
            zs,weights=gauss(lo,hi)
            for z,w in zip(zs,weights):
                q=profile(z);margin=min(margin,q.T-sat(q.P)[0]);a=A-annulus(d)
                mass+=w*a*q.rho;energy+=w*a*q.rho*(q.u*1000+g*z);volume+=w*a
        if margin<0:raise ValueError('Upper dry-vapor branch boundary reached')
        return dict(M=mass,E=energy,V=volume,minimumSuperheat_K=margin)
    def filmState(ds,surfaces,profile,L):
        M=E=V=0.;cells=[]
        for i,d in enumerate(ds):
            lo=max(L,ze[i+1]);hi=ze[i];ell=max(0,hi-lo);z=(hi+lo)/2
            if ell==0:
                cells.append(dict(M=0.,E=0.,V=0.,hm=0.,ho=0.,p=0.,z=z,ell=0.,lo=lo,hi=hi));continue
            q=profile(z);ts,hfLocal=sat(q.P);hm=hfLocal-cp*(ts-surfaces[i])/2;ho=hfLocal-3*cp*(ts-surfaces[i])/8
            volume=annulus(d)*ell;mass=rho*volume;energy=mass*(hm-q.P*1e6/rho+g*z)
            M+=mass;E+=energy;V+=volume;cells.append(dict(M=mass,E=energy,V=volume,hm=hm,ho=ho,p=q.P,z=z,ell=ell,lo=lo,hi=hi))
        return dict(M=M,E=E,V=V,cells=cells)
    profile=vaporProfile(p0,sv0,L0);ds=np.zeros(nwall)
    def initialSurface(i):
        if not zero:return Tw0
        if ze[i+1]>=L0:return sat(profile((ze[i]+ze[i+1])/2).P)[0]
        overlaps=[(max(0.,min(ze[i],v['aboveVolume']/A)-max(ze[i+1],v['belowVolume']/A)),v['temperatureMean']) for v in initialPool['bands']]
        return sum(length*temp for length,temp in overlaps)/sum(length for length,_ in overlaps)
    surfaces=np.array([initialSurface(i) for i in range(nwall)],dtype=float)
    wall=np.repeat(surfaces[:,None],nr,axis=1);initialWall=wall.copy();v0=vapor(profile,L0,ds);f0=filmState(ds,surfaces,profile,L0)
    totalMass=initialPool['M']+v0['M'];E0=initialPool['E']+v0['E'];old=dict(ps=p0,sv=sv0,sR=sR0,mu=0.,pool=initialPool,vapor=v0,film=f0,ds=ds,surfaces=surfaces,wall=wall,profile=profile)
    old['sLower']=np.array([c['entropy'] for c in native[:-1]])
    rows=[];steps=math.ceil(cfg['duration_s']/dt);dt=cfg['duration_s']/steps;maximumEnergy=maximumMass=0.
    for step in range(steps):
        def candidate(x):
            ps,sv,sR,mu=x[:4];sLower=x[4:] if submerged else None;pl=pool(ps,sR,mu,sLower);L=pl['L'];dL=L-old['pool']['L']
            if L<L0-1e-8 or L>=height:raise ValueError('Outside selected rising-surface geometry')
            profile=vaporProfile(ps,sv,L);psbar=(ps+old['ps'])*.5e6
            newfilm=[];newwall=[];newsurfaces=[];incoming=0.;incomingH=0.;sourceM=sourceE=drainM=drainE=sweepM=sweepE=I=0.;local=0.;minimumCondensation=0.
            poolHeat=np.zeros(len(native));maximumH=maximumRa=maximumLayer=0.;contactArea=0.
            for i in range(nwall):
                wallSolve=wallDefinitions[i][0];wallHeight=float(ze[i]-ze[i+1])
                oldcell=old['film']['cells'][i];hi=ze[i];contact=exposure(hi,ze[i+1],L,old['pool']['L'],old['ds'][i]);lo=contact['lo'];ell=contact['ell']
                contacts=[]
                if submerged:
                    for j,band in enumerate(pl['bands']):
                        overlap=max(0.,min(hi,band['aboveVolume']/A)-max(ze[i+1],band['belowVolume']/A))
                        if overlap>0:contacts.append((j,overlap,band))
                contactArea+=C*sum(length for _,length,_ in contacts)
                def poolContact(surface):
                    exchanges=[]
                    for j,length,band in contacts:
                        pband=.5*(band['pressureBelow']+band['pressureAbove'])/1e6
                        law=submerged_convection(pband,band['temperatureMean'],surface,L)
                        exchanges.append((j,dt*C*length*law['flux'],law))
                    return exchanges
                def takePoolHeat(exchanges):
                    nonlocal maximumH,maximumRa,maximumLayer
                    for j,heat,law in exchanges:
                        poolHeat[j]-=heat;maximumH=max(maximumH,law['h']);maximumRa=max(maximumRa,law['Ra']);maximumLayer=max(maximumLayer,law['layerOverRadius'] or 0.)
                sweptVolume=contact['sweptVolume'];swept=rho*sweptVolume;sweepz=contact['sweepZ'];sweptEnergy=swept*(oldcell['hm']+g*sweepz)
                sweepM+=swept;sweepE+=sweptEnergy
                if ell==0:
                    if submerged:
                        if incoming!=0:raise ValueError('Ghost runoff below surface')
                        def liquidInterface(surface):
                            exchanges=poolContact(surface);steel,qw,rw=wallSolve(old['wall'][i],surface,dt)
                            return qw[0]*dt-sum(q for _,q,_ in exchanges),(exchanges,steel,qw,rw)
                        surface=contact_surface_root(lambda t:liquidInterface(t)[0],old['wall'][i],[v['temperatureMean'] for _,_,v in contacts],liquidSaturation=[sat(.5*(v['pressureBelow']+v['pressureAbove'])/1e6)[0] for _,_,v in contacts])
                        mismatch,(exchanges,steel,qw,rw)=liquidInterface(surface);takePoolHeat(exchanges)
                        newfilm.append(0.);newwall.append(steel);newsurfaces.append(surface)
                        local=max(local,abs(mismatch),rw,abs(oldcell['E']-sweptEnergy+psbar*sweptVolume))
                        continue
                    inactive=submerged_strip(contact,incoming,old['wall'][i],wallSolve,dt,oldcell['E'],sweptEnergy,psbar)
                    newfilm.append(0.);newwall.append(inactive['steel']);newsurfaces.append(inactive['surface'])
                    local=max(local,inactive['residual'])
                    continue
                z=(hi+lo)/2;q=profile(z);ts,hfLocal=sat(q.P);hv=enthalpy(q);pbar=(q.P+oldcell['p'])*.5e6
                oldd=old['ds'][i]
                def interface(surface):
                    hm=hfLocal-cp*(ts-surface)/2;ho=hfLocal-3*cp*(ts-surface)/8
                    def terms(d):
                        volume=annulus(d)*ell;mass=rho*volume;out=dt*C*B*d**3 if ell else 0.;cond=mass-oldcell['M']+out+swept-incoming
                        work=psbar*sweptVolume-pbar*(annulus(d)-annulus(oldd))*ell
                        stored=mass*(hm-q.P*1e6/rho+g*z)
                        heat=cond*(hv+g*z)+incoming*incomingH-out*(ho+g*lo)-sweptEnergy+work-(stored-oldcell['E'])
                        return cond,out,heat,work,stored
                    def balance(d):return terms(d)[2]*(d+oldd)-2*dt*C*ell*k*(ts-surface)
                    if ell==0:d=oldd
                    elif zero:d=0.
                    else:
                        upper=max(oldd,1e-9)
                        while balance(upper)<0:
                            upper*=2
                            if upper>=r['innerRadius_m']:raise ValueError('No admissible thin-film root')
                        d=brentq(balance,0,upper,xtol=1e-15)
                    cond,out,heat,work,stored=terms(d);temperatures,wallQ,res=wallSolve(old['wall'][i],surface,dt,inner_fraction=1. if submerged else min(1.,ell/wallHeight))
                    exchanges=poolContact(surface)
                    return wallQ[0]*dt-heat-sum(q for _,q,_ in exchanges),(d,cond,out,heat,work,stored,temperatures,res,ho,hm,exchanges)
                if zero:surface=old['surfaces'][i]
                else:surface=contact_surface_root(lambda t:interface(t)[0],old['wall'][i],[v['temperatureMean'] for _,_,v in contacts],ts,[sat(.5*(v['pressureBelow']+v['pressureAbove'])/1e6)[0] for _,_,v in contacts])
                mismatch,(d,cond,out,heat,work,stored,temperatures,res,ho,hm,exchanges)=interface(surface);takePoolHeat(exchanges)
                local=max(local,abs(mismatch),res)
                minimumCondensation=min(minimumCondensation,cond)
                if not math.isfinite(d) or d<0 or d>=r['innerRadius_m']:raise ValueError('Invalid film geometry')
                newfilm.append(d);newwall.append(temperatures);newsurfaces.append(surface)
                sourceM+=cond;sourceE+=cond*(hv+g*z);I+=pbar*(annulus(d)-annulus(oldd))*ell
                incoming,incomingEnergy,poolOut,poolEnergy=route_outflow(contact,out,out*(ho+g*lo))
                incomingH=incomingEnergy/incoming if incoming else 0.
                drainM+=poolOut;drainE+=poolEnergy
            newfilm=np.array(newfilm);newwall=np.array(newwall);newsurfaces=np.array(newsurfaces)
            vf=vapor(profile,L,newfilm);ff=filmState(newfilm,newsurfaces,profile,L)
            sweptV=sweepM/rho;Wp=-psbar*A*dL;Wf=psbar*sweptV-I;Wv=psbar*(A*dL-sweptV)+I
            ep=pl['E']-old['pool']['E']-drainE-sweepE-Wp-sum(poolHeat)
            ev=vf['E']-old['vapor']['E']+sourceE-Wv
            em=pl['M']+vf['M']+ff['M']-totalMass;receipt=mu-old['mu']-drainM-sweepM
            adiabatic=[]
            for a,c in zip(old['pool']['bands'][:-1],pl['bands'][:-1]):
                work=.5*(a['pressureBelow']+c['pressureBelow'])*(c['belowVolume']-a['belowVolume'])-.5*(a['pressureAbove']+c['pressureAbove'])*(c['aboveVolume']-a['aboveVolume'])
                adiabatic.append(c['E']-a['E']-work-poolHeat[len(adiabatic)])
            equations=[em,receipt,ep/1e5,ev/1e5]+([v/1e5 for v in adiabatic] if submerged else [])
            return np.array(equations),dict(ps=ps,sv=sv,sR=sR,mu=mu,sLower=sLower,pool=pl,vapor=vf,film=ff,ds=newfilm,surfaces=newsurfaces,wall=newwall,profile=profile,
                sourceMass=sourceM,sourceEnergy=sourceE,drainMass=drainM,drainEnergy=drainE,sweptMass=sweepM,sweptEnergy=sweepE,
                poolWork=Wp,filmWork=Wf,vaporWork=Wv,poolResidual=ep,vaporResidual=ev,massResidual=em,receiptResidual=receipt,localResidual=local,
                minimumCondensation=minimumCondensation,adiabaticWorkResiduals=adiabatic,volumeResidual=pl['V']+vf['V']+ff['V']-A*height,
                poolHeat=poolHeat,maximumH=maximumH,maximumRa=maximumRa,maximumLayer=maximumLayer,submergedAreaResidual=contactArea-C*L if submerged else 0.)
        guess=np.array([old['ps']-(0 if zero else .0005),old['sv'],old['sR'],old['mu']+float(dt*C*B*old['ds'][-1]**3)])
        if submerged:guess=np.r_[guess,old['sLower']]
        solved=root(lambda x:candidate(x)[0],guess,options={'xtol':1e-9})
        residual,new=candidate(solved.x)
        wallE=float(np.sum(steel_de(new['wall'],initialWall)*wallMass));energy=new['pool']['E']+new['vapor']['E']+new['film']['E']+wallE-E0
        peakRe=4*B*float(max(new['ds']))**3/mu
        if not all(math.isfinite(v) for v in [*residual,energy,peakRe,new['localResidual'],new['volumeResidual'],*new['adiabaticWorkResiduals'],new['submergedAreaResidual']]):raise ValueError('Nonfinite joined physical residual')
        if max(abs(new['poolResidual']),abs(new['vaporResidual']),abs(energy),new['localResidual'],*map(abs,new['adiabaticWorkResiduals']))>.05 or abs(new['massResidual'])>1e-9 or abs(new['receiptResidual'])>1e-9 or peakRe>=30 or new['minimumCondensation']<-1e-12 or abs(new['volumeResidual'])>1e-10 or new['pool']['L']<old['pool']['L']-1e-10:
            raise ValueError(dict(reason='Joined physical ledger/admission',step=step,residual=residual.tolist(),energy=energy,Re=peakRe,solver=solved.message))
        if abs(new['submergedAreaResidual'])>1e-10:raise ValueError('Submerged wall overlap lost physical area')
        maximumEnergy=max(maximumEnergy,abs(energy));maximumMass=max(maximumMass,abs(new['massResidual']))
        rows.append(dict(time_s=(step+1)*dt,pressureSurface_MPa=new['ps'],level_m=new['pool']['L'],vaporMass_kg=new['vapor']['M'],vaporSuperheatMin_K=new['vapor']['minimumSuperheat_K'],
            poolMass_kg=new['pool']['M'],poolSteamMass_kg=new['pool']['steam'],poolTemperatureMin_K=new['pool']['temperatureMin'],poolTemperatureMax_K=new['pool']['temperatureMax'],filmMass_kg=new['film']['M'],cumulativeReceipt_kg=new['mu'],
            innerWallMin_K=float(min(new['surfaces'])),innerWallMax_K=float(max(new['surfaces'])),wallEnergy_J=wallE,filmThicknessMax_m=float(max(new['ds'])),
            poolWork_J=new['poolWork'],vaporWork_J=new['vaporWork'],filmWork_J=new['filmWork'],sourceMass_kg=new['sourceMass'],sweptMass_kg=new['sweptMass'],drainMass_kg=new['drainMass'],
            poolEnergyResidual_J=new['poolResidual'],vaporEnergyResidual_J=new['vaporResidual'],totalEnergyResidual_J=energy,totalMassResidual_kg=new['massResidual'],Re_film=peakRe,
            bandFirstLawResiduals_J=new['adiabaticWorkResiduals'],volumeResidual_m3=new['volumeResidual'],localFilmWallResidual_J=new['localResidual'],
            submergedLiquidHeat_J=float(sum(new['poolHeat'])),submergedBandHeat_J=list(map(float,new['poolHeat'])),submergedAreaResidual_m2=new['submergedAreaResidual'],
            submergedHTCmax_W_m2K=new['maximumH'],submergedRamax=new['maximumRa'],submergedLayerOverRadiusMax=new['maximumLayer'],
            lowerQualityMax=max(v['qualityMax'] for v in new['pool']['bands']),lowerVoidMax=max(v['voidMax'] for v in new['pool']['bands'])))
        old=new
    preserved=all(a['M']==c['M'] and a['s']==c['s'] for a,c in zip(initialPool['bands'][:-1],old['pool']['bands'][:-1]))
    if not submerged and not preserved:raise ValueError('Unheated lower material history reset')
    if cold and old['pool']['temperatureMax']-old['pool']['temperatureMin']<.9*b['phase']['coldLowerOffset_K']:raise ValueError('Cold-history contrast erased')
    zeroHold=None
    if zero:
        zeroHold=dict(pressureDrift_Pa=max(abs(row['pressureSurface_MPa']-p0)*1e6 for row in rows),levelDrift_m=max(abs(row['level_m']-L0) for row in rows),
            maximumFilm_kg=max(abs(row['filmMass_kg']) for row in rows),maximumReceipt_kg=max(abs(row['cumulativeReceipt_kg']) for row in rows),maximumSteelEnergy_J=max(abs(row['wallEnergy_J']) for row in rows))
        if zeroHold['pressureDrift_Pa']>.01 or zeroHold['levelDrift_m']>1e-8 or max(zeroHold['maximumFilm_kg'],zeroHold['maximumReceipt_kg'])>1e-10 or zeroHold['maximumSteelEnergy_J']>.05:raise ValueError('Zero condensation-drive hold failed')
    means=[(sat(c['p'])[0]+surface)/2 for c,surface in zip(old['film']['cells'],old['surfaces']) if c['ell']>0]
    propertyDifferences=None if zero else {name:max(abs(CP.PropsSI(symbol,'P',c['p']*1e6,'T',temp,'Water')/value-1) for c,temp in zip([c for c in old['film']['cells'] if c['ell']>0],means)) for name,symbol,value in [('density','D',rho),('heatCapacity','C',cp),('viscosity','V',mu),('conductivity','L',k)]}
    return dict(axialCells=n,radialCells=nr,timeStep_s=dt,quadrature=nq,coldHistory=cold,zeroDrive=zero,submergedContact=submerged,poolInitialSubcooling_K=subcooling,endpointFrozenPropertyRelativeDifferences=propertyDifferences,
        initial=dict(pool=initialPool,vapor=v0,totalMass_kg=totalMass,fluidEnergy_J=E0,retainedSteelMass_kg=float(sum(wallMass.ravel()))),rows=rows,bandFirstLawsUsedAsSolveEquations=submerged,unheatedMaterialHistoryPreserved=preserved if not submerged else None,zeroCondensationDriveHold=zeroHold,maximumEnergyResidual_J=maximumEnergy,maximumMassResidual_kg=maximumMass)
def crossing_check():
    dx=.1;lo=Lsource;level=lo+1.5*dx;thickness=1e-5;pressure=p0*1e6
    swallowed=exposure(lo+dx,lo,level,lo,thickness);active=exposure(lo+2*dx,lo+dx,level,lo,thickness)
    hm=sat(p0)[1]-cp*(sat(p0)[0]-Tw0)/2;mass=rho*annulus(thickness)*dx;z=lo+dx/2
    oldE=mass*(hm-pressure/rho+g*z);sweptE=mass*(hm+g*z)
    solve,masses,_,_=make_wall(8,dx);oldSteel=np.linspace(Tw0,Tw0+.1,8)
    runoff=.001;incoming,incomingE,poolM,poolE=route_outflow(active,runoff,runoff*(hm+g*level))
    inactive=submerged_strip(swallowed,incoming,oldSteel,solve,.05,oldE,sweptE,pressure)
    default=solve(oldSteel,Tw0+.2,.05);explicit=solve(oldSteel,Tw0+.2,.05,inner_fraction=1.)
    if not np.array_equal(default[0],explicit[0]) or not np.array_equal(default[1],explicit[1]):raise ValueError('Default full-contact wall behavior changed')
    partial=solve(oldSteel,Tw0+.2,.05,inner_fraction=.5)
    centers=np.sqrt((np.linspace(r['innerRadius_m'],r['outerRadius_m'],9)[:-1]**2+np.linspace(r['innerRadius_m'],r['outerRadius_m'],9)[1:]**2)/2)
    expected=math.pi*dx/math.log(centers[0]/r['innerRadius_m'])*steel_dK(Tw0+.2,partial[0][0])
    if abs(partial[1][0]-expected)>1e-9:raise ValueError('Partial inner contact conductance incorrect')
    if poolM!=runoff or inactive['condensation']!=0 or inactive['remainingFilmMass']!=0 or incomingE!=0:raise ValueError('Full-strip contact routed runoff into a ghost vapor strip')
    energyChange=float(sum(masses*steel_de(inactive['steel'],oldSteel)))
    if inactive['residual']>1e-6 or abs(energyChange)>1e-6 or abs(rho*swallowed['sweptVolume']-mass)>1e-12:raise ValueError('Swept film/steel identity failed')
    return dict(oldFilmMass_kg=mass,sweptFilmMass_kg=rho*swallowed['sweptVolume'],runoffToPool_kg=poolM,
        fictitiousCondensation_kg=inactive['condensation'],remainingSubmergedFilm_kg=inactive['remainingFilmMass'],
        pressureConsistentSweepResidual_J=inactive['residual'],fixedSteelEnergyChange_J=energyChange,
        maximumSteelTemperatureRedistribution_K=float(max(abs(inactive['steel']-oldSteel))),defaultFullContactUnchanged=True,partialContactHeat_W=float(partial[1][0]),partialContactResidual_W=float(partial[1][0]-expected))
`
const joinedVerification=String.raw`
crossing=crossing_check();n=cfg['axialCells'];nr=cfg['radialCells'];dt=cfg['timeStep_s']
cases=[run(n,nr,dt),run(n,2*nr,dt),run(2*n,nr,dt),run(n,nr,dt/2),run(n,nr,dt,8),run(n,nr,dt,4,False,False,2*r['cellCount']),run(n,nr,dt,4,False,True),run(n,nr,dt,4,True)]
comparisons=[]
for label,case in zip(['radial','axial','time','quadrature','lower-bands'],cases[1:6]):
    a=cases[0]['rows'][-1];c=case['rows'][-1]
    dp=(a['pressureSurface_MPa']-p0)*1e6;dc=(c['pressureSurface_MPa']-p0)*1e6
    metrics={key:abs(a[key]-c[key])/max(abs(c[key]),1e-12) for key in ['filmMass_kg','cumulativeReceipt_kg','wallEnergy_J']}
    metrics['pressureResponse']=abs(dp-dc)/abs(dc)
    comparisons.append(dict(axis=label,relativeDifferences=metrics,passes=bool(max(metrics.values())<=.02)))
print(json.dumps(dict(scope='Finite sealed hydrostatic vapor/film/radial-steel/receiving-pool cooling reference; no donor or fixed pressure',
    crossingCheck=crossing,cases=cases,comparisons=comparisons,numericalScreenPassed=all(v['passes'] for v in comparisons),liveModelInstalled=False),allow_nan=False))
`
export const joinedCalculation=joinedDefinitions+joinedVerification
if(import.meta.main){
  const [source,owner,python,...extra]=Bun.argv.slice(2)
  if(!source||!owner||!python||extra.length)throw Error('Usage: pressurizer-joined.ts source.md owner.md python')
  const doc=await Bun.file(owner).text(),joined=parseJoinedPressurizer(doc)
  const input={source:parsePressurizerBoundaries(await Bun.file(source).text()),pressure_MPa:parseSpatialBasis(doc).surfacePressure_MPa,phase:parsePhaseStorageBasis(doc),film:joined,joined}
  const child=Bun.spawn([python,'-c',joinedCalculation],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(code)throw Error(err)
  console.log(JSON.stringify({input,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),calculationHash:createHash('sha256').update(joinedCalculation).digest('hex'),...JSON.parse(out)},null,2))
}
