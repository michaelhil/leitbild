/** Shared offline pure-water contact laws. Callers own material/geometry and applicability.
 * Python inputs: native PropsSI P, math/functools/brentq, g/sb, pool(), and geo's
 * steelConductivity_W_mK, steelDensity_kg_m3, steelCp_J_kgK. No plant fixture.
 */
export const nativePoolContactPython=String.raw`@functools.cache
def sat(p):
 return dict(p=p,T=P('T','P',p,'Q',0,'Water'),**{n:P(k,'P',p,'Q',q,'Water') for n,k,q in [('rl','D',0),('rv','D',1),('hl','H',0),('hv','H',1),('ul','U',0),('uv','U',1),('kl','L',0),('kv','L',1),('muv','V',1),('cp','C',0),('sigma','I',0)]})
def liquid_h(p,T,Tw,D):
 # Retained external liquid film; saturation is used only for its stable-liquid film endpoint.
 s=sat(p);tf=(T+min(Tw,s['T']))/2
 atSat=abs(tf-s['T'])<1e-8
 def prop(k):return P(k,'P',p,'Q',0,'Water') if atSat else P(k,'P',p,'T',tf,'Water')
 rho,mu,k,cp,beta=[prop(k) for k in ['D','V','L','C','ISOBARIC_EXPANSION_COEFFICIENT']]
 pr=mu*cp/k;ra=g*beta*abs(Tw-T)*D**3/(mu/rho*(k/(rho*cp)))
 return (.6+.387*ra**(1/6)/(1+(.559/pr)**(9/16))**(8/27))**2*k/D
def internal_stagnant_h(p,T,Tw,D):
 # Actual pre-existing INL zero-velocity liquid film, NOT exterior Churchill-Chu.
 s=sat(p)
 def bulk(k):return P(k,'P',p,'Q',0,'Water') if abs(T-s['T'])<1e-7 else P(k,'P',p,'T',T,'Water')
 mu,k,cp,beta=[bulk(key) for key in ['V','L','C','ISOBARIC_EXPANSION_COEFFICIENT']]
 tf=(T+Tw)/2;rho=s['rl'] if abs(tf-s['T'])<1e-8 else P('D','P',p,'T',tf,'Water');pr=mu*cp/k
 ra=g*beta*abs(T-Tw)*D**3/(mu/rho)**2*pr
 return max(3.66,.59*ra**.25,.13*ra**(1/3))*k/D
def wet_state(p,T,Tw,D,h=None):
 s=sat(p);h=liquid_h(p,T,Tw,D) if h is None else h
 if Tw<=T:return h*(Tw-T),T
 f=1-math.exp(-math.radians(38)**3-.5*math.radians(38))
 on=2*h*s['sigma']*s['T']/(f*f*s['rv']*(s['hv']-s['hl'])*P('L','P',p,'T',T,'Water')) if T<s['T']-1e-8 else 2*h*s['sigma']*s['T']/(f*f*s['rv']*(s['hv']-s['hl'])*s['kl'])
 ton=T+.25*(math.sqrt(on)+math.sqrt(on+4*(s['T']-T)))**2
 q=h*(Tw-T)
 return (q if Tw<=ton else (q**3+(pool(p/1e6,Tw-s['T'],False)-pool(p/1e6,ton-s['T'],False))**3)**(1/3)),ton
def wet(p,T,Tw,D,h=None):return wet_state(p,T,Tw,D,h)[0]
def film(p,Tw,D,epsilon):
 s=sat(p);tf=(Tw+s['T'])/2
 rv,kv,mu,hv=[P(k,'P',p,'T',tf,'Water') for k in ['D','L','V','H']]
 # Bromley's mean film enthalpy minus saturation liquid, not an added heat source.
 h=.62*(kv**3*rv*(s['rl']-rv)*g*(hv-s['hl'])/(D*mu*(Tw-s['T'])))**.25
 return h*(Tw-s['T'])+epsilon*sb*(Tw**4-s['T']**4)
def minimum_film(p,T):
 s=sat(p);ts=s['T'];hf=s['hv']-s['hl'];eff=math.sqrt(s['kl']*s['rl']*s['cp']/(geo['steelConductivity_W_mK']*geo['steelDensity_kg_m3']*geo['steelCp_J_kgK']))
 dp=3203.6-p/6894.757293168
 hn=(705.44-.04722*dp+2.3907e-5*dp*dp-5.8193e-9*dp**3-32)*5/9+273.15
 hn+= (hn-T)*eff
 tb=ts+.127*s['rv']*hf/s['kv']*(g*(s['rl']-s['rv'])/(s['rl']+s['rv']))**(2/3)*(s['sigma']/(g*(s['rl']-s['rv'])))**.5*(s['muv']/(g*(s['rl']-s['rv'])))**(1/3)
 henry=tb+.42*(tb-T)*(eff*hf/(geo['steelCp_J_kgK']*(tb-ts)))**.6
 return max(755.3722222222222,min(898.7055555555555,max(hn,henry)))
@functools.cache
def endpoints(p,T,D,h=None,epsilon=.3):
 s=sat(p);qchf=.131*(s['hv']-s['hl'])*math.sqrt(s['rv'])*(g*s['sigma']*(s['rl']-s['rv']))**.25*math.sqrt(s['rl']/(s['rl']+s['rv']))
 tm=minimum_film(p,T);tc=brentq(lambda tw:wet(p,T,tw,D,h)-qchf,T,tm)
 qm=film(p,tm,D,epsilon)
 if not s['T']<tc<tm or not 0<qm<qchf:raise ValueError(('Unordered thermal endpoints',p,T,D,tc,tm,qm,qchf))
 return tc,tm,qchf,qm
def contacted(p,T,Tw,D,h=None,epsilon=.3):
 pre,onset=wet_state(p,T,Tw,D,h)
 if Tw<=onset:return pre,'sensible-liquid'
 tc,tm,qc,qm=endpoints(p,T,D,h,epsilon)
 if Tw<=tc:return pre,'liquid'
 if Tw<tm:
  w=((Tw-tm)/(tc-tm))**2
  return w*qc+(1-w)*qm,'transition'
 return film(p,Tw,D,epsilon),'film'
`
