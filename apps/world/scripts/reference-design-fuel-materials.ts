/** Named, shared original-source laws for offline fuel references only. */
export const fuelMaterialPython=String.raw`
BTU=1055.05585262/3600/.3048*1.8
def kf(t):
    tc=t-273.15
    return BTU*(max(2335/(464+tc),1.1038)+.007027*math.exp(.001867*tc))
def fk(t):
    switch=2335/1.1038-464+273.15
    phonon=2335*math.log(464+min(t,switch)-273.15)+1.1038*max(0,t-switch)
    return BTU*(phonon+.007027/.001867*math.exp(.001867*(t-273.15)))
def fuelAreaMean(tf,tc):
    return quad(lambda t:t*kf(t),tf,tc,epsabs=1e-7)[0]/(fk(tc)-fk(tf))
def kc(t):return 7.51+.0209*t-1.45e-5*t*t+7.67e-9*t**3
def ck(t):return 7.51*t+.0209*t*t/2-1.45e-5*t**3/3+7.67e-9*t**4/4
def cpf(t):
    z=535.285/t
    return 296.7*z*z*math.exp(z)/math.expm1(z)**2+.0243*t+8.745e7*1.577e5/(8.3143*t*t)*math.exp(-1.577e5/(8.3143*t))
def hf(t):return 296.7*535.285/math.expm1(535.285/t)+.0243*t*t/2+8.745e7*math.exp(-1.577e5/(8.3143*t))
cpTs=[300,400,640,1090]; cpVals=[281,302,331,375]
def cpc(t):return float(np.interp(t,cpTs,cpVals))
def hc(t):
    # Exact primitive of the SAME piecewise-linear Cp; no quadrature inside
    # every implicit energy residual. The owning laws admit 300..1000 K.
    total=0.
    for i,(a,z) in enumerate(zip(cpTs,cpTs[1:])):
        if t>a:
            dt=min(t,z)-a;slope=(cpVals[i+1]-cpVals[i])/(z-a)
            total+=dt*(cpVals[i]+.5*slope*dt)
    return total
def fuelstrain(t):return 1e-5*t-.003+.04*math.exp(-6.9e-20/(1.38e-23*t))
def gap(ts,pg,geo,radiation):
    tw,ti,tf,tc=ts; rf,ri,ro,length,dr,stress,solidRf=geo
    tg=(tf+ti)/2; khe=1.314e-3*(1.8*tg)**.668*BTU
    accommodation=.425-2.3e-4*tg
    if accommodation<=0 or ri<=rf:raise ValueError('Outside open-gap/accommodation branch')
    jump=.3048*2.0358e-5*(khe/BTU)*math.sqrt(tg)/((pg/6894.757293168)*accommodation/math.sqrt(4.003))
    h=khe/(ri-rf+1.845*jump)
    qr=radiation*5.670374419e-8*(tf**4-ti**4)
    return h*(tf-ti)+qr,qr,jump,khe,h
`
/** Same mean-strain/elastic geometry owner used by steady and transient references. */
export const fuelGeometryPython=String.raw`
def geometry(ts,pg,j,expanded=True,externalPressure_MPa=None):
    tw,ti,tf,tc=ts; tm=(tw+ti)/2; rbar=(ri0+ro0)/2
    E=1.088e11-5.475e7*tm; G=4.04e10-2.168e7*tm; nu=E/(2*G)-1
    po=(b['coolantPressures_MPa'][j+1] if externalPressure_MPa is None else externalPressure_MPa)*1e6
    hoop=(ri0*pg-ro0*po)/(ro0-ri0)
    axial=(ri0**2*pg-ro0**2*po)/(ro0**2-ri0**2)
    er=(hoop-nu*axial)/E; ez=(axial-nu*hoop)/E
    if not expanded:return rf0+relocation,ri0,ro0,L0,0.,0.,rf0
    dr=er*rbar
    ri=ri0*(1+6.72e-6*(tm-300))+dr; ro=ro0*(1+6.72e-6*(tm-300))+dr
    solidRf=rf0*(1+fuelstrain((tf+tc)/2)-fuelstrain(300)); rf=solidRf+relocation
    length=L0*(1+4.44e-6*(tm-300)+ez)
    return rf,ri,ro,length,dr,hoop,solidRf
`
