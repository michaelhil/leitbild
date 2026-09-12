/** Offline stationary boundary source; composition supplies HEOS, geometry, loss inputs and numerical primitives. */
export const stationaryValvePython = String.raw`
_valve_water=CP.AbstractState('HEOS','Water')
def valve_hp(p,h):
    _valve_water.update(CP.HmassP_INPUTS,h,p)
    if _valve_water.phase()!=CP.iphase_liquid:raise ValueError('Valve left admitted single-liquid branch')
    return dict(p=p,h=_valve_water.hmass(),u=_valve_water.umass(),rho=_valve_water.rhomass(),
      s=_valve_water.smass(),c=_valve_water.speed_sound())

def valve_port(trace):
    rho,v,p,u,c=trace;_valve_water.update(CP.DmassP_INPUTS,rho,p)
    if _valve_water.phase()!=CP.iphase_liquid:raise ValueError('Valve port is not liquid')
    return dict(p=float(p),v=float(v),rho=float(rho),h=_valve_water.hmass(),u=_valve_water.umass(),
      s=_valve_water.smass(),c=_valve_water.speed_sound())

def stationary_valve(left,right,alpha):
    if not math.isfinite(alpha) or not 0<=alpha<=1:raise ValueError('Invalid achieved conductance')
    ZL=left['rho']*left['c'];ZR=right['rho']*right['c']
    wallL=left['p']+ZL*left['v'];wallR=right['p']-ZR*right['v'];drive=wallL-wallR
    if alpha==0 or drive==0:
        # Same weak-wave reflection as the positive-opening limit. No fluid state is reset.
        liquid_ps_si(wallL,left['s']);liquid_ps_si(wallR,right['s'])
        return dict(massFlow_kg_s=0.,energyFlow_W=0.,leftMomentumFlux_N=A*wallL,rightMomentumFlux_N=A*wallR,
          wallForceOnFluid_N=A*(wallR-wallL),entropyProduction_W_K=0.,entropyRise_J_kgK=None,
          characteristicResidual_Pa=0.,lossResidual_Pa=0.,enthalpyResidual_J_kg=0.,energyFluxResidual_W=0.,
          maximumMach=0.,maximumRelativePressureChange=max(abs(wallL-left['p'])/left['p'],abs(wallR-right['p'])/right['p']),
          leftPressure_Pa=wallL,rightPressure_Pa=wallR,donor=None,solverStatus=None,solverSuccess=None)
    direction=1 if drive>0 else -1;donor=left if direction>0 else right
    R=Kvalve*ref['rho']/donor['rho'];B=(left['c']+right['c'])/A
    # j=m/alpha stays finite at closure. This is exact scaling, not a leakage floor.
    j0=2*drive/(alpha*B+math.sqrt((alpha*B)**2+4*R*abs(drive)));m0=alpha*j0
    pL0=wallL-left['c']*m0/A;pR0=wallR+right['c']*m0/A
    start=np.array([j0/25,(pL0-wallL)/1e4,(pR0-wallR)/1e4,0.])
    def evaluate(x):
        j=25*x[0];m=alpha*j;pL=wallL+1e4*x[1];pR=wallR+1e4*x[2];hd=donor['h']+100*x[3]
        up=liquid_ps_si(pL if direction>0 else pR,donor['s']);down=valve_hp(pR if direction>0 else pL,hd)
        qL,qR=(up,down) if direction>0 else (down,up)
        vL=m/(A*qL['rho']);vR=m/(A*qR['rho']);vu,vd=(vL,vR) if direction>0 else (vR,vL)
        Hup=up['h']+vu*vu/2+g*data['mouth_m'];Hdown=down['h']+vd*vd/2+g*data['mouth_m']
        residual=np.array([(pL-wallL+ZL*vL)/1e4,(pR-wallR-ZR*vR)/1e4,
          (pL-pR-Kvalve*ref['rho']/up['rho']*j*abs(j))/1e4,Hdown-Hup])
        return residual,(m,qL,qR,vL,vR,Hup,Hdown,down['s']-up['s'])
    def residual(x):return evaluate(x)[0]
    def jacobian(x):
        steps=[1e-6,.001,.001,1e-5]
        return np.column_stack([(residual(x+np.eye(4)[i]*h)-residual(x-np.eye(4)[i]*h))/(2*h) for i,h in enumerate(steps)])
    solution=root(residual,start,jac=jacobian,options=dict(xtol=1e-8,maxfev=200))
    r,(m,qL,qR,vL,vR,Hu,Hd,ds)=evaluate(solution.x)
    # Independently satisfied physical equations, not a solver-status-only acceptance policy.
    check('valve characteristic pressure Pa',float(max(abs(r[:2]))*1e4),.01)
    check('valve selected pressure loss Pa',float(abs(r[2])*1e4),.01)
    check('valve total enthalpy J/kg',float(abs(r[3])),1e-5)
    if m*direction<=0:raise ValueError('Valve solved donor direction is inconsistent')
    if ds < -1e-8:raise ValueError('Valve decreases downstream entropy')
    energy=m*Hu
    eL=m*(qL['u']+qL['p']/qL['rho']+vL*vL/2+g*data['mouth_m'])
    eR=m*(qR['u']+qR['p']/qR['rho']+vR*vR/2+g*data['mouth_m'])
    fluxError=max(abs(eL-energy),abs(eR-energy));check('valve decomposed energy flux W',float(fluxError),.001)
    leftMomentum=A*qL['p']+m*vL;rightMomentum=A*qR['p']+m*vR
    return dict(massFlow_kg_s=float(m),energyFlow_W=float(energy),leftMomentumFlux_N=float(leftMomentum),
      rightMomentumFlux_N=float(rightMomentum),wallForceOnFluid_N=float(rightMomentum-leftMomentum),
      entropyProduction_W_K=float(abs(m)*ds),entropyRise_J_kgK=float(ds),
      characteristicResidual_Pa=float(max(abs(r[:2]))*1e4),lossResidual_Pa=float(abs(r[2])*1e4),
      enthalpyResidual_J_kg=float(abs(r[3])),energyFluxResidual_W=float(fluxError),
      maximumMach=float(max(abs(vL)/left['c'],abs(vR)/right['c'])),
      maximumRelativePressureChange=float(max(abs(qL['p']-left['p'])/left['p'],abs(qR['p']-right['p'])/right['p'],
          abs(qL['p']-qR['p'])/min(qL['p'],qR['p']))),
      leftPressure_Pa=float(qL['p']),rightPressure_Pa=float(qR['p']),donor='left' if direction>0 else 'right',
      solverStatus=int(solution.status),solverSuccess=bool(solution.success))
`
