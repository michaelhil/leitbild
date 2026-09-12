/** Shared offline liquid-face recovery. Caller owns mainFluid, m/area and the physical face datum. */
export const primaryTeeLiquidPython = String.raw`def ph(p,h):
    mainFluid.update(CP.HmassP_INPUTS,h,p)
    if mainFluid.phase()!=CP.iphase_liquid:raise ValueError('Tee candidate outside single-phase liquid')
    T=mainFluid.T()
    for _ in range(8):
        mainFluid.update(CP.PT_INPUTS,p,T)
        if mainFluid.phase()!=CP.iphase_liquid:raise ValueError('Forward recovery left liquid')
        error=mainFluid.hmass()-h
        if abs(error)<=1e-7:break
        T-=error/mainFluid.cpmass()
    if abs(error)>1e-7:raise ValueError('Forward enthalpy residual')
    return dict(p=p,h=mainFluid.hmass(),rho=mainFluid.rhomass(),T=mainFluid.T(),s=mainFluid.smass(),mu=mainFluid.viscosity(),
        rp=mainFluid.first_partial_deriv(CP.iDmass,CP.iP,CP.iHmass),rh=mainFluid.first_partial_deriv(CP.iDmass,CP.iHmass,CP.iP))
def face(p,h,m,area):
    q=ph(p,h);q['v']=m/(q['rho']*area);q['H']=q['h']+q['v']**2/2+g*zH
    q['dynamic']=q['rho']*q['v']**2/2;return q
`
