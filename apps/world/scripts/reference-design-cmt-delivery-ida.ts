/** Offline native residual feasibility; the retained BE calculation is deliberately unchanged. */
import { createHash } from 'node:crypto'
import { deliverySetup } from './reference-design-cmt-delivery.ts'
import { stationaryValvePython } from './reference-design-cmt-valve-law.ts'

export const deliveryIdaSetup = deliverySetup + stationaryValvePython + String.raw`
from sksundae.ida import IDA
import sksundae

# Same four stationary-interface equations, evaluated directly in the DAE, never solved inside it.
# Positive numerical flow points upward: DVI -> pipe -> CMT. A healthy check admits negative flow.
def boundary(left,right,alpha,a,kind,closed=False):
    ZL=left['rho']*left['c'];ZR=right['rho']*right['c']
    wL=left['p']+ZL*left['v'];wR=right['p']-ZR*right['v'];drive=wL-wR
    j,pL,pR,hd=a
    if closed:
        residual=np.array([j,pL-wL,pR-wR,hd-right['h']])
        return residual,dict(m=0.,energy=0.,momL=A*wL,momR=A*wR,drive=drive,entropy=0.,donor=None)
    direction=-1 if kind=='check' else (1 if drive>0 else -1)
    donor=left if direction>0 else right
    up=liquid_ps_si(pL if direction>0 else pR,donor['s'])
    down=valve_hp(pR if direction>0 else pL,hd)
    qL,qR=(up,down) if direction>0 else (down,up)
    m=alpha*j;vL=m/(A*qL['rho']);vR=m/(A*qR['rho'])
    z=data['mouth_m'] if kind=='valve' else b['dviPort_m']
    Hu=up['h']+(vL if direction>0 else vR)**2/2+g*z
    Hd=down['h']+(vR if direction>0 else vL)**2/2+g*z
    loss=Kvalve*ref['rho']/up['rho']*j*abs(j) if kind=='valve' else (-b['checkCrack_Pa'] if kind=='check' else 0.)
    residual=np.array([pL-wL+ZL*vL,pR-wR-ZR*vR,pL-pR-loss,Hd-Hu])
    return residual,dict(m=float(m),energy=float(m*Hu),momL=float(A*pL+m*vL),momR=float(A*pR+m*vR),
      drive=float(drive),entropy=float(abs(m)*(down['s']-up['s'])),entropyRise=float(down['s']-up['s']),
      donor=direction,maximumMach=float(max(abs(vL)/left['c'],abs(vR)/right['c'])))

def port_views(x):
    Y,cv,pv,r=decode(x);q=r['at'](b['dviPort_m'])
    receiver=valve_port(np.array([q['rho'],0.,q['p'],q['u'],0.]))
    return Y,cv,pv,r,receiver,valve_port(pv[1][0,0]),valve_port(pv[1][-1,1]),valve_port(cv[1][0,0])

def boundary_initial(left,right,alpha,kind,closed):
    wL=left['p']+left['rho']*left['c']*left['v'];wR=right['p']-right['rho']*right['c']*right['v']
    if closed:return np.array([0.,wL,wR,right['h']])
    drive=wL-wR;direction=-1 if kind=='check' else (1 if drive>0 else -1)
    donor=left if direction>0 else right
    if kind=='valve':
        R=Kvalve*ref['rho']/donor['rho'];B=(left['c']+right['c'])/A
        j=0. if drive==0 else 2*drive/(alpha*B+math.sqrt((alpha*B)**2+4*R*abs(drive)))
    else:j=A*(drive+(b['checkCrack_Pa'] if kind=='check' else 0.))/(left['c']+right['c'])
    start=np.array([j,wL-left['c']*alpha*j/A,wR+right['c']*alpha*j/A,donor['h']])
    scale=np.array([25.,1e4,1e4,100.]);row=np.array([1e4,1e4,1e4,1.])
    fun=lambda d:boundary(left,right,alpha,start+scale*d,kind)[0]/row
    h=np.array([1e-6,.001,.001,1e-5])
    jac=lambda d:np.column_stack([(fun(d+np.eye(4)[i]*v)-fun(d-np.eye(4)[i]*v))/(2*v) for i,v in enumerate(h)])
    sol=root(fun,np.zeros(4),jac=jac,options=dict(xtol=1e-8,maxfev=200))
    result=start+scale*sol.x;rr=boundary(left,right,alpha,result,kind)[0]
    if max(abs(rr[:3]))>.01 or abs(rr[3])>1e-5:
        raise ValueError(dict(reason='Initial stationary boundary equations rejected',kind=kind,drive_Pa=float(drive),
          residualPressure_Pa=rr[:3].tolist(),residualEnthalpy_J_kg=float(rr[3]),solverStatus=int(sol.status)))
    return result

def joined(x,va,ca,alpha,seated,failedOpen,valveClosed):
    Y,cv,pv,r,receiver,pipeBottom,pipeTop,tankBottom=port_views(x)
    cd,cdet=operator(dict(cm,recover=lambda unused:cv),Y[:3*nc])
    pd,pdet=operator(dict(pm,recover=lambda unused:pv),Y[3*nc:3*N]);cd=cd.reshape(3,nc);pd=pd.reshape(3,np_)
    vr,v=boundary(pipeTop,tankBottom,alpha,va,'valve',valveClosed)
    cr,c=boundary(receiver,pipeBottom,1.,ca,'failed-open' if failedOpen else 'check',seated)
    left=np.array([v['m'],v['momL'],v['energy']]);right=np.array([v['m'],v['momR'],v['energy']])
    cd[:,0]+=right-cdet['flux'][0];pd[:,-1]-=left-pdet['flux'][-1]
    receive=np.array([c['m'],c['momR'],c['energy']]);pd[:,0]+=receive-pdet['flux'][0]
    M,P,E=Y[3*nc:3*N].reshape(3,np_);velocity=P/M;rho=M/pm['V'];wall=np.zeros(np_)
    for i in range(np_):
        if velocity[i]==0:continue
        density_props(rho[i],pv[0][i]);re=rho[i]*abs(velocity[i])*b['bore_m']/water.viscosity();laminar=64/re
        if re<=2300:f=laminar
        else:
            turbulent=brentq(lambda f:1/math.sqrt(f)+2*math.log10(b['roughness_m']/(3.7*b['bore_m'])+2.51/(re*math.sqrt(f))),.001,.2)
            f=turbulent if re>=4000 else laminar+(turbulent-laminar)*(re-2300)/1700
        wall[i]=-A*f*data['pipeLengths_m'][i]/b['bore_m']*rho[i]*velocity[i]*abs(velocity[i])/2
    # No duplicate isolation/check body forces. Native body water is unchanged; wall friction remains.
    pd[1]+=wall
    d=np.r_[cd.ravel(),pd.ravel(),-c['m'],-c['energy']]
    kinetic=kineticRate=0.
    for off,n in [(0,nc),(3*nc,np_)]:
        m,p=Y[off:off+n],Y[off+n:off+2*n];u=p/m
        kinetic+=float(sum(p*p/(2*m)))
        kineticRate+=float(-.5*(u*u)@d[off:off+n]+u@d[off+n:off+2*n])
    return Y,d,np.r_[vr,cr],dict(sourceFlow_kg_s=-v['m'],receiverFlow_kg_s=-c['m'],dviPressure_Pa=r['p_reference'],
      kineticEnergy_J=kinetic,kineticChainRate_W=kineticRate,wallDissipation_W=float(-wall@velocity),
      valveEntropyProduction_W_K=v['entropy'],checkEntropyProduction_W_K=c['entropy'],checkDrive_Pa=c['drive'],
      checkForward=bool(c['m']<=0),valve=v,check=c,
      maximumVelocity_m_s=float(max(max(abs(Y[nc:2*nc]/Y[:nc])),max(abs(velocity)))),
      inclinedGravityForceResidual_N=float(max(abs(A*(pv[1][:,1,2]-pv[1][:,0,2])+g*M*(data['mouth_m']-b['dviPort_m'])/b['length_m']))))

def threshold_checks():
    q=liquid_pt_si(15.2e6,563.15);left=valve_port(np.array([q['rho'],0.,q['p'],q['u'],0.]));rows=[]
    for excess in [-1.,0.,1e-6,.001,1.,1000.]:
        q=liquid_pt_si(15.2e6+b['checkCrack_Pa']+excess,313.15)
        right=valve_port(np.array([q['rho'],0.,q['p'],q['u'],0.]));closed=excess<=0
        a=boundary_initial(left,right,1.,'check',closed);r,v=boundary(left,right,1.,a,'check',closed)
        old=hllc(np.array([left[k] for k in ['rho','v','p','u','c']]),np.array([right[k] for k in ['rho','v','p','u','c']]))*A
        rows.append(dict(excessHead_Pa=excess,seated=closed,oldOpenedFlow_kg_s=-float(old[0]),
          selectedFlow_kg_s=-v['m'],energyFlow_W=-v['energy'],entropyProduction_W_K=v['entropy'],
          pressureResidual_Pa=float(max(abs(r[:3]))),enthalpyResidual_J_kg=float(abs(r[3]))))
        if v['m']>0 or v['entropy'] < -1e-10:raise ValueError('Healthy threshold admits reversed or entropy-decreasing transport')
    if rows[1]['selectedFlow_kg_s']!=0 or rows[2]['selectedFlow_kg_s']>=1e-9:raise ValueError('Cracking limit does not close')
    return rows

# These are algebraic trial coordinates only. Native M/P/E and reservoir M/E remain differential owners.
nativeSize=3*N+2;pressureCount=N+2;totalSize=nativeSize+pressureCount+8+2
energyIndex=np.r_[np.arange(2*nc,3*nc),np.arange(3*nc+2*np_,3*N)].astype(int)
pressureIndex=np.r_[np.arange(2*nc,3*nc),np.arange(3*nc+2*np_,3*N),3*N,3*N+1].astype(int)
nativeScales=np.r_[np.ones(nc),np.ones(nc),np.full(nc,1e4),np.ones(np_),np.ones(np_),np.full(np_,1e4),1.,1e4]

def make_trial(native,pressure):
    x=native.copy();x[pressureIndex]=pressure
    return x

def adaptive_run(name,receiverPressure,closed=False,failedOpen=False,heat=0,tight=False,duration=.5):
    started=time.perf_counter();calls=jacCalls=0;history=[];events=[];failure=None;lastTrialTime=0.;target=0.
    x0=initial(receiverPressure,heat);Y0,cv,pv,r,receiver,pb,pt,tb=port_views(x0)
    initialDrive=receiver['p']-pb['p']+pb['rho']*pb['c']*pb['v']
    seated=not failedOpen and initialDrive>=-b['checkCrack_Pa'];alpha0=0.
    va=boundary_initial(pt,tb,alpha0,'valve',closed);ca=boundary_initial(receiver,pb,1.,'failed-open' if failedOpen else 'check',seated)
    base=np.r_[Y0,x0[pressureIndex],va,ca,0.,0.];y=np.zeros(totalSize);lastNative=Y0.copy()
    initialK=sum(float(sum(Y0[off+n:off+2*n]**2/(2*Y0[off:off+n]))) for off,n in [(0,nc),(3*nc,np_)])
    nativeAtol=np.r_[np.full(nc,1e-9),np.full(nc,1e-8),np.full(nc,1e-3),np.full(np_,1e-9),np.full(np_,1e-8),np.full(np_,1e-3),1e-9,1e-3]
    atol=np.r_[nativeAtol,np.full(N+1,.1),1e-8,np.tile([1e-8,.1,.1,1e-5],2),1e-8,1e-8]/(10 if tight else 1)
    probes=np.r_[np.full(nc,1e-7),np.full(nc,1e-6),np.full(nc,.001),np.full(np_,1e-7),np.full(np_,1e-6),np.full(np_,.001),1e-7,.001,
      np.full(N+1,100.),.001,np.tile([1e-6,10.,10.,.001],2),1e-6,1e-6]
    def evaluate(t,delta):
        all_=base+delta;native=all_[:nativeSize];p=all_[nativeSize:nativeSize+pressureCount]
        x=make_trial(native,p);a=0. if closed else min(t/b['opening_s'],1.)
        return joined(x,all_[-10:-6],all_[-6:-2],a,seated,failedOpen,closed)
    def resfn(t,delta,yp,out):
        nonlocal calls,lastTrialTime
        calls+=1;lastTrialTime=float(t)
        if time.perf_counter()-started>300:raise RuntimeError('Predeclared 300 s case execution budget exhausted')
        Y,d,br,view=evaluate(t,delta);native=base[:nativeSize]+delta[:nativeSize]
        out[:nativeSize]=(yp[:nativeSize]-d)/nativeScales
        # Exact native energy/storage constraints, no equilibrium reset or added compliance.
        out[nativeSize:nativeSize+N]=(native[energyIndex]-Y[energyIndex])/1e4
        out[nativeSize+N:nativeSize+pressureCount]=(native[-2:]-Y[-2:])/np.array([1.,1e4])
        br=br.copy()
        if closed:br[0]*=1e4 # closed first row has flow units, unlike open characteristic pressure.
        if seated:br[4]*=1e4
        out[-10:-2]=br/np.tile([1e4,1e4,1e4,1.],2)
        out[-2]=yp[-2]-view['kineticChainRate_W'];out[-1]=yp[-1]-view['wallDissipation_W']
    def jacfn(t,delta,yp,residual,cj,J):
        nonlocal jacCalls
        jacCalls+=1;plus=np.empty(totalSize);minus=np.empty(totalSize)
        for j,h in enumerate(probes):
            step=np.zeros(totalSize);step[j]=h
            resfn(t,delta+step,yp,plus);resfn(t,delta-step,yp,minus);J[:,j]=(plus-minus)/(2*h)
        J[np.arange(nativeSize),np.arange(nativeSize)]+=cj/nativeScales
        J[-2,-2]+=cj;J[-1,-1]+=cj
    def eventfn(t,delta,yp,out):
        _,_,_,v=evaluate(t,delta)
        out[0]=v['checkDrive_Pa']+b['checkCrack_Pa'] if seated else v['receiverFlow_kg_s']
    eventfn.direction=[-1];eventfn.terminal=[True]
    def solver_at(t,delta):
        yp=np.zeros(totalSize);_,d,_,v=evaluate(t,delta);yp[:nativeSize]=d;yp[-2]=v['kineticChainRate_W'];yp[-1]=v['wallDissipation_W']
        rr=np.empty(totalSize);resfn(t,delta,yp,rr)
        if max(abs(rr))>1e-7:raise ValueError(dict(reason='Inconsistent native/algebraic initial residual',maximumScaledResidual=float(max(abs(rr)))))
        options=dict(algebraic_idx=list(range(nativeSize,totalSize-2)),rtol=1e-5 if tight else 1e-4,atol=atol,
          max_step=.005 if tight else .01,jacfn=jacfn,max_num_steps=10000)
        if not failedOpen:options.update(eventsfn=eventfn,num_events=1)
        solver=IDA(resfn,**options);result=solver.init_step(t,delta,yp)
        if not result.success:raise ValueError(str(result.message))
        return solver
    try:
        solver=solver_at(0.,y)
        for target in np.arange(.025,duration+.0125,.025):
            result=solver.step(float(target),tstop=float(target))
            if not result.success:raise ValueError(dict(reason='IDA stopped',status=int(result.status),message=str(result.message)))
            if abs(float(result.t)-target)>1e-10:
                # Stop rather than hiding an unresolved active-set restart with a nudge or state projection.
                events.append(dict(t_s=float(result.t),seated=bool(seated),kind='check-threshold' if seated else 'check-seating',
                  nativeAtRoot=(base[:nativeSize]+result.y[:nativeSize]).tolist()))
                raise ValueError('Check event reached; restart consistency requires explicit review')
            candidate=np.array(result.y);native=base[:nativeSize]+candidate[:nativeSize]
            Y,d,br,v=evaluate(float(target),candidate);mass,energy=native_ledger(native,Y0)
            rateResidual=np.array(result.yp[:nativeSize])-d;stepCeiling=.005 if tight else .01
            rateGroups=[np.r_[rateResidual[:nc],rateResidual[3*nc:3*nc+np_],rateResidual[-2]],
              np.r_[rateResidual[nc:2*nc],rateResidual[3*nc+np_:3*nc+2*np_]],
              np.r_[rateResidual[2*nc:3*nc],rateResidual[3*nc+2*np_:3*N],rateResidual[-1]]]
            rateMax=[float(max(abs(a))) for a in rateGroups]
            for value,gate in zip(rateMax,[1e-7,1e-5,.01]):
                if value*stepCeiling>gate:raise ValueError('Returned differential equation residual exceeds stated local defect indicator')
            ep=float(max(abs(native[energyIndex]-Y[energyIndex])));rm=abs(float(native[-2]-Y[-2]));re=abs(float(native[-1]-Y[-1]))
            if ep>.01 or rm>1e-7 or re>.01 or max(abs(br[[0,1,2,4,5,6]]))>.01 or max(abs(br[[3,7]]))>1e-5:
                raise ValueError(dict(reason='Accepted-state algebraic physical equations rejected',fieldEnergy_J=ep,reservoirMass_kg=rm,reservoirEnergy_J=re,boundaryResidual=br.tolist()))
            if (not failedOpen and (not v['checkForward'] or (seated and v['checkDrive_Pa'] < -b['checkCrack_Pa']-.001))) or min(v['valveEntropyProduction_W_K'],v['checkEntropyProduction_W_K']) < -1e-8:
                raise ValueError('Accepted state violates donor/check/entropy admission')
            history.append(dict(t_s=float(target),alpha=0. if closed else float(min(target/b['opening_s'],1.)),seated=bool(seated),
              dviPressure_Pa=v['dviPressure_Pa'],receiverMassChange_kg=float(native[-2]-Y0[-2]),
              sourceFlow_kg_s=v['sourceFlow_kg_s'],receiverFlow_kg_s=v['receiverFlow_kg_s'],kineticEnergy_J=v['kineticEnergy_J'],
              kineticChainDefect_J=float(v['kineticEnergy_J']-initialK-candidate[-2]),wallDragEnergy_J=float(candidate[-1]),
              differentialResidual_by_M_P_E_per_s=rateMax,maxStepScaledEquationDefect_by_M_P_E=[a*stepCeiling for a in rateMax],
              massLedger_kg=mass,energyLedger_J=energy,maximumVelocity_m_s=v['maximumVelocity_m_s']))
            y=candidate;lastNative=native.copy()
    except (ValueError,RuntimeError) as error:failure=dict(reason=str(error),lastAcceptedSample_s=history[-1]['t_s'] if history else 0.,attemptedOutputTime_s=float(target))
    return dict(case=name,tight=tight,requestedDuration_s=duration,completed=failure is None,failure=failure,history=history,events=events,
      initialNativeState=Y0.tolist(),finalNativeState=lastNative.tolist(),initialDviPressure_Pa=float(x0[-2]),initialSeated=bool(not failedOpen and initialDrive>=-b['checkCrack_Pa']),
      residualCalls=calls,jacobianCalls=jacCalls,lastResidualTrialTime_s=lastTrialTime,wall_s=time.perf_counter()-started)
`

