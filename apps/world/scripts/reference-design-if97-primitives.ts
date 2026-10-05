/**
 * Authored native IF97 adapter shared by the bounded offline LD-01 checks.
 * This is not an installed Pack or a property equation implementation.
 * Callers supply require() and the two disclosed forward-pressure diagnostics.
 * The upstream header and license remain independently acquired, immutable inputs.
 */
export const nativeIf97Revision = '0be7b51f35c47e59e6f91f4f0f47108bf997e50c';
export const nativeIf97HeaderSha256 = '83693f044b271a6a28b97c06601287d023f94a75fac9723412661ebf3d3791a6';
export const nativeIf97LicenseSha256 = 'e22c3d30ef8d88ab468d9ea20392ca1df22fa3fd0a92dc3e996d89cf3cfdbd03';

export function nativeIf97Source(threadLocalDiagnostics: boolean): string { return String.raw`
#define REGION3_ITERATE
#include "IF97.h"
#include <array>
#include <string>

void require(bool ok, const std::string& message);
extern ${threadLocalDiagnostics ? 'thread_local ' : ''}double max_forward_p, max_dense_endpoint_p_error;
template<class R> struct Gibbs : R {
    double alpha(double T, double p) const {
        const double gp = this->dgamma0_dPI(T,p) + this->dgammar_dPI(T,p);
        return (gp - this->T_star/T*this->d2gammar_dPIdTAU(T,p))/(T*gp);
    }
};
static const Gibbs<IF97::Region1> r1;
static const Gibbs<IF97::Region2> r2;
static const Gibbs<IF97::Region5> r5;
static const IF97::Region3 r3;
static const IF97::Region4 r4;

struct State { int region; double p,T,rho,u,h,s,cp,cv,w,alpha,kappa,mu,conductivity; };
State finite_tuple(State q) {
    const std::array<double,13> fields{{q.p,q.T,q.rho,q.u,q.h,q.s,q.cp,q.cv,q.w,q.alpha,q.kappa,q.mu,q.conductivity}};
    require(std::all_of(fields.begin(),fields.end(),[](double value){return std::isfinite(value);}),
        "Nonfinite field in returned native tuple");
    return q;
}
template<class R> State gibbs(const R& r, int region, double T,double p) {
    const double rho=r.rhomass(T,p);
    return finite_tuple({region,p,T,rho,r.umass(T,p),r.hmass(T,p),r.smass(T,p),r.cpmass(T,p),
        r.cvmass(T,p),r.speed_sound(T,p),r.alpha(T,p),r.drhodp(T,p)/rho,
        r.visc(T,rho),r.tcond(T,p,rho)});
}
State dense(double T,double rho) {
    const double p=r3.p(T,rho);
    const double a=r3.delta_dphi_ddelta(T,rho), b=r3.delta2_d2phi_ddelta2(T,rho);
    const double c=r3.deltatau_d2phi_ddelta_dtau(T,rho);
    return finite_tuple({3,p,T,rho,r3.umass(T,rho),r3.hmass(T,rho),r3.smass(T,rho),
        r3.cpmass(T,rho),r3.cvmass(T,rho),r3.speed_sound(T,rho),
        (a-c)/(T*(2*a+b)),r3.drhodp(T,rho)/rho,r3.visc(T,rho),r3.tcond(T,p,rho)});
}
State point(double T,double p) {
    if (!std::isfinite(T)||!std::isfinite(p)||p<=0||T<=0)
        throw std::domain_error("Invalid finite positive PT input");
    switch(IF97::RegionDetermination_TP(T,p)) {
        case IF97::REGION_1: return gibbs(r1,1,T,p);
        case IF97::REGION_2: return gibbs(r2,2,T,p);
        case IF97::REGION_3: {
            auto q=dense(T,IF97::rhomass_Tp(T,p));
            max_forward_p=std::max(max_forward_p,std::abs(q.p-p));
            require(std::abs(q.p-p)<=1,"Region3 PT forward pressure defect exceeds 1 Pa");
            return q;
        }
        case IF97::REGION_5: return gibbs(r5,5,T,p);
        default: throw std::domain_error("Ambiguous PT saturation pair needs explicit endpoint/inventory");
    }
}

// Chain rule of upstream Region4::T_p, using its own public coefficients/scales.
double saturation_slope(double p) {
    (void)r4.T_p(p);
    const auto& n=r4.n; const double beta=std::pow(p/r4.p_star,.25), db=beta/(4*p);
    const double E=beta*beta+n[3]*beta+n[6], F=n[1]*beta*beta+n[4]*beta+n[7];
    const double G=n[2]*beta*beta+n[5]*beta+n[8];
    const double dE=(2*beta+n[3])*db, dF=(2*n[1]*beta+n[4])*db;
    const double dG=(2*n[2]*beta+n[5])*db;
    const double root=std::sqrt(F*F-4*E*G);
    const double droot=(2*F*dF-4*(dE*G+E*dG))/(2*root);
    const double den=-F-root, D=2*G/den;
    const double dD=2*(dG*den-G*(-dF-droot))/(den*den);
    const double tail=std::sqrt((n[10]+D)*(n[10]+D)-4*(n[9]+n[10]*D));
    return r4.T_star*.5*dD*(1-(D-n[10])/tail);
}
State vapor(double T,double pv) {
    require(std::isfinite(pv)&&pv>0&&T>=IF97::Tmin&&T<=IF97::Text,"Invalid actual vapor PT");
    if(T<=IF97::Tcrit) require(pv<=r4.p_T(T),"Supersaturated vapor is not this active branch");
    if(pv<IF97::Pmin) {
        if(T<=IF97::Tmax) return gibbs(r2,2,T,pv);
        require(pv<=IF97::Pext,"Dilute R5 pressure beyond normative range");
        return gibbs(r5,5,T,pv);
    }
    const auto q=point(T,pv);
    require(q.region==2||q.region==3||q.region==5,"Actual gas queried a liquid branch");
    return q;
}
State liquid(double T,double p) {
    require(p>0&&p<IF97::Pcrit&&T<=r4.T_p(p),"Liquid left its stable subcritical branch");
    const auto q=point(T,p);
    require(q.region==1||q.region==3,"Actual liquid queried a gas branch"); return q;
}
State endpoint(double p,bool is_liquid) {
    require(p>=IF97::Pmin&&p<IF97::Pcrit,"Unsupported saturation endpoint domain");
    const double T=r4.T_p(p);
    if(T<=IF97::T23min) return is_liquid?gibbs(r1,1,T,p):gibbs(r2,2,T,p);
    auto q=dense(T,r3.output(IF97_DMASS,T,p,is_liquid?LIQUID:VAPOR));
    max_dense_endpoint_p_error=std::max(max_dense_endpoint_p_error,std::abs(q.p-p));
    require(std::abs(q.p-p)<=1,"Dense endpoint pressure defect exceeds local ceiling");
    return q;
}
`;
}

export const nativeIf97Primitives = nativeIf97Source(false);
