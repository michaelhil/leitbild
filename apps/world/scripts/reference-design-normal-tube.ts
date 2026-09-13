/** Offline liquid tube. Caller owns EOS, geometry, heat/loss laws and physical integration knots. */
export const normalTubeDefinitions=String.raw`
def tube(p,H,q,D,L,wall,z_at,slope,minor,stress,knots=()):
    if q<=0:raise ValueError('No positive throughflow: this advective normal-state reduction cannot hold a disconnected line warm')
    area=math.pi*D*D/4
    hh=H-g*z_at(0)
    for _ in range(4):state=ph(p,hh);hh=H-g*z_at(0)-.5*(q/(state['rho']*area))**2
    inlet=ph(p,hh)
    def rhs(x,y):
        state=ph(p+y[0],hh+y[1]);v=q/(state['rho']*area);Re=q*D/(area*state['mu'])
        friction=math.exp(log_darcy_factor(Re,r['roughness_m']/D))/D+minor/L
        heat=heat_path(state['T'],D/2,wall,1,normal['liquidContact_W_m2K'],stress)['heat_W']
        matrix=[[1-v*v*state['rp'],-v*v*state['rh']],[-v*v/state['rho']*state['rp'],1-v*v/state['rho']*state['rh']]]
        gradients=np.linalg.solve(matrix,[-state['rho']*g*slope(x)-friction*state['rho']*v*v/2,-g*slope(x)-heat/q])
        return [*gradients,heat,area*state['rho'],area*state['rho']*(state['h']-state['p']/state['rho']),area*state['rho']*g*z_at(x),.5*area*state['rho']*v*v]
    # Relative errors weight inlet increments, not absolute thermodynamic baselines.
    # Knots are authored geometry interfaces, never fitted stepping parameters.
    bounds=[0.,*knots,L]
    if any(not math.isfinite(a) or not a<b for a,b in zip(bounds,bounds[1:])) or not math.isfinite(L):raise ValueError('Physical integration boundaries must be finite and strictly ordered inside the route')
    y=np.zeros(7);calls=1
    for a,b in zip(bounds,bounds[1:]):
        solved=solve_ivp(rhs,[a,b],y,method='DOP853',rtol=2e-9,atol=[1e-3,1e-6,1e-5,1e-7,1e-2,1e-5,1e-9])
        if not solved.success:raise ValueError(solved.message)
        y=solved.y[:,-1];calls+=len(solved.t)-1
    out=ph(p+y[0],hh+y[1]);v=q/(out['rho']*area);out['H']=out['h']+v*v/2+g*z_at(L)
    return dict(outlet=out,heatLoss_W=y[2],mass_kg=y[3],internalEnergy_J=y[4],potentialEnergy_J=y[5],kineticEnergy_J=y[6],
        energyResidual_W=q*(H-out['H'])-y[2],volume_m3=area*L,steelMass_kg=7920*math.pi*((D/2+wall)**2-(D/2)**2)*L,
        inletTemperature_K=inlet['T'],calls=calls,endVelocity_m_s=v,physicalIntegrationBoundaries_m=bounds,
        entropyProductionIncludingAmbient_W_K=q*(out['s']-inlet['s'])+y[2]/normal['ambient_K'],
        coordinates='pressure and enthalpy increments from actual inlet; native inventories unchanged')
`