export const deliveryIdaCalculation = deliveryIdaSetup + String.raw`
print(json.dumps(dict(phase='boundary',threshold=threshold_checks(),versions=dict(sksundae=sksundae.__version__,CoolProp=CoolProp.__version__)),allow_nan=False),flush=True)
for args in [('closed-rest',15.2e6,True),('opening',15.19e6)]:
    row=adaptive_run(*args);print(json.dumps(dict(phase='case',result=row),allow_nan=False),flush=True)
    if not row['completed']:break
`

// Static receipt for the current diagnostic revision; the original timed calculation is retained privately verbatim.
export const deliveryIdaStaticCalculation = deliveryIdaSetup + String.raw`
rows=[];failures=[]
for name,pressure,alpha,shut,failed,heat,moving in [
  ('closed-rest',15.2e6,0.,True,False,0.,0.),('closed-receiver-heat',15.2e6,0.,True,False,1000.,0.),
  ('forward-initial-opening',15.19e6,0.,False,False,0.,0.),('forward-quarter-opening',15.19e6,.25,False,False,0.,0.),
  ('reverse-failed-open',15.21e6,.25,False,True,0.,.01),('reverse-healthy',15.21e6,.25,False,False,0.,.01),
  ('moving-forward-healthy',15.2e6,.25,False,False,0.,-.01)]:
    x=initial(pressure,heat)
    x[nc:2*nc]=moving*x[:nc];x[3*nc+np_:3*nc+2*np_]=moving*x[3*nc:3*nc+np_]
    native,cv,pv,r,receiver,pb,pt,tb=port_views(x)
    drive=receiver['p']-pb['p']+pb['rho']*pb['c']*pb['v'];seated=not failed and drive>=-b['checkCrack_Pa']
    try:
        va=boundary_initial(pt,tb,alpha,'valve',shut);ca=boundary_initial(receiver,pb,1.,'failed-open' if failed else 'check',seated)
    except ValueError as error:
        failures.append(dict(case=name,reason=str(error)));continue
    Y,d,br,v=joined(x,va,ca,alpha,seated,failed,shut)
    # No boundary initializer is allowed to alter native water, momentum or energy.
    check('static native initial-state identity',float(max(abs(Y-native))),0.)
    mass=float(sum(d[:nc])+sum(d[3*nc:3*nc+np_])+d[-2])
    energy=float(sum(d[2*nc:3*nc])+sum(d[3*nc+2*np_:3*N])+d[-1])
    check('joined interface total mass rate kg/s',mass,1e-9);check('joined interface total energy rate W',energy,1e-5)
    check('actual inclined gravity force N',v['inclinedGravityForceResidual_N'],1e-5)
    check('initial boundary pressure Pa',max(abs(br[[0,1,2,4,5,6]])),.01)
    check('initial boundary enthalpy J/kg',max(abs(br[[3,7]])),1e-5)
    if not failed and not v['checkForward']:raise ValueError('Healthy check returned reverse transport')
    if min(v['wallDissipation_W'],v['valveEntropyProduction_W_K'],v['checkEntropyProduction_W_K']) < -1e-8:
        raise ValueError('Static boundary/wall entropy or work admission failed')
    independent=stationary_valve(pt,tb,alpha)
    # Initial opening at alpha=0 uses a virtual j limit, but physical flux is exactly reflected/zero.
    valveErrors=[abs(v['valve'][k]-independent[j]) for k,j in [('m','massFlow_kg_s'),('energy','energyFlow_W'),
      ('momL','leftMomentumFlux_N'),('momR','rightMomentumFlux_N')]]
    for err,tol in zip(valveErrors,[1e-8,.01,.001,.001]):check('retained stationary isolation law equivalence',err,tol)
    oldY,oldD,oldView=rates(x,alpha,seated,failed)
    correction=np.zeros_like(d)
    if alpha>0:
        oldValve=hllc(pv[1][-1,1],cv[1][0,0]);oldValve[2]+=g*data['mouth_m']*oldValve[0];oldValve*=A
    else:
        oldValve=np.array([0.,A*pt['p'],0.]) # Moving closed comparison below uses actual reflecting fluxes.
    _,cdet=operator(dict(cm,recover=lambda unused:cv),Y[:3*nc]);_,pdet=operator(dict(pm,recover=lambda unused:pv),Y[3*nc:3*N])
    priorLeft=oldValve if alpha>0 else pdet['flux'][-1];priorRight=oldValve if alpha>0 else cdet['flux'][0]
    newLeft=np.array([v['valve']['m'],v['valve']['momL'],v['valve']['energy']]);newRight=np.array([v['valve']['m'],v['valve']['momR'],v['valve']['energy']])
    for k in range(3):correction[k*nc]+=newRight[k]-priorRight[k];correction[3*nc+k*np_+np_-1]-=newLeft[k]-priorLeft[k]
    if seated:oldReceive=pdet['flux'][0]
    else:
        oldReceive=hllc(np.array([receiver[k] for k in ['rho','v','p','u','c']]),pv[1][0,0]);oldReceive[2]+=g*b['dviPort_m']*oldReceive[0];oldReceive*=A
    newReceive=np.array([v['check']['m'],v['check']['momR'],v['check']['energy']])
    for k in range(3):correction[3*nc+k*np_]+=newReceive[k]-oldReceive[k]
    correction[-2]-=newReceive[0]-(0. if seated else oldReceive[0]);correction[-1]-=newReceive[2]-(0. if seated else oldReceive[2])
    # Independently remove only the two superseded body forces, never their owned pipe water.
    if alpha>0:
        m,p,_=Y[3*nc:3*N].reshape(3,np_);vel=p[-1]/m[-1];rho=m[-1]/pm['V'][-1]
        former=-A*Kvalve*ref['rho']/rho*(rho*A*vel)*abs(rho*A*vel)/(alpha*alpha)
        correction[3*nc+2*np_-1]-=former
    if not seated and not failed:correction[3*nc+np_]-=A*b['checkCrack_Pa']
    replacement=float(max(abs(d-oldD-correction)));check('complete M P E replacement bookkeeping SI',replacement,1e-5)
    seed=res['forward'](r['p_reference'],r['s']);steps=[100.,.001];J=[]
    for index,h in enumerate(steps):
        plus=[r['p_reference'],r['s']];minus=plus.copy();plus[index]+=h;minus[index]-=h
        a=res['forward'](*plus);z=res['forward'](*minus);J.append([(a['M']-z['M'])/(2*h),(a['E']-z['E'])/(2*h)])
    reservoirRates=np.linalg.solve(np.array(J).T,d[-2:])
    unheated=decode(initial(pressure,0.))[0]
    rows.append(dict(case=name,alpha=alpha,seated=bool(seated),sourceFlow_kg_s=v['sourceFlow_kg_s'],receiverFlow_kg_s=v['receiverFlow_kg_s'],
      massRateLedger_kg_s=mass,energyRateLedger_W=energy,maximumBoundaryPressureResidual_Pa=float(max(abs(br[[0,1,2,4,5,6]]))),
      maximumBoundaryEnthalpyResidual_J_kg=float(max(abs(br[[3,7]]))),replacementBookkeepingMaximum_SI=replacement,
      retainedIsolationLawErrors_M_E_Pleft_Pright=valveErrors,wallDissipation_W=v['wallDissipation_W'],
      valveEntropyProduction_W_K=v['valveEntropyProduction_W_K'],checkEntropyProduction_W_K=v['checkEntropyProduction_W_K'],
      nativeInitialKinetic_J=v['kineticEnergy_J'],kineticChainRate_W=v['kineticChainRate_W'],
      finiteDviPressureRate_Pa_s=float(reservoirRates[0]),finiteDviEntropyRate_J_kgK_s=float(reservoirRates[1]),
      initialDviPressure_Pa=r['p_reference'],receiverAddedNativeEnergy_J=float(Y[-1]-unheated[-1]),
      receiverMassChangeFromUnheated_kg=float(Y[-2]-unheated[-2]),nativeState=Y.tolist()))
print(json.dumps(dict(phase='static',threshold=threshold_checks(),cases=rows,
  failures=failures,staticReplacementChecksPassed=not failures,initialAlgebraicChecksPassed=not failures,advancedStateMeasured=False,
  temporalScreenQualified=False,checkEventRestartQualified=False,
  versions=dict(sksundae=sksundae.__version__,CoolProp=CoolProp.__version__,numpy=np.__version__,scipy=scipy.__version__)),allow_nan=False),flush=True)
`

