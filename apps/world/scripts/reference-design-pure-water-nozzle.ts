/** Shared native pure-water sizing limit for offline equipment coupons, not a runtime or NC law. */
export const pureWaterNozzleFunctions = String.raw`
from CoolProp.CoolProp import PropsSI as P
from scipy.optimize import minimize_scalar
import math
def waterflux_ph(p,h,pd):
 if not all(math.isfinite(v) for v in [p,h,pd]) or not 0<pd<=p:
  raise ValueError('Invalid forward native nozzle boundaries')
 if pd==p:return 0.
 s=P('Smass','P',p,'Hmass',h,'Water')
 def f(logp):
  pp=math.exp(logp)
  if pp==p:return 0.
  hh=P('Hmass','P',pp,'Smass',s,'Water');work=h-hh
  if work<0:raise ValueError(('Negative interior native expansion work',p,pp,work))
  return P('Dmass','P',pp,'Smass',s,'Water')*math.sqrt(2*work)
 best=minimize_scalar(lambda lp:-f(lp),bounds=(math.log(pd),math.log(p)),method='bounded',options={'xatol':1e-11})
 if not best.success:raise ValueError('Native nozzle maximum search failed')
 return max(f(math.log(pd)),-best.fun)
def waterflux(p,T,pd):
 return waterflux_ph(p,P('Hmass','P',p,'T',T,'Water'),pd)
`
