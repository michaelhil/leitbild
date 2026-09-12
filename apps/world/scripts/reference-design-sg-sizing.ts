/** Offline conversion of the declared thermal sizing reference, not a tube correlation. */
export const sgSizingPython = String.raw`
from scipy.integrate import quad, solve_ivp
import CoolProp.CoolProp as CP
import math

def logarithmic_mean(a,b):
    if not all(math.isfinite(x) and x>0 for x in [a,b]):
        raise ValueError('Sizing requires positive terminal temperature approaches')
    if a==b:return a
    return (a-b)/math.log1p((a-b)/b)

def size_sg_transfer(c):
    # Freeze one constant-pressure caloric path. The derived sizing flow is NOT
    # the circulating design flow: original cycle endpoints use different pressures.
    p=c['points']['RCP_suction']['p_MPaAbs']*1e6
    Tin=c['points']['core_outlet']['T_C']+273.15
    Tout=c['points']['RCP_suction']['T_C']+273.15
    Ts=c['points']['main_steam']['T_C']+273.15
    Tw=(Tout+Ts)/2;Q=c['powers_MW']['SG_total']*1e6/2
    if not Tin>Tout>Tw>Ts or Q<=0:raise ValueError('Invalid independent SG sizing reference')
    water=CP.AbstractState('HEOS','Water')
    def props(T):
        water.update(CP.PT_INPUTS,p,T)
        if water.phase()!=CP.iphase_liquid:raise ValueError('Sizing path must remain single-phase liquid')
        return water.hmass(),water.cpmass()
    hi,_=props(Tin);ho,_=props(Tout);m=Q/(hi-ho)
    integral,error=quad(lambda T:props(T)[1]/(T-Tw),Tout,Tin,epsabs=1e-8,epsrel=1e-11)
    Gp=m*integral;Gs=Q/(Tw-Ts)
    # Independent forward temperature ODE, and a separate integrated heat state.
    def rhs(x,y):
        _,cp=props(float(y[0]));heat=Gp*(y[0]-Tw)
        return [-heat/(m*cp),heat]
    forward=solve_ivp(rhs,[0,1],[Tin,0.],method='DOP853',rtol=1e-11,atol=[1e-9,.001])
    if not forward.success:raise ValueError(forward.message)
    finalT=float(forward.y[0,-1]);heat=float(forward.y[1,-1]);hf,_=props(finalT)
    terminalError=finalT-Tout;heatError=heat-Q;balanceError=heat-m*(hi-hf)
    # Analytic constant-cp limit, including the removable equal-approach case.
    analyticErrors=[]
    for a,b in [(30.,10.),(10.00001,10.),(10.,10.)]:
        integralConstant=quad(lambda T:1/T,b,a,epsabs=1e-14)[0]
        analyticErrors.append(0. if a==b else abs(integralConstant-(a-b)/logarithmic_mean(a,b)))
    rejects=0
    for a,b in [(0.,1.),(-1.,1.),(1.,float('nan'))]:
        try:logarithmic_mean(a,b)
        except ValueError:rejects+=1
    accepted=(abs(terminalError)<1e-6 and abs(heatError)<1 and abs(balanceError)<1
        and max(analyticErrors)<1e-12 and rejects==3 and logarithmic_mean(10.,10.)==10.)
    if not accepted:raise ValueError('SG sizing conversion failed independent checks')
    return dict(pressure_Pa=p,inlet_K=Tin,outlet_K=Tout,secondary_K=Ts,wall_K=Tw,
        perSGDuty_W=Q,caloricSizingFlow_kg_s=m,primaryConductance_W_K=Gp,secondaryConductance_W_K=Gs,
        originalMixedPrimaryConductance_W_K=Q/(Tout-Tw),constantCpEquivalent_W_K=Q/logarithmic_mean(Tin-Tw,Tout-Tw),
        integralErrorEstimate_W_K=m*error,forwardOutletError_K=terminalError,
        forwardHeatError_W=heatError,independentEnthalpyBalanceError_W=balanceError,
        analyticLimitErrors=analyticErrors,invalidApproachRejections=rejects,accepted=accepted,
        scope='Constant-pressure sizing reference converted to distributed primary/uniform-wall law; not physical tube UA or transient calibration')
`
