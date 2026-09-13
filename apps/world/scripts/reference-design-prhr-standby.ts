/** One conditional finite-bank mean profile; offline evidence, never a runtime. */
import {createHash} from 'node:crypto'
import {parsePrhrGeometry,auditPrhrGeometry} from './reference-design-prhr-geometry'
import {parsePrhrExchange,prhrExchange,prhrEntranceWeight} from './reference-design-prhr-exchange'
import {prhrCapacitySetupPython,prhrCapacityConstitutivePython} from './reference-design-prhr-capacity'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
export const standbyPlan={returnCells:16,tubeCells:16,blindCells:8,wallSeconds:300,maxEvaluations:120,
  pressureGate_Pa:1,energyGate_W:10,missingWorkFraction:.01,entryLoss_K:.5,
  qBracket_kg_s:[.0001,500],loopBracket_kg_s:[-1500,1500],pool_K:298.15,room_K:313.15} as const
export function retainedSgSource(raw:unknown):Record<string,unknown>&{u_m_s:number;Ht_J_kg:number}{
  const r=raw as {accepted?:boolean;case?:{name?:string;heatFactor?:number};result?:{faces?:Array<Record<string,unknown>>}}
  const f=r.result?.faces?.find(f=>f.owner==='SG.A/B.PRIMARY')
  if(r.accepted!==true||r.case?.name!=='nominal'||r.case.heatFactor!==1||!f)throw Error('Accepted nominal SG source required')
  for(const k of ['p_Pa','h_J_kg','T_K','rho_kg_m3','s_J_kgK','velocity_m_s','z_m','totalEnthalpy_J_kg'])if(typeof f[k]!=='number'||!Number.isFinite(f[k]))throw Error('Finite SG face '+k+' required')
  return {...f,u_m_s:Number(f.velocity_m_s),Ht_J_kg:Number(f.totalEnthalpy_J_kg)}
}
export const standbyPython=prhrCapacitySetupPython+prhrCapacityConstitutivePython+String.raw`
import numpy as np
import CoolProp, CoolProp.CoolProp as CP
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix
plan=d['plan'];ex=d['exchange'];sg=d['source'];poolT=plan['pool_K'];room=plan['room_K']
fluid=CP.AbstractState('HEOS','Water');propertyCalls=0
# Reuse the exact capacity film/geometry equations with explicit actual primary P.
# Unlike the historical fixed-pressure comparator, caloric fields use the source HEOS EOS.
def water(T,P=None):
    global propertyCalls
    P=p if P is None else P
    fluid.update(CP.PT_INPUTS,P*1e6,T);propertyCalls+=1
    if fluid.phase()!=CP.iphase_liquid:raise ValueError('Actual local stable liquid domain exceeded')
    return dict(rho=fluid.rhomass(),mu=fluid.viscosity(),k=fluid.conductivity(),cp=fluid.cpmass(),h=fluid.hmass(),
      beta=fluid.isobaric_expansion_coefficient(),s=fluid.smass(),u=fluid.umass())
def primary(P,T):
    return water(T,P/1e6)
def thermal(P,T,m,Di,Do,st):
    global p
    p=P/1e6
    if T==poolT:return 0.,T,T
    return heat(T,m,Di,Do,poolT,st,.5)
def ambient(P,T,Di,Do):
    # Signed radial heat to room; inside natural/forced film omitted only in this
    # conservative insulated-wall approximation (water/steel at one radial T).
    R=math.log(Do/Di)/(2*math.pi*ks)+math.log((Do+.2)/Do)/(2*math.pi*.06)+1/(8*math.pi*(Do+.2))
    return (T-room)/R
def film_screen(P,T,Ti,qline,m,Di,Do,st):
    global p
    p=P/1e6;insideState=inside(T,Ti,m,Di,True);_,f,v=st
    chf=.131*(v.h-f.h)*1000*math.sqrt(v.rho)*(g*f.sigma*(f.rho-v.rho))**.25
    forced=insideState['turbulentNu']>=max(insideState['naturalNu'],insideState['laminarNu'])
    return dict(insideFilm=insideState,unscaledCHFScreenRatio=qline/(math.pi*Do)/.5/chf,
      filmDomainAdmitted=not(forced and (insideState['Re']<2300 or insideState['Re']>5e6 or insideState['Pr']<.5 or insideState['Pr']>2000)))
def harm(a,b):return 2*a*b/(a+b)
def mean_law(wc,wa,q,s):
    A=math.pi*ex['diameter_m']**2/4;Ac=Aa=A/2;Pi=math.pi*ex['diameter_m']*math.sqrt(.5);ell=4*Ac*Aa/(Pi*A)
    uc=q/(wc['rho']*Ac);ua=-q/(wa['rho']*Aa);w=uc-ua;rho=(wc['rho']+wa['rho'])/2;cp=(wc['cp']+wa['cp'])/2
    mui=harm(wc['mu'],wa['mu'])+rho*ex['mixingCoefficient']*ell*abs(w)
    fi=mui*w/ell*Pi;hi=harm(wc['k'],wa['k'])/ell+rho*cp*ex['mixingCoefficient']*abs(w)/ex['turbulentPrandtl']
    # q is positive in this frozen source/return orientation, not clamped.
    Dh=4*Aa/(math.pi*ex['diameter_m']);Re=wa['rho']*abs(ua)*Dh/wa['mu']
    fw=-friction(Re,geo['roughness_m']/Dh)/Dh*wa['rho']*ua*abs(ua)/2*Aa
    dpe=ex['entranceCoefficient']*sg['rho_kg_m3']*sg['u_m_s']**2/2
    fe=dpe*(Ac*Aa/A)*math.exp(-s/ex['diameter_m'])/(ex['diameter_m']*(-math.expm1(-ex['length_m']/ex['diameter_m'])))
    Di=fi*w;Dw=-fw*ua
    return dict(uc=uc,ua=ua,fc=-fi+fe,fa=fi+fw-fe,conductance=hi*Pi,Di=Di,Dw=Dw,tee=fe*w)
def boundary_checks():
    P=14.6e6;T=330.;q=30.;A=math.pi*ex['diameter_m']**2/8;header=primary(P,T)
    def outgoing(pp):
        fluid.update(CP.PSmass_INPUTS,pp,header['s']);rho=fluid.rhomass();h=fluid.hmass()
        return h+q*q/(2*rho*rho*A*A)-header['h']
    faceP=brentq(outgoing,P-1e4,P,xtol=1e-7);fluid.update(CP.PSmass_INPUTS,faceP,header['s']);faceH=fluid.hmass();faceS=fluid.smass();faceRho=fluid.rhomass()
    cases=[]
    for name,Tc,expected in [('hot_arrival',400.,True),('colder_pressure_inaccessible',300.,False)]:
        w=primary(faceP,Tc);H=w['h']+q*q/(2*w['rho']**2*A*A)
        fluid.update(CP.PSmass_INPUTS,P,w['s']);access=H-fluid.hmass()
        entropy=q*((H-header['h'])/T+header['s']-w['s'])
        accepted=bool(access>=-1e-6 and entropy>=-1e-6)
        if accepted!=expected:raise ValueError('Frozen bank boundary contrary did not discriminate')
        cases.append(dict(name=name,headerPressure_Pa=P,headerT_K=T,facePressure_Pa=faceP,incomingT_K=Tc,q_kg_s=q,
          availableK_J_kg=access,mixingEntropy_W_K=entropy,admitted=accepted,
          withdrawalHResidual_J_kg=faceH+q*q/(2*faceRho**2*A*A)-header['h'],withdrawalSResidual_J_kgK=faceS-header['s']))
    actual=mean_law(d['oracle']['core'],d['oracle']['annulus'],d['oracle']['q'],d['oracle']['s'])
    checks=[]
    for key,expected in d['oracle']['expected'].items():
        error=abs(actual[key]-expected)/max(1.,abs(expected))
        if error>2e-12:raise ValueError('Existing TS exchange law mismatch '+key)
        checks.append(dict(field=key,actual=actual[key],expected=expected,relativeError=error))
    return dict(bank=cases,exchangeOracle=checks)
staticChecks=boundary_checks()
def execute(n,nt):
    start=time.monotonic();calls=0;last=None;dependencies=[];lastFiniteX=None;finished=False
    A=math.pi*ex['diameter_m']**2/4;Ac=Aa=A/2;Aeff=Ac*Aa/A;D=ex['diameter_m'];LL=ex['length_m']
    sgrid=np.linspace(0,LL,n+1);dx=LL/n;zgrid=sg['z_m']+ex['rise_m']*sgrid/LL
    # Actual C-path breakpoints are retained as FV boundaries.
    a=t['straightLeg_m'];rad=t['bendRadius_m'];arc=math.pi*rad/2;drop=t['top_m']-t['bottom_m']
    breaks=[0,a,a+arc,a+arc+drop-2*rad,a+2*arc+drop-2*rad,L];tnodes=[]
    for lo,hi in zip(breaks[:-1],breaks[1:]):tnodes.extend(np.linspace(lo,hi,max(1,math.ceil(nt*(hi-lo)/L))+1)[:-1])
    tnodes=np.array(tnodes+[L]);nt=len(tnodes)-1;tz=np.array([z_at(v)[0] for v in tnodes]);tdx=np.diff(tnodes)
    ng=N/2;nb=plan['blindCells'];hD=geo['header']['id_m'];hO=geo['header']['od_m'];hL=geo['header']['length_m']/2
    hz=np.array([t['top_m'],t['top_m'],t['bottom_m'],t['bottom_m']]) # U1,U2,L1,L2
    pSG=sg['p_Pa'];size=0
    def alloc(shape):
        nonlocal size
        r=np.arange(size,size+int(np.prod(shape))).reshape(shape);size+=r.size;return r
    ir=alloc((n+1,3));iq=alloc((1,));ih=alloc((4,2));it=alloc((2,nt+1,2));ij=alloc((1,));ib=alloc((nb+1,))
    initial=np.zeros(size);lower=np.full(size,-np.inf);upper=np.full(size,np.inf)
    def put(indices,P,T):
        initial[indices[...,0]]=(np.asarray(P)-pSG)/1e5;initial[indices[...,1]]=np.asarray(T)/100
        lower[indices[...,0]]=-5;upper[indices[...,0]]=2;lower[indices[...,1]]=poolT/100;upper[indices[...,1]]=sg['T_K']/100+.01
    put(ir[:,:2],pSG-850*g*(zgrid-sg['z_m']),np.linspace(sg['T_K'],360,n+1))
    initial[ir[:,2]]=np.linspace(500,330,n+1)/100;lower[ir[:,2]]=poolT/100;upper[ir[:,2]]=sg['T_K']/100+.01
    put(ih,pSG-900*g*(hz-sg['z_m']),[310,315,310,330])
    for k in range(2):put(it[k],pSG-900*g*(tz-sg['z_m']),np.linspace(312,320,nt+1))
    initial[iq]=3;lower[iq]=plan['qBracket_kg_s'][0]/10;upper[iq]=plan['qBracket_kg_s'][1]/10
    initial[ij]=10;lower[ij]=plan['loopBracket_kg_s'][0]/100;upper[ij]=plan['loopBracket_kg_s'][1]/100
    initial[ib]=np.linspace(310,room,nb+1)/100;lower[ib]=poolT/100;upper[ib]=sg['T_K']/100+.01
    poolStations={float(z):station(poolT,float(z)) for z in list(hz)+list((tz[:-1]+tz[1:])/2)}
    def evaluate(x,record=False,structure=False):
        nonlocal calls,last,dependencies,lastFiniteX
        calls+=1
        if not finished and time.monotonic()-start>plan['wallSeconds']:raise TimeoutError('Declared stationary work budget exceeded')
        rr=[];raw=[];names=[];deps=[];heatPool=0.;heatRoom=0.;tee=0.;missing=0.;omittedHead=0.;drive=0.;omitEntropy=0.;surfaces=[];inventory=[]
        q=float(x[iq[0]]*10);j=float(x[ij[0]]*100)
        def add(value,scale,name,*columns):
            if not math.isfinite(float(value)):raise ValueError('Nonfinite physical residual')
            rr.append(float(value)/scale);raw.append(float(value));names.append(name);deps.append(np.unique(np.concatenate([np.atleast_1d(v).flatten() for v in columns])).astype(int))
        rp=pSG+x[ir[:,0]]*1e5;Tc=x[ir[:,1]]*100;Ta=x[ir[:,2]]*100
        wc=[primary(P,T) for P,T in zip(rp,Tc)];wa=[primary(P,T) for P,T in zip(rp,Ta)]
        uc=np.array([q/(w['rho']*Ac) for w in wc]);ua=np.array([-q/(w['rho']*Aa) for w in wa])
        Hc=np.array([w['h'] for w in wc])+uc**2/2+g*zgrid;Ha=np.array([w['h'] for w in wa])+ua**2/2+g*zgrid
        rel=0.
        for k in range(n):
            P=(rp[k]+rp[k+1])/2;tc=(Tc[k]+Tc[k+1])/2;ta=(Ta[k]+Ta[k+1])/2;cw=primary(P,tc);aw=primary(P,ta)
            law=mean_law(cw,aw,q,(sgrid[k]+sgrid[k+1])/2);fc=law['fc'];fa=law['fa'];ucm=law['uc'];uam=law['ua']
            # Exact cell-integrated selected tee force, not midpoint-resized Ce.
            dpe=ex['entranceCoefficient']*sg['rho_kg_m3']*sg['u_m_s']**2/2
            oldFe=law['tee']/(ucm-uam);newFe=dpe*Aeff*(math.exp(-sgrid[k]/D)-math.exp(-sgrid[k+1]/D))/(-math.expm1(-LL/D))/dx
            fc+=newFe-oldFe;fa-=newFe-oldFe;law['tee']=newFe*(ucm-uam)
            qc=law['conductance']*(ta-tc)+law['Di']/2;qa=-law['conductance']*(ta-tc)+law['Di']/2+law['Dw']
            roomQ=ambient(P,ta,geo['coldConnector']['id_m'],geo['coldConnector']['od_m']);heatRoom+=roomQ*dx;tee+=law['tee']*dx
            dz=zgrid[k+1]-zgrid[k]
            mom=A*(rp[k+1]-rp[k])+q*(uc[k+1]-uc[k]-ua[k+1]+ua[k])+g*dz*(Ac*cw['rho']+Aa*aw['rho'])-(fc+fa)*dx
            ec=q*(Hc[k+1]-Hc[k])-(fc*ucm+qc)*dx;ea=-q*(Ha[k+1]-Ha[k])-(fa*uam+qa-roomQ)*dx
            r=q*(uc[k+1]-uc[k])+Ac*(rp[k+1]-rp[k])+Ac*cw['rho']*g*dz-fc*dx
            rel+=r/Aeff;omittedHead+=abs(r/Aeff);missing+=abs(r*(ucm-uam));omitEntropy-=r*(ucm/tc-uam/ta);drive+=abs((aw['rho']-cw['rho'])*g*dz)
            add(mom/A,100,'returnMomentum_Pa',ir[k:k+2],iq);add(ec,1e4,'returnEnergy_W',ir[k:k+2],iq);add(ea,1e4,'returnEnergy_W',ir[k:k+2],iq)
            if record:
                for label,w,vol,v in [('core',cw,Ac*dx,ucm),('annulus',aw,Aa*dx,uam)]:
                    steel=math.pi*(geo['coldConnector']['od_m']**2-geo['coldConnector']['id_m']**2)/4*dx if label=='annulus' else 0.
                    inventory.append(dict(owner=label,cell=k,volume_m3=vol,M_kg=w['rho']*vol,U_J=w['rho']*vol*w['u'],K_J=w['rho']*vol*v*v/2,PE_J=w['rho']*vol*g*(zgrid[k]+zgrid[k+1])/2,steelVolume_m3=steel,steelEnergy_J=steel*geo['steelDensity_kg_m3']*geo['steelCp_J_kgK']*ta))
        add(rp[0]-pSG,100,'sourcePressure_Pa',ir[0]);add(Hc[0]-sg['Ht_J_kg'],1e3,'sourceHt_J_kg',ir[0],iq)
        hp=pSG+x[ih[:,0]]*1e5;hT=x[ih[:,1]]*100;hw=[primary(P,T) for P,T in zip(hp,hT)];HH=np.array([w['h'] for w in hw])+g*hz
        add(Ha[-1]-HH[3],1e3,'bankWithdrawalHt_J_kg',ir[-1],iq,ih[3]);add(wa[-1]['s']-hw[3]['s'],1.,'bankWithdrawalEntropy_J_kgK',ir[-1],ih[3])
        add(rel,100,'relativeMomentum_Pa',ir,iq)
        tubeEnds=[];tubeProfiles=[];headerEnergy=np.zeros(4)
        for group in range(2):
            m=j if group==0 else -j;upperH=group;lowerH=group+2
            pp=pSG+x[it[group,:,0]]*1e5;TT=x[it[group,:,1]]*100;ww=[primary(P,T) for P,T in zip(pp,TT)];vv=np.array([m/ng/(w['rho']*math.pi*t['id_m']**2/4) for w in ww]);HHt=np.array([w['h'] for w in ww])+vv**2/2+g*tz
            for k in range(nt):
                P=(pp[k]+pp[k+1])/2;T=TT[k+1] if m>=0 else TT[k];wm=primary(P,T);zm=(tz[k]+tz[k+1])/2;ds=tdx[k]
                qline,To,Ti=thermal(P,T,abs(m)/ng,t['id_m'],t['od_m'],poolStations[float(zm)]);Q=qline*ds*ng;heatPool+=Q
                # Both bend losses are placed on their actual quarter-arc segments.
                bendK=t['bendLoss_K']*ds/arc if a<=((tnodes[k]+tnodes[k+1])/2)<=a+arc or a+arc+drop-2*rad<=((tnodes[k]+tnodes[k+1])/2)<=a+2*arc+drop-2*rad else 0.
                mom=pp[k+1]-pp[k]+(m/ng)/(math.pi*t['id_m']**2/4)*(vv[k+1]-vv[k])+wm['rho']*g*(tz[k+1]-tz[k])+dp_loss(m/ng,wm,t['id_m'],ds,bendK)
                add(mom,100,'tubeMomentum_Pa',it[group,k:k+2],ij);add(m*(HHt[k+1]-HHt[k])+Q,1e4,'tubeEnergy_W',it[group,k:k+2],ij)
                if record:
                    volume=ng*math.pi*t['id_m']**2/4*ds;steel=ng*math.pi*(t['od_m']**2-t['id_m']**2)/4*ds
                    inventory.append(dict(owner='tube'+str(group),cell=k,volume_m3=volume,M_kg=wm['rho']*volume,U_J=wm['rho']*volume*wm['u'],K_J=wm['rho']*volume*((vv[k]+vv[k+1])/2)**2/2,PE_J=wm['rho']*volume*g*zm,steelVolume_m3=steel,steelEnergy_J=steel*geo['steelDensity_kg_m3']*geo['steelCp_J_kgK']*(Ti+To)/2))
                    surfaces.append(dict(owner='tube'+str(group),T_K=T,Ti_K=Ti,To_K=To,Q_W=Q,entropy_W_K=Q*(1/poolT-1/T),**film_screen(P,T,Ti,qline,abs(m)/ng,t['id_m'],t['od_m'],poolStations[float(zm)])))
            inlet=0 if m>=0 else nt;outlet=nt if m>=0 else 0;hin=upperH if m>=0 else lowerH;hout=lowerH if m>=0 else upperH
            # Pattern is the union of both signs: trial reversal changes the donor,
            # never the mathematical dependency contract supplied to least_squares.
            add(hp[hin]-pp[inlet]-(1+plan['entryLoss_K'])*ww[inlet]['rho']*vv[inlet]**2/2,100,'tubeEntrance_Pa',ih[[upperH,lowerH]],it[group,[0,-1]],ij)
            add(pp[outlet]-hp[hout],100,'tubeDischarge_Pa',ih[[upperH,lowerH]],it[group,[0,-1]])
            add(HHt[inlet]-HH[hin],1e3,'tubeEntranceHt_J_kg',ih[[upperH,lowerH]],it[group,[0,-1]],ij)
            headerEnergy[hin]-=abs(m)*HH[hin];headerEnergy[hout]+=abs(m)*HHt[outlet]
            tubeEnds.append(dict(m_kg_s=m,inletEntropy_J_kgK=ww[inlet]['s']-hw[hin]['s'],outletMixEntropy_W_K=abs(m)*((HHt[outlet]-HH[hout])/hT[hout]+hw[hout]['s']-ww[outlet]['s'])))
            tubeProfiles.append(dict(p_Pa=pp.tolist(),T_K=TT.tolist(),z_m=tz.tolist(),H_J_kg=HHt.tolist()))
        # Actual center-to-center horizontal header communication. Four finite mixed
        # regions keep their thermal volume; axial kinetic conversion is in the
        # selected communicating-header reduction, not a second tube exit loss.
        for left,right,flow in [(1,0,j),(2,3,j)]:
            wm=primary((hp[left]+hp[right])/2,(hT[left]+hT[right])/2)
            add(hp[left]-hp[right]-dp_loss(flow,wm,hD,hL),100,'headerMomentum_Pa',ih[left],ih[right],ij)
            donor=left if flow>=0 else right;receiver=right if flow>=0 else left
            headerEnergy[donor]-=abs(flow)*HH[donor];headerEnergy[receiver]+=abs(flow)*HH[donor]
        headerEnergy[3]+=q*(Hc[-1]-HH[3])
        # Blind hot connector: axial water+steel conduction, radial insulated loss;
        # adiabatic seat. No fictitious hot-source circulation through closed valve.
        bT=x[ib]*100;bL=geo['hotConnector']['length_m'];bdx=bL/nb;bDi=geo['hotConnector']['id_m'];bDo=geo['hotConnector']['od_m'];bA=math.pi*bDi*bDi/4;bAs=math.pi*(bDo*bDo-bDi*bDi)/4
        flux=[];bQ=[];bP=[hp[0]];bz=np.linspace(t['top_m'],geo['hotTerminal_m'],nb+1)
        for k in range(nb):
            T=(bT[k]+bT[k+1])/2;dz=bz[k+1]-bz[k]
            nextP=brentq(lambda P:P-bP[-1]+primary((P+bP[-1])/2,T)['rho']*g*dz,bP[-1],bP[-1]+1200*g*abs(dz),xtol=1e-6);bP.append(nextP)
            w=primary((bP[k]+bP[k+1])/2,T);flux.append(-(w['k']*bA+ks*bAs)*(bT[k+1]-bT[k])/bdx);bQ.append(ambient((bP[k]+bP[k+1])/2,T,bDi,bDo)*bdx)
            if record:inventory.append(dict(owner='blind-hot',cell=k,volume_m3=bA*bdx,M_kg=w['rho']*bA*bdx,U_J=w['rho']*bA*bdx*w['u'],K_J=0.,PE_J=w['rho']*bA*bdx*g*(bz[k]+bz[k+1])/2,steelVolume_m3=bAs*bdx,steelEnergy_J=bAs*bdx*geo['steelDensity_kg_m3']*geo['steelCp_J_kgK']*T))
        add(bT[0]-hT[0],1.,'blindTemperature_K',ib[0],ih[0]);headerEnergy[0]-=flux[0]
        for k in range(1,nb):add(flux[k-1]-flux[k]-(bQ[k-1]+bQ[k])/2,1e2,'blindEnergy_W',ib,ih[0])
        add(flux[-1]-bQ[-1]/2,1e2,'blindEnergy_W',ib,ih[0]);headerEnergy[0]-=bQ[0]/2;heatRoom+=sum(bQ)
        for k in range(4):
            Qline,To,Ti=thermal(hp[k],hT[k],abs(j)/2,hD,hO,poolStations[float(hz[k])]);Q=Qline*hL;heatPool+=Q;headerEnergy[k]-=Q
            add(headerEnergy[k],1e4,'headerEnergy_W',ih,it[:,[0,-1]],ir[-1],iq,ij,ib[:2])
            if record:
                volume=math.pi*hD*hD/4*hL;steel=math.pi*(hO*hO-hD*hD)/4*hL;w=hw[k]
                inventory.append(dict(owner='header'+str(k),volume_m3=volume,M_kg=w['rho']*volume,U_J=w['rho']*volume*w['u'],K_J=0.,PE_J=w['rho']*volume*g*hz[k],steelVolume_m3=steel,steelEnergy_J=steel*geo['steelDensity_kg_m3']*geo['steelCp_J_kgK']*(Ti+To)/2))
                surfaces.append(dict(owner='header'+str(k),T_K=hT[k],Ti_K=Ti,To_K=To,Q_W=Q,entropy_W_K=Q*(1/poolT-1/hT[k]),**film_screen(hp[k],hT[k],Ti,Qline,abs(j)/2,hD,hO,poolStations[float(hz[k])])) )
        if len(rr)!=size:raise ValueError('Physical equation/unknown count mismatch '+str((len(rr),size)))
        if structure:dependencies=deps
        lastFiniteX=x.copy()
        if record:
            waterVolume=sum(v['volume_m3'] for v in inventory);steelVolume=sum(v['steelVolume_m3'] for v in inventory)
            expectedSteel=sum(audit[k]['steel_m3'] for k in ['tube','headers','hotConnector','coldConnector'])
            if abs(waterVolume-audit['primaryWater_m3'])>1e-10 or abs(steelVolume-expectedSteel)>1e-10:raise ValueError('Native geometric inventory coverage failed')
            fluid.update(CP.PSmass_INPUTS,float(hp[3]),wc[-1]['s']);hAccessible=fluid.hmass()
            mixS=q*((Hc[-1]-HH[3])/hT[3]+hw[3]['s']-wc[-1]['s'])
            sourceThermal=q*(sg['h_J_kg']-wa[0]['h']);whole=q*(sg['Ht_J_kg']-Ha[0])+tee-heatPool-heatRoom
            dpe=ex['entranceCoefficient']*sg['rho_kg_m3']*sg['u_m_s']**2/2
            last=dict(q_kg_s=q,bankLoop_kg_s=j,returnProfile=dict(s_m=sgrid.tolist(),p_Pa=rp.tolist(),Tc_K=Tc.tolist(),Ta_K=Ta.tolist(),Hc_J_kg=Hc.tolist(),Ha_J_kg=Ha.tolist()),
              headerP_Pa=hp.tolist(),headerT_K=hT.tolist(),tubeProfiles=tubeProfiles,blindT_K=bT.tolist(),blindP_Pa=bP,inventory=inventory,surfaces=surfaces,tubeBoundaryChecks=tubeEnds,
              waterVolume_m3=waterVolume,steelVolume_m3=steelVolume,
              wholeBoundaryEntropy_W_K=q*(wa[0]['s']-sg['s_J_kgK'])+heatPool/poolT+heatRoom/room,sourceEntryEntropy_J_kgK=wc[0]['s']-sg['s_J_kgK'],
              incomingAvailableK_J_kg=Hc[-1]-g*hz[3]-hAccessible,bankMixEntropy_W_K=mixS,wholeEnergyResidual_W=whole,
              sourceStaticThermal_W=sourceThermal,sourceTotalHTransport_W=q*(sg['Ht_J_kg']-Ha[0]),teeWork_W=tee,WSTHeat_W=heatPool,roomHeat_W=heatRoom,
              relativeMomentumResidual_Pa=rel,omittedAbsoluteHead_Pa=omittedHead,driveScale_Pa=drive+abs(dpe),missingWork_W=missing,missingWorkAllowance_W=plan['missingWorkFraction']*abs(sourceThermal),omittedEntropy_W_K=omitEntropy,
              residuals=[dict(name=name,value=value) for name,value in zip(names,raw)],maxScaledResidual=max(abs(v) for v in rr))
        return np.array(rr)
    # One declared physical start, not a search over starts or tuned coefficients.
    evaluate(initial,structure=True);pattern=lil_matrix((size,size),dtype=int)
    for row,cols in enumerate(dependencies):pattern[row,cols]=1
    answer=None;failure=None
    try:
        answer=least_squares(evaluate,initial,bounds=(lower,upper),jac_sparsity=pattern.tocsr(),x_scale='jac',ftol=1e-10,xtol=1e-10,gtol=1e-10,max_nfev=plan['maxEvaluations'])
        evaluate(answer.x,record=True)
    except Exception as e:failure=type(e).__name__+': '+str(e)
    finished=True
    if last is None and lastFiniteX is not None:
        try:evaluate(lastFiniteX,record=True)
        except Exception as e:failure=(failure or '')+'; retained diagnostic failed: '+str(e)
    admitted=False
    if last:
        pressure=max(abs(r['value']) for r in last['residuals'] if r['name'].endswith('_Pa'))
        energy=max(abs(r['value']) for r in last['residuals'] if r['name'].endswith('Energy_W'))
        entropy=min([last['bankMixEntropy_W_K']]+[r['outletMixEntropy_W_K'] for r in last['tubeBoundaryChecks']])
        boundaryH=max(abs(r['value']) for r in last['residuals'] if r['name'].endswith('Ht_J_kg'))*max(last['q_kg_s'],abs(last['bankLoop_kg_s']))
        boundaryS=max(abs(r['value']) for r in last['residuals'] if r['name'].endswith('Entropy_J_kgK'))
        admitted=bool(answer is not None and answer.success and pressure<=plan['pressureGate_Pa'] and energy<=plan['energyGate_W'] and boundaryH<=plan['energyGate_W'] and boundaryS<=1e-6 and abs(last['wholeEnergyResidual_W'])<=plan['energyGate_W'] and last['missingWork_W']<=last['missingWorkAllowance_W'] and last['incomingAvailableK_J_kg']>=-1e-6 and entropy>=-1e-6 and last['wholeBoundaryEntropy_W_K']>=-1e-6 and last['sourceEntryEntropy_J_kgK']>=-1e-6 and all(r['inletEntropy_J_kgK']>=-1e-6 for r in last['tubeBoundaryChecks']) and all(s['filmDomainAdmitted'] and s['unscaledCHFScreenRatio']<=1 for s in last['surfaces']))
        last['maxPressureResidual_Pa']=pressure;last['maxCellEnergyResidual_W']=energy
        last['boundaryHtDefect_W']=boundaryH;last['boundaryIsentropeDefect_J_kgK']=boundaryS
    return dict(admitted=admitted,failure=failure,solverSuccess=bool(answer.success) if answer is not None else False,solverMessage=str(answer.message) if answer is not None else None,
      returnedEvaluations=int(answer.nfev) if answer is not None else None,resultMeaning='returned stationary candidate' if answer is not None else 'last fully evaluated trial; not an accepted profile',residualCalls=calls,propertyCalls=propertyCalls,wall_s=time.monotonic()-start,unknowns=size,returnCells=n,tubeCellsPerGroup=nt,result=last)
results=[]
if not d['staticOnly']:
    first=execute(plan['returnCells'],plan['tubeCells']);results.append(dict(name='nominal',**first));print(json.dumps(dict(name='nominal',admitted=first['admitted'],failure=first['failure'],wall_s=first['wall_s'])),file=sys.stderr,flush=True)
# The refinement is admitted only after the nominal physical gate, not a rescue.
if results and first['admitted']:results.append(dict(name='axial_refinement',**execute(2*plan['returnCells'],2*plan['tubeCells'])))
print(json.dumps(dict(cases=results,staticChecks=staticChecks,dependencies=dict(CoolProp=CoolProp.__version__,iapws=iapws.__version__,scipy=scipy.__version__),
  scope='Conditional stationary fixed-partition mean cut and two-group bank; not transient startup, guaranteed standby or empirical mixing qualification'),allow_nan=False))
`
if(import.meta.main){
  const [owner,sourcePath,python,mode,...rest]=process.argv.slice(2)
  if(!owner||!sourcePath||!python||rest.length||(mode!==undefined&&mode!=='--static'))throw Error('Usage: prhr-standby <owner.md> <accepted-sg-receipt.json> <python> [--static]')
  const paths=[import.meta.path,...['reference-design-prhr-capacity.ts','reference-design-prhr-geometry.ts','reference-design-prhr-exchange.ts','reference-design-pool-boiling.ts'].map(f=>new URL(f,import.meta.url).pathname)]
  const sources=await Promise.all(paths.map(f=>Bun.file(f).text()));const doc=await Bun.file(owner).text(),sourceText=await Bun.file(sourcePath).text()
  const geometry=parsePrhrGeometry(doc),exchange=parsePrhrExchange(doc),source=retainedSgSource(JSON.parse(sourceText))
  const core={temperature_K:400,density_kg_m3:800,viscosity_Pas:.00015,conductivity_W_mK:.6,cp_J_kgK:4400}
  const annulus={temperature_K:330,density_kg_m3:950,viscosity_Pas:.0004,conductivity_W_mK:.65,cp_J_kgK:4200}
  const q=30,s=.25,area=Math.PI*exchange.diameter_m**2/8,uc=q/(core.density_kg_m3*area),ua=-q/(annulus.density_kg_m3*area)
  const law=prhrExchange(exchange,core,annulus,.5,uc,ua,Number(source.u_m_s),Number(source.rho_kg_m3)),weight=prhrEntranceWeight(s,exchange.length_m,exchange.diameter_m)
  const fe=law.entranceHead_Pa*area/2,fi=law.shear_Pa*law.geometry.interfacePerimeter_m
  const convert=(w:typeof core)=>({rho:w.density_kg_m3,mu:w.viscosity_Pas,k:w.conductivity_W_mK,cp:w.cp_J_kgK})
  const oracle={core:convert(core),annulus:convert(annulus),q,s,expected:{uc,ua,fc:-fi+fe*weight,
    fa:(law.annulusForce_N+fe)/exchange.length_m-fe*weight,conductance:law.interstreamConductance_W_K/exchange.length_m,
    Di:law.interfacialDissipation_W/exchange.length_m,Dw:law.wallDissipation_W/exchange.length_m,tee:law.entranceWork_W*weight}}
  const input={geometry,audit:auditPrhrGeometry(geometry),exchange,source,sourceReceiptSha256:hash(sourceText),plan:standbyPlan,oracle,staticOnly:mode==='--static',
    basis:{primaryPressure_MPa:15,hot_C:320,containmentPressure_MPa:.101325}}
  const child=Bun.spawn([python,'-c',standbyPython],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'inherit'})
  const [out,code]=await Promise.all([new Response(child.stdout).text(),child.exited]);if(code)throw Error('Profile process failed before receipt: '+code)
  for(let i=0;i<paths.length;i++)if(await Bun.file(paths[i]!).text()!==sources[i])throw Error('Source changed during calculation')
  console.log(JSON.stringify({sourceSha256:hash(sources[0]!),dependencySha256:sources.slice(1).map(hash),calculationSha256:hash(standbyPython),inputSha256:hash(JSON.stringify(input)),input,...JSON.parse(out)},null,2))
}