if (import.meta.main) {
  const [receipt, python, output, mode] = Bun.argv.slice(2)
  if (!receipt || !python || !output || ![5, 6].includes(Bun.argv.length) || (mode !== undefined && mode !== 'static')) throw Error('Usage: cmt-delivery-ida.ts retained-delivery.json research-python output.json [static]')
  const old = await Bun.file(receipt).json(), hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const input = JSON.stringify(old.input)
  if (old.inputHash !== hash(input)) throw Error('Retained input identity mismatch')
  const calculation = mode === 'static' ? deliveryIdaStaticCalculation : deliveryIdaCalculation
  const identity = { sourceHash: hash(await Bun.file(import.meta.path).text()), calculationHash: hash(calculation), inputHash: hash(input), retainedCalculationHash: old.calculationHash }
  const child = Bun.spawn([python, '-c', calculation], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'inherit' })
  const records: unknown[] = []; let pending = ''
  for await (const chunk of child.stdout) {
    pending += new TextDecoder().decode(chunk)
    for (;;) {
      const newline = pending.indexOf('\n'); if (newline < 0) break
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      if (!line.trim()) continue
      const record = JSON.parse(line); records.push(record)
      await Bun.write(output, JSON.stringify({ ...identity, input: old.input, records, fullTemporalScreenQualified: false, liveRuntime: false }, null, 2))
      console.error(JSON.stringify(record.phase === 'case' ? { case: record.result.case, completed: record.result.completed, failure: record.result.failure, wall_s: record.result.wall_s } : { phase: record.phase }))
    }
  }
  const code = await child.exited
  if (code !== 0 || pending.trim()) throw Error('CMT IDA feasibility process did not finish cleanly; completed records retained')
}
