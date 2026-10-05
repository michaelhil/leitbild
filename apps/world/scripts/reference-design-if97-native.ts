/**
 * Bounded offline native property/phase admission, not an LD-01 runtime.
 * Input: one independently acquired official IF97.h + LICENSE at the pinned revision.
 * No network acquisition, dependency installation, trajectories or backend fallback.
 * Usage: bun apps/world/scripts/reference-design-if97-native.ts INPUT_DIRECTORY NEW_RECEIPT.json
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const revision = '0be7b51f35c47e59e6f91f4f0f47108bf997e50c';
const headerSha256 = '83693f044b271a6a28b97c06601287d023f94a75fac9723412661ebf3d3791a6';
const licenseSha256 = 'e22c3d30ef8d88ab468d9ea20392ca1df22fa3fd0a92dc3e996d89cf3cfdbd03';
const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const cpp = String.raw`// Offline property admission only. No trajectories, model installation or IF97 coefficients.
// Build against the independently acquired, pinned CoolProp/IF97 header and MIT notice.
#define REGION3_ITERATE
#include "IF97.h"
#include <array>
#include <chrono>
#include <limits>
#include <string>

using Clock = std::chrono::steady_clock;
static const auto started = Clock::now();
static int checks = 0;
static double max_fd_ratio = 0, max_identity = 0, max_det = 0, max_forward_p = 0;
static double max_sat_ratio = 0, max_clapeyron_difference = 0;
static double bench_ns = 0; static int bench_count = 0;
static double max_recovery_p = 0, cold_recovery_p = 0, low_head_recovery_p = 0;
static int phase_cases=0, dilute_cases=0, absent_cases=0;
static double max_phase_condition=0, max_phase_residual=0, max_phase_p_error=0;
static double max_phase_temperature_error=0, max_dense_endpoint_p_error=0;
static double max_phase_total_pressure_error=0;
static double max_centroid_identity=0, min_contact_latent_heat=1e300;
static int conversion_cases=0, birth_cases=0;
static double max_conversion_mass_error=0,max_conversion_energy_error=0,max_inactive_energy_error=0;
static double max_conversion_momentum_error=0,max_component_identity_error=0;
static double max_quadrature_pressure_difference=0,max_quadrature_temperature_difference=0,max_quadrature_mass_difference=0;
static double min_retained_opposite_margin=1e300,min_real_conversion=1e300;
static double born_steam_mass=0,born_liquid_mass=0,nc_born_steam_mass=0;

void require(bool ok, const std::string& message) {
    ++checks;
    if (std::chrono::duration<double>(Clock::now()-started).count() > 100)
        throw std::runtime_error("Native property execution exhausted its 100 s local guard");
    if (!ok) throw std::runtime_error(message);
}

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
    (void)r4.T_p(p); // Upstream range validation.
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

double relative(double a,double b) { return std::abs(a-b)/std::max(std::abs(b),1e-300); }
void increment(double derivative,double plus,double minus,double step,double absolute,const char* tag) {
    const double actual=(plus-minus)/2, predicted=derivative*step;
    const double ratio=std::abs(actual-predicted)/(absolute+1e-3*std::abs(predicted));
    max_fd_ratio=std::max(max_fd_ratio,ratio);
    require(std::isfinite(ratio)&&ratio<=1,std::string("Same-branch increment derivative failed: ")+tag);
}
double stored_E(const State& q, double V,double P,double Q,double z) {
    const double M=V*q.rho;
    return M*q.u+P*P/(2*M)+Q+M*9.80665*z;
}
void check_state(const State& q) {
    require(std::isfinite(q.rho)&&q.rho>0&&std::isfinite(q.u)&&std::isfinite(q.s)
        &&q.cp>0&&q.cv>0&&q.w>0&&q.kappa>0&&q.mu>0&&q.conductivity>0,
        "Invalid native single-phase tuple");
    const double id=relative(q.h-q.u,q.p/q.rho); max_identity=std::max(max_identity,id);
    require(id<=1e-9,"h=u+p/rho identity failed");
    const double ks=q.kappa-q.T*q.alpha*q.alpha/(q.rho*q.cp);
    require(ks>0,"Stable isentropic compressibility required");
    require(relative(ks,1/(q.rho*q.w*q.w))<=1e-8,"Sound/storage compressibility identity failed");
    const double up=(q.p*q.kappa-q.T*q.alpha)/q.rho, ut=q.cp-q.p*q.alpha/q.rho;
    const double M=.03*q.rho, P=1.2*M, z=5;
    const double common=q.u+9.80665*z-P*P/(2*M*M);
    const double Mp=M*q.kappa, Mt=-M*q.alpha;
    const double Ep=common*Mp+M*up, Et=common*Mt+M*ut;
    const double det=Mp*Et-Mt*Ep, expected=M*M*q.cp*ks;
    max_det=std::max(max_det,relative(det,expected));
    require(det>0&&relative(det,expected)<=1e-8,"Conservative native storage determinant identity failed");
    for(double half:{1.,.5}) {
        if(q.region==3) {
            const double dr=q.rho*1e-5*half, dt=2e-5*half;
            auto rp=dense(q.T,q.rho+dr),rm=dense(q.T,q.rho-dr);
            auto tp=dense(q.T+dt,q.rho),tm=dense(q.T-dt,q.rho);
            require(rp.kappa>0&&rm.kappa>0&&tp.kappa>0&&tm.kappa>0,"Region3 probe crossed stable branch");
            increment(1/(q.rho*q.kappa),rp.p,rm.p,dr,1e-5,"R3 p_rho");
            increment(q.alpha/q.kappa,tp.p,tm.p,dt,1e-5,"R3 p_T");
            increment((q.p-q.T*q.alpha/q.kappa)/(q.rho*q.rho),rp.u,rm.u,dr,1e-4,"R3 u_rho");
            increment(q.cv,tp.u,tm.u,dt,1e-4,"R3 u_T");
            increment(.03*common+M*(q.p-q.T*q.alpha/q.kappa)/(q.rho*q.rho),
                stored_E(rp,.03,P,2,z),stored_E(rm,.03,P,2,z),dr,1e-3,"R3 E_rho");
            increment(M*q.cv,stored_E(tp,.03,P,2,z),stored_E(tm,.03,P,2,z),dt,1e-3,"R3 E_T");
        } else {
            const double dp=std::max(.1,q.p*1e-5)*half,dt=2e-4*half;
            auto pp=point(q.T,q.p+dp),pm=point(q.T,q.p-dp);
            auto tp=point(q.T+dt,q.p),tm=point(q.T-dt,q.p);
            require(pp.region==q.region&&pm.region==q.region&&tp.region==q.region&&tm.region==q.region,
                "Finite-difference probe crossed region boundary");
            increment(q.rho*q.kappa,pp.rho,pm.rho,dp,1e-9,"rho_p");
            increment(-q.rho*q.alpha,tp.rho,tm.rho,dt,1e-9,"rho_T");
            increment(up,pp.u,pm.u,dp,1e-4,"u_p");
            increment(ut,tp.u,tm.u,dt,1e-4,"u_T");
            increment(Mp,.03*pp.rho,.03*pm.rho,dp,1e-9,"M_p");
            increment(Mt,.03*tp.rho,.03*tm.rho,dt,1e-9,"M_T");
            increment(Ep,stored_E(pp,.03,P,2,z),stored_E(pm,.03,P,2,z),dp,1e-3,"E_p");
            increment(Et,stored_E(tp,.03,P,2,z),stored_E(tm,.03,P,2,z),dt,1e-3,"E_T");
        }
    }
}
void recover(const State& target) {
    double T=target.T+.02,p=target.p*(1+1e-4);
    bool solved=false;
    for(int iteration=0;iteration<16;++iteration) {
        const auto q=target.region==3?dense(T,target.rho):point(T,p);
        require(q.region==target.region&&q.kappa>0&&q.cp>0,"Local recovery left its admitted branch");
        const double ru=q.u-target.u, rr=q.rho-target.rho;
        if(std::abs(ru)<=1e-7+1e-11*std::abs(target.u)&&relative(q.rho,target.rho)<=1e-12) {
            const double pe=std::abs(q.p-target.p); max_recovery_p=std::max(max_recovery_p,pe);
            if(target.T==313.15&&target.p==15.2e6) cold_recovery_p=pe;
            if(target.T==290&&target.p==101325) low_head_recovery_p=pe;
            require(std::abs(q.T-target.T)<=1e-5&&std::abs(q.p-target.p)<=1,"Known-branch recovery PT error");
            solved=true; break;
        }
        if(target.region==3) T-=ru/q.cv;
        else {
            const double rp=q.rho*q.kappa,rt=-q.rho*q.alpha;
            const double up=(q.p*q.kappa-q.T*q.alpha)/q.rho,ut=q.cp-q.p*q.alpha/q.rho;
            const double d=rp*ut-rt*up;
            require(d>0,"Local recovery lost storage invertibility");
            p-=(rr*ut-rt*ru)/d; T-=(rp*ru-rr*up)/d;
        }
    }
    require(solved,"Known-branch local recovery did not converge");
}

// Finite local storage checks. These are not a global flash or an advancing plant.
struct NC { double air,nitrogen;
    double mass() const {return air+nitrogen;}
    double S() const {return air*287+nitrogen*296.8;}
    double C() const {return air*718+nitrogen*742;}
};
NC gas_stock(double S,double air_fraction) {
    const double mass=S/(air_fraction*287+(1-air_fraction)*296.8);
    return {mass*air_fraction,mass*(1-air_fraction)};
}
State vapor(double T,double pv) {
    require(std::isfinite(pv)&&pv>0&&T>=IF97::Tmin&&T<=IF97::Text,"Invalid actual vapor PT");
    if(T<=IF97::Tcrit) require(pv<=r4.p_T(T),"Supersaturated vapor is not this active branch");
    if(pv<IF97::Pmin) {
        // Normative IF97 Eq15/16 and Eq32 domains include positive dilute pressures.
        // The upstream blanket PT dispatch lower bound is not a vapor lower bound.
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
template<size_t N> struct Map { std::array<double,N> value{}; std::array<std::array<double,N>,N> J{};double pressure=0; };
template<size_t N> std::array<double,N> linear(std::array<std::array<double,N>,N> A,std::array<double,N> b) {
    for(size_t k=0;k<N;++k) {
        size_t pivot=k;for(size_t i=k+1;i<N;++i) if(std::abs(A[i][k])>std::abs(A[pivot][k]))pivot=i;
        require(std::isfinite(A[pivot][k])&&A[pivot][k]!=0,"Singular active native storage map");
        std::swap(A[pivot],A[k]);std::swap(b[pivot],b[k]);
        for(size_t i=k+1;i<N;++i){const double f=A[i][k]/A[k][k];for(size_t j=k;j<N;++j)A[i][j]-=f*A[k][j];b[i]-=f*b[k];}
    }
    std::array<double,N> x{};
    for(size_t ii=N;ii>0;--ii){const size_t i=ii-1;double v=b[i];for(size_t j=i+1;j<N;++j)v-=A[i][j]*x[j];x[i]=v/A[i][i];}
    return x;
}
template<size_t N,class Eval> void native_map_check(Eval evaluate,std::array<double,N> x,
    std::array<double,N> increments,std::array<double,N> absolute,std::array<double,N> output_scales,
    std::array<char,N> roles,const char* name) {
    const auto original=evaluate(x); ++phase_cases;
    std::array<double,N> xs{};for(size_t i=0;i<N;++i)xs[i]=std::abs(x[i]);
    std::array<std::array<double,N>,N> A{};double norm=0;
    for(size_t i=0;i<N;++i){double row=0;for(size_t j=0;j<N;++j){A[i][j]=original.J[i][j]*xs[j]/output_scales[i];row+=std::abs(A[i][j]);}norm=std::max(norm,row);}
    std::array<std::array<double,N>,N> inv{};
    for(size_t j=0;j<N;++j){std::array<double,N>b{};b[j]=1;const auto col=linear(A,b);for(size_t i=0;i<N;++i)inv[i][j]=col[i];}
    double invnorm=0;for(const auto& row:inv){double sum=0;for(double value:row)sum+=std::abs(value);invnorm=std::max(invnorm,sum);}
    require(std::isfinite(norm*invnorm),std::string("Nonfinite condition estimate: ")+name);
    max_phase_condition=std::max(max_phase_condition,norm*invnorm);
    for(size_t j=0;j<N;++j)for(double half:{1.,.5}) {
        auto plus=x,minus=x;const double h=increments[j]*half;plus[j]+=h;minus[j]-=h;
        const auto p=evaluate(plus),m=evaluate(minus);
        for(size_t i=0;i<N;++i)increment(original.J[i][j],p.value[i],m.value[i],h,absolute[i],name);
    }
    auto trial=x;for(size_t j=0;j<N;++j)trial[j]+=increments[j]*.1;
    bool solved=false;
    for(int k=0;k<12;++k) {
        const auto current=evaluate(trial);std::array<double,N> residual{};double worst=0;
        for(size_t i=0;i<N;++i){residual[i]=(current.value[i]-original.value[i])/output_scales[i];worst=std::max(worst,std::abs(residual[i]));}
        if(worst<=1e-12){max_phase_residual=std::max(max_phase_residual,worst);solved=true;break;}
        for(size_t i=0;i<N;++i)for(size_t j=0;j<N;++j)A[i][j]=current.J[i][j]*xs[j]/output_scales[i];
        const auto correction=linear(A,residual);for(size_t j=0;j<N;++j)trial[j]-=xs[j]*correction[j];
    }
    require(solved,std::string("Known active native recovery failed: ")+name);
    for(size_t j=0;j<N;++j)require(std::abs(trial[j]-x[j])<=1e-7*xs[j]+1e-8,"Local state reconstruction error");
    for(size_t j=0;j<N;++j){if(roles[j]=='p')max_phase_p_error=std::max(max_phase_p_error,std::abs(trial[j]-x[j]));
        if(roles[j]=='T')max_phase_temperature_error=std::max(max_phase_temperature_error,std::abs(trial[j]-x[j]));}
    max_phase_total_pressure_error=std::max(max_phase_total_pressure_error,std::abs(evaluate(trial).pressure-original.pressure));
    require(max_phase_p_error<=1&&max_phase_temperature_error<=1e-5,"Phasic recovery pressure/temperature ceiling");
    require(max_phase_total_pressure_error<=1,"Total phase pressure recovery ceiling");
}
struct Geometry { double V,z,H;bool cut;
    double zl(double Vg)const{return cut?z+(V-Vg)*H/(2*V):z+H/2;}
    double zg(double Vg)const{return cut?z+H-Vg*H/(2*V):z+H/2;}
    double dz()const{return cut?-H/(2*V):0;}
};
struct Phase { Geometry geometry;NC nc;double Pl,Pg,Q; };
Map<4> phasic_states(std::array<double,4> x,const Phase& c,const State& l,const State& v) {
    const double pv=x[0],Tl=x[1],Tg=x[2],Vg=x[3],V=c.geometry.V;
    require(Vg>0&&Vg<V,"Positive disjoint phase volumes required");
    const double p=pv+c.nc.S()*Tg/Vg;
    const double Ml=l.rho*(V-Vg),Mv=v.rho*Vg,Mg=Mv+c.nc.mass();
    const double zl=c.geometry.zl(Vg),zg=c.geometry.zg(Vg),g=9.80665;
    const double Kl=c.Pl*c.Pl/(2*Ml),Kg=c.Pg*c.Pg/(2*Mg);
    Map<4> out;out.pressure=p;out.value={Ml,Mv,Ml*l.u+Kl+c.Q+Ml*g*zl,
        Mv*v.u+c.nc.C()*(Tg-298.15)+Kg+Mg*g*zg};
    const double lup=(p*l.kappa-Tl*l.alpha)/l.rho,lut=l.cp-p*l.alpha/l.rho;
    const double vup=(pv*v.kappa-Tg*v.alpha)/v.rho,vut=v.cp-pv*v.alpha/v.rho;
    const std::array<double,4> dp{{1,0,c.nc.S()/Vg,-c.nc.S()*Tg/(Vg*Vg)}};
    for(size_t j=0;j<4;++j) {
        const double dMl=Ml*l.kappa*dp[j]-(j==1?Ml*l.alpha:0)-(j==3?l.rho:0);
        const double dMv=(j==0?Mv*v.kappa:0)-(j==2?Mv*v.alpha:0)+(j==3?v.rho:0);
        out.J[0][j]=dMl;out.J[1][j]=dMv;
        out.J[2][j]=(l.u-Kl/Ml+g*zl)*dMl+Ml*(lup*dp[j]+(j==1?lut:0))+(j==3?Ml*g*c.geometry.dz():0);
        out.J[3][j]=(v.u-Kg/Mg+g*zg)*dMv+Mv*((j==0?vup:0)+(j==2?vut:0))
            +(j==2?c.nc.C():0)+(j==3?Mg*g*c.geometry.dz():0);
    }return out;
}
Map<4> phasic(std::array<double,4> x,const Phase& c) {
    const double p=x[0]+c.nc.S()*x[2]/x[3];
    return phasic_states(x,c,liquid(x[1],p),vapor(x[2],x[0]));
}
Map<2> hem(std::array<double,2> x,Geometry geometry,NC nc,double P) {
    const double T=x[0],Vg=x[1],V=geometry.V;require(Vg>0&&Vg<V,"Wet HEM volumes required");
    const double ps=r4.p_T(T),sp=1/saturation_slope(ps),p=ps+nc.S()*T/Vg;
    const auto l=nc.mass()==0?endpoint(ps,true):liquid(T,p),v=endpoint(ps,false);
    const double Ml=l.rho*(V-Vg),Mv=v.rho*Vg,M=Ml+Mv,Mtotal=M+nc.mass();
    const double K=P*P/(2*Mtotal),z=geometry.z+geometry.H/2,g=9.80665;
    Map<2> out;out.pressure=p;out.value={M,Ml*l.u+Mv*v.u+nc.C()*(T-298.15)+K+Mtotal*g*z};
    const double lup=(p*l.kappa-T*l.alpha)/l.rho,lut=l.cp-p*l.alpha/l.rho;
    const double vup=(ps*v.kappa-T*v.alpha)/v.rho,vut=v.cp-ps*v.alpha/v.rho;
    for(size_t j=0;j<2;++j){const double dp=j==0?sp+nc.S()/Vg:-nc.S()*T/(Vg*Vg);
        const double dMl=Ml*l.kappa*dp-(j==0?Ml*l.alpha:0)-(j==1?l.rho:0);
        const double dMv=j==0?Mv*(v.kappa*sp-v.alpha):v.rho;
        out.J[0][j]=dMl+dMv;
        out.J[1][j]=l.u*dMl+Ml*(lup*dp+(j==0?lut:0))+v.u*dMv
            +(j==0?Mv*(vup*sp+vut)+nc.C():0)+(g*z-K/Mtotal)*(dMl+dMv);
    }return out;
}
Map<2> dry_gas(std::array<double,2>x,Geometry geometry,NC nc,double P) {
    const double pv=x[0],T=x[1];const auto v=vapor(T,pv);
    const double Mv=v.rho*geometry.V,Mg=Mv+nc.mass(),K=P*P/(2*Mg),gz=9.80665*(geometry.z+geometry.H/2);
    Map<2> out;out.pressure=pv+nc.S()*T/geometry.V;out.value={Mv,Mv*v.u+nc.C()*(T-298.15)+K+Mg*gz};
    const double up=(pv*v.kappa-T*v.alpha)/v.rho,ut=v.cp-pv*v.alpha/v.rho;
    out.J[0]={Mv*v.kappa,-Mv*v.alpha};
    for(size_t j=0;j<2;++j)out.J[1][j]=(v.u-K/Mg+gz)*out.J[0][j]+Mv*(j==0?up:ut)+(j==1?nc.C():0);
    return out;
}
Map<3> steam_free(std::array<double,3>x,const Phase& c) {
    const double Tl=x[0],Tg=x[1],Vg=x[2],V=c.geometry.V;
    require(c.nc.mass()>0&&Vg>0&&Vg<V,"Steam-free gas requires actual NC and disjoint volumes");
    const double p=c.nc.S()*Tg/Vg;const auto l=liquid(Tl,p); // No water-vapor query or dewpoint.
    const double Ml=l.rho*(V-Vg),Mg=c.nc.mass(),Kl=c.Pl*c.Pl/(2*Ml),Kg=c.Pg*c.Pg/(2*Mg);
    const double g=9.80665,zl=c.geometry.zl(Vg),zg=c.geometry.zg(Vg);
    Map<3> out;out.pressure=p;out.value={Ml,Ml*l.u+Kl+c.Q+Ml*g*zl,c.nc.C()*(Tg-298.15)+Kg+Mg*g*zg};
    const double up=(p*l.kappa-Tl*l.alpha)/l.rho,ut=l.cp-p*l.alpha/l.rho;
    const std::array<double,3> dp{{0,c.nc.S()/Vg,-c.nc.S()*Tg/(Vg*Vg)}};
    for(size_t j=0;j<3;++j){const double dMl=Ml*l.kappa*dp[j]-(j==0?Ml*l.alpha:0)-(j==2?l.rho:0);
        out.J[0][j]=dMl;out.J[1][j]=(l.u-Kl/Ml+g*zl)*dMl+Ml*(up*dp[j]+(j==0?ut:0))+(j==2?Ml*g*c.geometry.dz():0);
        out.J[2][j]=(j==1?c.nc.C():0)+(j==2?Mg*g*c.geometry.dz():0);
    }return out;
}
Map<3> both_active(std::array<double,3>x,const Phase& c) {
    const double p=x[0],pv=x[1],Vg=x[2],V=c.geometry.V;
    require(Vg>0&&Vg<V,"Both-active positive phase volume required");
    const auto l=endpoint(p,true),v=endpoint(pv,false);const double Tl=l.T,Tg=v.T;
    const double Ml=l.rho*(V-Vg),Mv=v.rho*Vg,Mg=Mv+c.nc.mass();
    const double Kl=c.Pl*c.Pl/(2*Ml),Kg=c.Pg*c.Pg/(2*Mg),g=9.80665;
    const double zl=c.geometry.zl(Vg),zg=c.geometry.zg(Vg);
    Map<3> out;out.pressure=p;out.value={Ml+Mv,Ml*l.u+Mv*v.u+c.nc.C()*(Tg-298.15)+Kl+Kg+c.Q+g*(Ml*zl+Mg*zg),
        p-pv-c.nc.S()*Tg/Vg};
    const double sl=saturation_slope(p),sv=saturation_slope(pv);
    const double l_r=l.rho*(l.kappa-l.alpha*sl),v_r=v.rho*(v.kappa-v.alpha*sv);
    const double l_u=(p*l.kappa-Tl*l.alpha)/l.rho+(l.cp-p*l.alpha/l.rho)*sl;
    const double v_u=(pv*v.kappa-Tg*v.alpha)/v.rho+(v.cp-pv*v.alpha/v.rho)*sv;
    for(size_t j=0;j<3;++j){const double dMl=j==0?(V-Vg)*l_r:j==2?-l.rho:0;
        const double dMv=j==1?Vg*v_r:j==2?v.rho:0;
        out.J[0][j]=dMl+dMv;
        out.J[1][j]=(l.u-Kl/Ml+g*zl)*dMl+(v.u-Kg/Mg+g*zg)*dMv
            +(j==0?Ml*l_u:0)+(j==1?Mv*v_u+c.nc.C()*sv:0)+(j==2?g*(Ml+Mg)*c.geometry.dz():0);
    }out.J[2]={1,-1-c.nc.S()*sv/Vg,c.nc.S()*Tg/(Vg*Vg)};return out;
}
void absent_phase(double mass,double P,double Q,double thermal_energy) {
    require(mass>=0&&std::isfinite(mass),"Invalid phase amount");
    if(mass==0)require(P==0&&Q==0&&thermal_energy==0,"Absent phase retains energy/momentum");
    // This validation returns no temperature and never performs a property lookup.
}
void phase_checks() {
    const Geometry uniform{.01,4,1,false},cut{.01,4,1,true};
    for(double ps:{.1e6,1e6,16e6})for(int kind=0;kind<4;++kind) {
        const double T=r4.T_p(ps),fraction=kind==0?0:.1,alpha=kind==1?.1:kind==2?.9:.5,Vg=alpha*uniform.V;
        const auto nc=kind==0?NC{0,0}:gas_stock(ps*fraction/(1-fraction)*Vg/T,kind==1?1:kind==2?0:.5);
        const auto f=[&](std::array<double,2>x){return hem(x,uniform,nc,3);};const auto q=f({T,Vg});
        native_map_check<2>(f,{T,Vg},{2e-4,Vg*1e-6},{1e-9,1e-3},{q.value[0],std::max(std::abs(q.value[1]),1.)},{'T','V'},"HEM M/E");
    }
    for(double fraction:{1e-8,.5}) {
        const double T=r4.T_p(1e6),Vg=.005;const auto nc=gas_stock(1e6*fraction/(1-fraction)*Vg/T,.5);
        const auto f=[&](std::array<double,2>x){return hem(x,uniform,nc,3);};const auto q=f({T,Vg});
        native_map_check<2>(f,{T,Vg},{2e-4,Vg*1e-6},{1e-9,1e-3},{q.value[0],std::abs(q.value[1])},{'T','V'},"Near-pure NC HEM");
    }
    for(double alpha:{1e-6,1-1e-6}) {
        const double T=r4.T_p(1e6),Vg=alpha*uniform.V;const auto f=[&](std::array<double,2>x){return hem(x,uniform,{0,0},3);};const auto q=f({T,Vg});
        native_map_check<2>(f,{T,Vg},{2e-4,std::min(Vg,uniform.V-Vg)*1e-5},{1e-9,1e-3},{q.value[0],std::abs(q.value[1])},{'T','V'},"Near-phase HEM");
    }
    for(int kind=0;kind<7;++kind) {
        const double p=kind==6?20e6:kind==0?1e6:kind==5?1e6:5e6;
        const double pv=kind==0?p:kind==4?p*(1-1e-8):kind==5?1:p*.7;
        const double Tl=kind==5?290:r4.T_p(p)-(kind==6?2:25),Tg=kind==5?450:r4.T_p(pv)+30,Vg=.004;
        const auto nc=kind==0?NC{0,0}:gas_stock((p-pv)*Vg/Tg,kind==1?1:kind==2?0:.5);
        const Phase c{kind==3?cut:uniform,nc,2,.1,5};
        const auto f=[&](std::array<double,4>x){return phasic(x,c);};const auto q=f({pv,Tl,Tg,Vg});
        native_map_check<4>(f,{pv,Tl,Tg,Vg},{pv*1e-6,2e-4,2e-4,Vg*1e-6},
            {1e-9,1e-12,1e-3,1e-4},{q.value[0],q.value[1],std::max(std::abs(q.value[2]),1.),std::max(std::abs(q.value[3]),1.)},{'p','T','T','V'},"Two-energy native phase map");
        if(kind==5)++dilute_cases;
    }
    for(double Tg:{450.,1500.}) {
        const auto nc=gas_stock(1e6*uniform.V/Tg,.5);const auto f=[&](std::array<double,2>x){return dry_gas(x,uniform,nc,.1);};const auto q=f({1,Tg});
        native_map_check<2>(f,{1,Tg},{1e-5,2e-4},{1e-12,1e-4},{q.value[0],std::max(std::abs(q.value[1]),1.)},{'p','T'},"Dilute steam and NC gas-only");++dilute_cases;
    }
    for(int kind=0;kind<3;++kind) {
        const double Tl=290,Tg=500,Vg=.004;const Phase c{kind==2?cut:uniform,gas_stock(1e6*Vg/Tg,kind==0?1:kind==1?0:.5),2,.1,5};
        const auto f=[&](std::array<double,3>x){return steam_free(x,c);};const auto q=f({Tl,Tg,Vg});
        native_map_check<3>(f,{Tl,Tg,Vg},{2e-4,2e-4,Vg*1e-6},{1e-9,1e-3,1e-4},
            {q.value[0],std::max(std::abs(q.value[1]),1.),std::max(std::abs(q.value[2]),1.)},{'T','T','V'},"Exactly steam-free NC phase");++absent_cases;
    }
    for(int kind=0;kind<3;++kind) {
        const double p=kind==2?16e6:1e6,pv=p*.8,Vg=.004,Tg=r4.T_p(pv);
        const Phase c{kind==2?cut:uniform,gas_stock((p-pv)*Vg/Tg,kind==0?1:kind==1?0:.5),2,.1,5};
        const auto f=[&](std::array<double,3>x){return both_active(x,c);};const auto q=f({p,pv,Vg});
        require(std::abs(q.value[2])<=1e-8*p&&r4.T_p(p)>Tg,"Dual-boundary fixture lost distinct temperatures/mechanical closure");
        native_map_check<3>(f,{p,pv,Vg},{p*1e-6,pv*1e-6,Vg*1e-6},{1e-9,1e-3,1e-5},
            {q.value[0],std::abs(q.value[1]),p},{'p','p','V'},"Both-active NC endpoint");
    }
    for(double p:{18e6,20e6,21e6}) {
        const auto l=endpoint(p,true),v=endpoint(p,false);
        require(l.rho>v.rho&&l.kappa>0&&v.kappa>0&&l.cp>0&&v.cp>0&&v.h>l.h,"Dense saturation branches not distinct/stable");
        min_contact_latent_heat=std::min(min_contact_latent_heat,v.h-l.h);
        for(bool is_liquid:{true,false})for(double half:{1.,.5}) {
            const auto q=is_liquid?l:v;const double dp=p*1e-6*half,dt=1e-5*half;
            const double sign=is_liquid?1:-1;
            const auto pp=dense(q.T,r3.output(IF97_DMASS,q.T,p+sign*dp,is_liquid?LIQUID:VAPOR));
            const auto tt=dense(q.T-sign*dt,r3.output(IF97_DMASS,q.T-sign*dt,p,is_liquid?LIQUID:VAPOR));
            require(pp.kappa>0&&tt.kappa>0,"Dense one-sided probe lost stability");
            increment(q.rho*q.kappa,q.rho+2*(pp.rho-q.rho),q.rho,sign*dp,1e-8,"Dense endpoint one-sided rho_p");
            increment(-q.rho*q.alpha,q.rho+2*(tt.rho-q.rho),q.rho,-sign*dt,1e-8,"Dense endpoint one-sided rho_T");
            const auto ep=endpoint(p+dp,is_liquid),em=endpoint(p-dp,is_liquid);
            increment(q.rho*(q.kappa-q.alpha*saturation_slope(p)),ep.rho,em.rho,dp,1e-8,"Dense endpoint saturation tangent");
        }++phase_cases;
    }
    // Exact absent/NC-only owners: no water query, no phantom T, no energy positivity floor.
    absent_phase(0,0,0,0);++absent_cases;
    for(int item=0;item<3;++item){bool rejected=false;try{absent_phase(0,item==0?1:0,item==1?1:0,item==2?1:0);}catch(const std::exception&){rejected=true;}require(rejected,"Absent phase contradiction admitted");++absent_cases;}
    for(double T:{280.,298.15,500.}) {
        const auto nc=gas_stock(1e6*uniform.V/T,.5);const double U=nc.C()*(T-298.15);
        const double recovered=298.15+U/nc.C(),p=nc.S()*recovered/uniform.V;
        require(std::abs(recovered-T)<=1e-10&&std::abs(p-1e6)<=1e-8,"NC-only datum/native recovery failed");
        if(T<298.15)require(U<0,"NC caloric reference was incorrectly floored");++absent_cases;
    }
    bool rejected=false;try{(void)vapor(250,1);}catch(const std::exception&){rejected=true;}require(rejected,"Out-of-domain dilute steam admitted");
    rejected=false;try{(void)vapor(2400,1);}catch(const std::exception&){rejected=true;}require(rejected,"Out-of-domain dilute hot steam admitted");
    const double Vg=.004,Vl=cut.V-Vg;
    max_centroid_identity=std::abs(Vl*cut.zl(Vg)+Vg*cut.zg(Vg)-cut.V*(cut.z+cut.H/2));
    require(max_centroid_identity<=1e-14,"Complementary cut phase first moments failed");
}

struct AcceptedPhase {std::array<double,4>x;Phase c;Map<4> native;};
struct ActiveEvaluation {Map<3> residual;AcceptedPhase state;double dm,ud,kd,h,pbar;};
ActiveEvaluation active_evaluate(std::array<double,3> y,const AcceptedPhase& old,bool liquid_active,double heat) {
    const auto& nc=old.c.nc;const double pv=y[0],otherT=y[1],Vg=y[2];
    const double Tg=liquid_active?otherT:r4.T_p(pv);
    const double p=pv+nc.S()*Tg/Vg,Tl=liquid_active?r4.T_p(p):otherT;
    const std::array<double,4>x{{pv,Tl,Tg,Vg}};
    const auto l=liquid_active?endpoint(p,true):liquid(Tl,p);
    const auto v=liquid_active?vapor(Tg,pv):endpoint(pv,false);
    const double Mv=v.rho*Vg,dm=Mv-old.native.value[1];
    // The declared evaporation/condensation branch fixes the one-sided origin Jacobian.
    // Final signed complementarity is checked; an unaccepted Newton trial is not a donor switch.
    const bool evaporation=liquid_active;const double Ml0=old.native.value[0],Mg0=old.native.value[1]+nc.mass();
    const double ud=evaporation?old.c.Pl/Ml0:old.c.Pg/Mg0,kd=evaporation?old.c.Q/Ml0:0;
    auto c=old.c;c.Pl-=dm*ud;c.Pg+=dm*ud;c.Q-=dm*kd;
    require(c.Q>=0,"Liquid donor Q exhausted before one-active endpoint");
    auto native=phasic_states(x,c,l,v);
    const double pbar=(old.native.pressure+p)/2,pvbar=(old.x[0]+pv)/2;
    const auto interface_state=liquid_active?endpoint(pbar,false):
        nc.mass()==0?endpoint(pbar,true):liquid(r4.T_p(pvbar),pbar);
    const double h=interface_state.h,gz=9.80665*(c.geometry.z+c.geometry.H/2);
    const double carried_h=dm*h,carried_K=dm*ud*ud/2,carried_Q=dm*kd,carried_PE=dm*gz;
    const double payload=carried_h+carried_K+carried_Q+carried_PE;
    const double changeV=Vg-old.x[3],work=pbar*changeV;
    Map<3> residual;residual.pressure=p;
    residual.value={native.value[0]+native.value[1]-Ml0-old.native.value[1],
        native.value[2]+native.value[3]-old.native.value[2]-old.native.value[3]-heat,
        liquid_active?native.value[3]-old.native.value[3]-payload+work:
            native.value[2]-old.native.value[2]+payload-work};
    // Chain native analytic storage through the actual active temperature constraint.
    std::array<std::array<double,3>,4>C{};C[0]={1,0,0};C[3]={0,0,1};
    std::array<double,3> dp{};
    if(liquid_active){C[2]={0,1,0};dp={1,nc.S()/Vg,-nc.S()*Tg/(Vg*Vg)};
        for(size_t j=0;j<3;++j)C[1][j]=saturation_slope(p)*dp[j];}
    else{C[1]={0,1,0};C[2]={saturation_slope(pv),0,0};dp={1+nc.S()*C[2][0]/Vg,0,-nc.S()*Tg/(Vg*Vg)};}
    for(size_t j=0;j<3;++j){std::array<double,4> D{};
        for(size_t i=0;i<4;++i)for(size_t k=0;k<4;++k)D[i]+=native.J[i][k]*C[k][j];
        const double dMv=D[1],ul=c.Pl/native.value[0],ug=c.Pg/(native.value[1]+nc.mass());
        D[2]+=(-ud*ul-kd)*dMv;D[3]+=ud*ug*dMv;
        const double hp=(1-interface_state.T*interface_state.alpha)/interface_state.rho;
        const double dh=liquid_active?.5*(hp+interface_state.cp*saturation_slope(pbar))*dp[j]:
            .5*hp*dp[j]+.5*interface_state.cp*saturation_slope(pvbar)*(j==0?1:0);
        const double dPayload=dMv*(h+ud*ud/2+kd+gz)+dm*dh;
        const double dWork=.5*dp[j]*changeV+(j==2?pbar:0);
        residual.J[0][j]=D[0]+D[1];residual.J[1][j]=D[2]+D[3];
        residual.J[2][j]=liquid_active?D[3]-dPayload+dWork:D[2]+dPayload-dWork;
    }return {residual,{x,c,native},dm,ud,kd,h,pbar};
}
void component(double actual,double expected,const char* name) {
    const double error=std::abs(actual-expected);max_component_identity_error=std::max(max_component_identity_error,error);
    require(error<=1e-10+1e-10*std::abs(expected),std::string("Conversion component identity: ")+name);
}
void verify_conversion(const AcceptedPhase& old,const ActiveEvaluation& end,bool liquid_active,double heat) {
    const auto& s=end.state;const double dm=end.dm,Ml=s.native.value[0],Mg=s.native.value[1]+s.c.nc.mass();
    const double Ml0=old.native.value[0],Mg0=old.native.value[1]+old.c.nc.mass();
    const double mass=std::abs(end.residual.value[0]),energy=std::abs(end.residual.value[1]),inactive=std::abs(end.residual.value[2]);
    max_conversion_mass_error=std::max(max_conversion_mass_error,mass);max_conversion_energy_error=std::max(max_conversion_energy_error,energy);
    max_inactive_energy_error=std::max(max_inactive_energy_error,inactive);
    const double momentum=std::abs(s.c.Pl+s.c.Pg-old.c.Pl-old.c.Pg);
    max_conversion_momentum_error=std::max(max_conversion_momentum_error,momentum);
    require(mass<=1e-10&&energy<=1e-5&&inactive<=1e-5&&momentum<=1e-10,"Native conversion conservation/work screen");
    require(liquid_active?dm>0:dm<0,"External fixture source did not produce the declared signed conversion");
    min_real_conversion=std::min(min_real_conversion,std::abs(dm));
    if(liquid_active&&s.x[0]<IF97::Pmin) {
        // Actual dilute steam is stable here; the saturation inverse is not defined.
        require(s.x[2]>IF97::Tmin,"Dilute opposing steam left its admitted temperature domain");
        if(s.x[2]<=IF97::Tcrit)require(s.x[0]<r4.p_T(s.x[2]),"Dilute opposing steam lost its stable branch");
    } else {
        const double margin=liquid_active?s.x[2]-r4.T_p(s.x[0]):r4.T_p(s.native.pressure)-s.x[1];
        require(margin>0,"Opposite phase reached its own boundary; one-active comparison stops");
        min_retained_opposite_margin=std::min(min_retained_opposite_margin,margin);
    }
    component(s.c.Pl-old.c.Pl,-dm*end.ud,"liquid momentum");component(s.c.Pg-old.c.Pg,dm*end.ud,"gas momentum");
    component(s.c.Q-old.c.Q,-dm*end.kd,"carried liquid Q");
    const double receiverM=dm>0?Mg0:Ml0,receiverU=dm>0?old.c.Pg/Mg0:old.c.Pl/Ml0,amount=std::abs(dm);
    const double mixloss=.5*receiverM*amount/(receiverM+amount)*(end.ud-receiverU)*(end.ud-receiverU);
    const double K0=old.c.Pl*old.c.Pl/(2*Ml0)+old.c.Pg*old.c.Pg/(2*Mg0);
    const double K1=s.c.Pl*s.c.Pl/(2*Ml)+s.c.Pg*s.c.Pg/(2*Mg);
    component(K0-K1,mixloss,"native momentum-mixing kinetic loss");
    const double z=old.c.geometry.z+old.c.geometry.H/2,gz=9.80665*z;
    component((s.native.value[1]-old.native.value[1])*gz,dm*gz,"converted gas PE");
    component((Ml-Ml0)*gz,-dm*gz,"converted liquid PE");
    // Independent component receipts make wrong-zero/double-count visible below native E's offset.
    require(std::abs(dm*end.ud*end.ud/2)>1e-10&&std::abs(dm*gz)>1e-10,"Kinetic/PE receipt too small to discriminate wrong zero");
    if(dm>0)require(std::abs(dm*end.kd)>1e-10,"Q receipt too small to discriminate wrong zero");
    const double Wg=end.pbar*(s.x[3]-old.x[3]),Wl=end.pbar*((s.c.geometry.V-s.x[3])-(old.c.geometry.V-old.x[3]));
    component(Wg+Wl,0,"reciprocal phase volume work");(void)heat;
}
ActiveEvaluation advance_active(const AcceptedPhase& old,bool liquid_active,double heat) {
    std::array<double,3> y{{old.x[0]>0?old.x[0]:10,liquid_active?old.x[2]:old.x[1],old.x[3]}};
    const std::array<double,3> xs{{std::max(y[0],10.),y[1],y[2]}};
    const std::array<double,3> rs{{old.native.value[0]+old.native.value[1],
        std::max(std::abs(old.native.value[2])+std::abs(old.native.value[3]),1.),
        std::max(std::abs(liquid_active?old.native.value[3]:old.native.value[2]),1.)}};
    for(int k=0;k<16;++k){auto q=active_evaluate(y,old,liquid_active,heat);
        double norm=0;for(size_t i=0;i<3;++i)norm=std::max(norm,std::abs(q.residual.value[i])/rs[i]);
        if(norm<=1e-12&&std::abs(q.residual.value[0])<=1e-10&&std::abs(q.residual.value[1])<=1e-5&&std::abs(q.residual.value[2])<=1e-5) {
            for(size_t j=0;j<3;++j)for(double half:{1.,.5}) {
                const double h=(j==0?y[0]*1e-6:j==1?2e-4:y[2]*1e-6)*half;
                auto plus=y,minus=y;plus[j]+=h;minus[j]-=h;
                const auto a=active_evaluate(plus,old,liquid_active,heat),b=active_evaluate(minus,old,liquid_active,heat);
                for(size_t i=0;i<3;++i)increment(q.residual.J[i][j],a.residual.value[i],b.residual.value[i],h,i==0?1e-9:1e-3,"Active native/work residual Jacobian");
            }
            verify_conversion(old,q,liquid_active,heat);return q;
        }
        std::array<std::array<double,3>,3>A{};std::array<double,3>b{};
        for(size_t i=0;i<3;++i){b[i]=q.residual.value[i]/rs[i];for(size_t j=0;j<3;++j)A[i][j]=q.residual.J[i][j]*xs[j]/rs[i];}
        const auto change=linear(A,b);double fraction=1;std::array<double,3> next{};
        for(int j=0;j<20;++j){for(size_t i=0;i<3;++i)next[i]=y[i]-fraction*xs[i]*change[i];
            if(next[0]>0&&next[1]>IF97::Tmin&&next[2]>0&&next[2]<old.c.geometry.V)break;fraction*=.5;}
        require(next[0]>0&&next[1]>IF97::Tmin&&next[2]>0&&next[2]<old.c.geometry.V,"No admissible local conversion trial");y=next;
    }throw std::runtime_error("One-active native conversion did not converge within finite local allowance");
}
AcceptedPhase active_fixture(bool liquid_active,double p,int nc_kind,bool steam_absent=false) {
    const Geometry g{.01,4,1,false};const double Vg=.004,pv=steam_absent?0:nc_kind<0?p:p*.8;
    const double Tg=steam_absent?500:liquid_active?r4.T_p(pv)+80:r4.T_p(pv);
    const double Tl=liquid_active?r4.T_p(p):r4.T_p(p)-40;
    const NC nc=nc_kind<0?NC{0,0}:gas_stock((p-pv)*Vg/Tg,nc_kind==0?1:nc_kind==1?0:.5);
    const auto l=liquid_active?endpoint(p,true):liquid(Tl,p);
    const double Ml=l.rho*(g.V-Vg),Mv=steam_absent?0:(liquid_active?vapor(Tg,pv):endpoint(pv,false)).rho*Vg;
    const Phase c{g,nc,4*Ml,-2*(Mv+nc.mass()),10*Ml};
    if(steam_absent){const auto q=steam_free({Tl,Tg,Vg},c);Map<4> native;native.pressure=p;native.value={q.value[0],0,q.value[1],q.value[2]};return {{0,Tl,Tg,Vg},c,native};}
    const auto v=liquid_active?vapor(Tg,pv):endpoint(pv,false);
    const std::array<double,4>x{{pv,Tl,Tg,Vg}};return {x,c,phasic_states(x,c,l,v)};
}
Map<2> pure_birth_endpoint(std::array<double,2>x,Geometry g,double u,double kl) {
    const double p=x[0],Vg=x[1];require(Vg>0&&Vg<g.V,"Birth endpoint needs positive born/remaining phases");
    const auto l=endpoint(p,true),v=endpoint(p,false);const double Ml=l.rho*(g.V-Vg),Mv=v.rho*Vg;
    const double gz=9.80665*(g.z+g.H/2);Map<2> q;q.pressure=p;
    q.value={Ml+Mv,Ml*l.u+Mv*v.u+.5*(Ml+Mv)*u*u+kl*Ml+(Ml+Mv)*gz};
    const double s=saturation_slope(p),dl=l.rho*(l.kappa-l.alpha*s),dv=v.rho*(v.kappa-v.alpha*s);
    const double ulp=(p*l.kappa-l.T*l.alpha)/l.rho+(l.cp-p*l.alpha/l.rho)*s;
    const double uvp=(p*v.kappa-v.T*v.alpha)/v.rho+(v.cp-p*v.alpha/v.rho)*s;
    for(size_t j=0;j<2;++j){const double dMl=j==0?(g.V-Vg)*dl:-l.rho,dMv=j==0?Vg*dv:v.rho;
        q.J[0][j]=dMl+dMv;q.J[1][j]=(l.u+.5*u*u+kl+gz)*dMl+(v.u+.5*u*u+gz)*dMv+(j==0?Ml*ulp+Mv*uvp:0);
    }return q;
}
std::array<double,2> recover_pure_birth(Geometry g,double M,double E,double u,double kl,std::array<double,2>x) {
    const std::array<double,2> xs{{x[0],x[1]}},rs{{M,std::abs(E)}};
    for(int k=0;k<16;++k){const auto q=pure_birth_endpoint(x,g,u,kl);
        const std::array<double,2> r{{q.value[0]-M,q.value[1]-E}};
        if(std::abs(r[0])<=1e-10&&std::abs(r[1])<=1e-5&&std::max(std::abs(r[0])/rs[0],std::abs(r[1])/rs[1])<=1e-12) return x;
        std::array<std::array<double,2>,2>A{};std::array<double,2>b{};
        for(size_t i=0;i<2;++i){b[i]=r[i]/rs[i];for(size_t j=0;j<2;++j)A[i][j]=q.J[i][j]*xs[j]/rs[i];}
        const auto step=linear(A,b);double fraction=1;std::array<double,2> next{};
        for(int j=0;j<20;++j){for(size_t i=0;i<2;++i)next[i]=x[i]-fraction*xs[i]*step[i];
            if(next[0]>IF97::Pmin&&next[0]<IF97::Pcrit&&next[1]>0&&next[1]<g.V)break;fraction*=.5;}
        require(next[0]>IF97::Pmin&&next[0]<IF97::Pcrit&&next[1]>0&&next[1]<g.V,"Pure birth trial outside declared subcritical endpoint");x=next;
    }throw std::runtime_error("Pure phase birth native endpoint did not converge");
}
void pure_birth_checks() {
    // Opens actual previously evacuated available volume: free expansion, no external work.
    // No absent gas T/P/E was constructed at the original single-liquid state.
    const auto original=liquid(r4.T_p(1e6)-20,1e6);const double M=1,u=1.2,kl=10;
    const double originalV=M/original.rho;const Geometry expanded{.002,4,1,false};
    require(expanded.V>originalV,"Free-expansion intervention did not expose additional volume");
    const double E=M*original.u+.5*M*u*u+M*kl+M*9.80665*4.5;
    const auto x=recover_pure_birth(expanded,M,E,u,kl,{.7e6,expanded.V-originalV});
    const auto l=endpoint(x[0],true),v=endpoint(x[0],false);const double Ml=l.rho*(expanded.V-x[1]),Mv=v.rho*x[1];
    born_steam_mass=Mv;require(Mv>0&&Ml>0,"Expanded liquid did not produce genuine positive vapor");
    component(Ml*u+Mv*u,M*u,"vapor birth momentum");component(Ml*kl+Mv*kl,M*kl,"liquid Q carried/thermalized partition");
    const auto q=pure_birth_endpoint(x,expanded,u,kl);
    require(std::abs(q.value[0]-M)<=1e-10&&std::abs(q.value[1]-E)<=1e-5,"Vapor birth native conservation");++birth_cases;
    // Removes specified actual gas energy from initially liquid-free saturated steam.
    const Geometry g{.01,4,1,false};const auto steam=endpoint(1e6,false);
    const double water=steam.rho*g.V,ug=-2,E0=water*steam.u+.5*water*ug*ug+water*9.80665*4.5;
    const auto y=recover_pure_birth(g,water,E0-1000,ug,0,{.99e6,.00999});
    const double born=endpoint(y[0],true).rho*(g.V-y[1]),remaining=endpoint(y[0],false).rho*y[1];
    born_liquid_mass=born;require(born>0&&remaining>0,"Gas cooling did not produce genuine positive liquid");
    component(born*ug+remaining*ug,water*ug,"liquid birth momentum");
    const auto cooled=pure_birth_endpoint(y,g,ug,0);
    require(std::abs(cooled.value[0]-water)<=1e-10&&std::abs(cooled.value[1]-(E0-1000))<=1e-5,"Liquid birth native conservation");++birth_cases;
    // Both cases use the selected both-active endpoint, not invented newborn superheat.
    // They do not locate a time event or prove any specified phase can fully exhaust.
}
void one_active_checks() {
    for(int fixture=0;fixture<10;++fixture){const bool la=fixture%2==0;
        const double p=fixture<4?(fixture<2?1e6:5e6):1e6;
        const int nc_kind=fixture<4?-1:(fixture-4)/2;const auto original=active_fixture(la,p,nc_kind);
        std::array<AcceptedPhase,3> finals{{original,original,original}};
        for(int refinement=0;refinement<3;++refinement){const int parts=1<<refinement;
            auto old=original;for(int part=0;part<parts;++part)old=advance_active(old,la,(la?100:-100)/parts).state;
            finals[refinement]=old;
        }
        const auto& a=finals[1];const auto& b=finals[2];
        const double pe=std::abs(a.native.pressure-b.native.pressure),te=std::max(std::abs(a.x[1]-b.x[1]),std::abs(a.x[2]-b.x[2]));
        const double me=std::abs(a.native.value[1]-b.native.value[1]);
        max_quadrature_pressure_difference=std::max(max_quadrature_pressure_difference,pe);
        max_quadrature_temperature_difference=std::max(max_quadrature_temperature_difference,te);
        max_quadrature_mass_difference=std::max(max_quadrature_mass_difference,me);
        require(pe<=1&&te<=1e-4&&me<=1e-7,"One-active half/quarter source quadrature discrepancy");++conversion_cases;
    }
    // Existing NC gas carries its own genuine T/P/E before the first steam is born.
    const auto old=active_fixture(true,1e6,2,true);const auto born=advance_active(old,true,100);
    nc_born_steam_mass=born.state.native.value[1];require(old.native.value[1]==0&&nc_born_steam_mass>0,"Steam-free NC native birth did not occur");++birth_cases;
    pure_birth_checks();
}

int main() {
    std::cout<<std::setprecision(17); std::string failure;
    try {
        // Rounded independent IAPWS R7-97(2012) Tables5/15/33/42 values, in SI.
        struct Ref { int reg; double T,x,v,h,u,s,cp,w; };
        const std::array<Ref,12> refs{{
            {1,300,3e6,.00100215168,115331.273,112324.818,392.294792,4173.01218,1507.73921},
            {1,300,80e6,.000971180894,184142.828,106448.356,368.563852,4010.08987,1634.69054},
            {1,500,3e6,.001202418,975542.239,971934.985,2580.41912,4655.80682,1240.71337},
            {2,300,3500,39.4913866,2549911.45,2411691.60,8522.38967,1913.00162,427.920172},
            {2,700,3500,92.3015898,3335683.75,3012628.19,10174.9996,2081.41274,644.289068},
            {2,700,30e6,.00542946619,2631494.74,2468610.76,5175.40298,10350.5092,480.386523},
            {3,650,500,1./500,1863430.19,1812262.79,4054.27273,13893.5717,502.005554},
            {3,650,200,1./200,2375124.01,2263658.68,4854.38792,44657.9342,383.444594},
            {3,750,500,1./500,2258688.45,2102069.32,4469.71906,6341.65359,760.696041},
            {5,1500,.5e6,1.3845509,5219768.55,4527493.10,9654.08875,2616.09445,917.068690},
            {5,1500,30e6,.0230761299,5167235.14,4474951.24,7729.70133,2727.24317,928.548002},
            {5,2000,30e6,.0311385219,6571226.04,5637070.38,8536.40523,2885.69882,1067.36948}
        }};
        for(const auto& a:refs) {
            const auto q=a.reg==3?dense(a.T,a.x):point(a.T,a.x);
            require(q.region==a.reg,"Published reference region mismatch");
            for(const auto pair:std::array<std::pair<double,double>,6>{{{1/q.rho,a.v},{q.h,a.h},{q.u,a.u},{q.s,a.s},{q.cp,a.cp},{q.w,a.w}}})
                require(relative(pair.first,pair.second)<=2e-6,"Printed IAPWS verification value mismatch");
            check_state(q); recover(q);
        }
        for(const auto pt:std::array<std::pair<double,double>,9>{{
            {273.2,101325},{290,101325},{313.15,1e6},{578.045678,15.2e6},
            {620,16e6},{420,.1e6},{650,25e6},{647.1,22.065e6},{313.15,15.2e6}}}) {
            const auto q=point(pt.first,pt.second); check_state(q); recover(q);
        }
        require(point(273.2,101325).alpha<0,"Density-anomaly alpha sign was lost");
        for(double p:{1e5,1e6,10e6,16e6}) {
            const double T=r4.T_p(p),analytic=saturation_slope(p);
            for(double step:{p*1e-5,p*5e-6}) {
                const double fd=(r4.T_p(p+step)-r4.T_p(p-step))/(2*step);
                const double ratio=relative(fd,analytic)/1e-6;max_sat_ratio=std::max(max_sat_ratio,ratio);
                require(ratio<=1,"Same Region4 saturation derivative failed");
            }
            const auto l=gibbs(r1,1,T,p),v=gibbs(r2,2,T,p);
            require(v.rho<l.rho&&v.h>l.h&&analytic>0,"Saturation endpoints invalid");
            require(std::isfinite(l.alpha)&&std::isfinite(v.alpha)&&l.kappa>0&&v.kappa>0,
                "One-sided saturation endpoint derivatives unavailable");
            const double clapeyron=T*(1/v.rho-1/l.rho)/(v.h-l.h);
            max_clapeyron_difference=std::max(max_clapeyron_difference,relative(analytic,clapeyron));
        }
        for(const auto pt:std::array<std::pair<double,double>,4>{{{300,-1},{0,1e6},{250,1e6},{2400,1e6}}}) {
            bool rejected=false;try{(void)point(pt.first,pt.second);}catch(const std::exception&){rejected=true;}
            require(rejected,"Invalid property domain input accepted");
        }
        phase_checks();
        one_active_checks();
        const auto t0=Clock::now();volatile double sum=0;
        for(int i=0;i<20000;++i) {
            const int k=i%4;const double dt=(i%97)*.001,dp=(i%89)*11;
            const auto q=k==0?point(313.15+dt,1e6+dp):k==1?point(580+dt,15.2e6+dp):
                k==2?point(700+dt,1e6+dp):point(650+dt,25e6+dp);
            sum=sum+q.rho+q.h+q.cp+q.alpha+q.kappa; ++bench_count;
        }
        bench_ns=std::chrono::duration<double>(Clock::now()-t0).count()*1e9/bench_count;
        require(std::isfinite(sum),"Changed-state timing produced invalid tuple");
    } catch(const std::exception& e) { failure=e.what(); }
    std::cout<<"{\"passed\":"<<(failure.empty()?"true":"false")<<",\"failure\":"<<std::quoted(failure)
        <<",\"checks\":"<<checks<<",\"native_execution_s\":"<<std::chrono::duration<double>(Clock::now()-started).count()
        <<",\"max_increment_derivative_budget_ratio\":"<<max_fd_ratio<<",\"max_h_identity_relative\":"<<max_identity
        <<",\"max_storage_determinant_relative\":"<<max_det<<",\"max_region3_forward_pressure_defect_Pa\":"<<max_forward_p
        <<",\"max_saturation_derivative_budget_ratio\":"<<max_sat_ratio<<",\"max_R4_Clapeyron_relative_difference\":"<<max_clapeyron_difference
        <<",\"max_known_branch_recovery_pressure_error_Pa\":"<<max_recovery_p
        <<",\"cold_15_2_MPa_recovery_pressure_error_Pa\":"<<cold_recovery_p
        <<",\"low_head_101325Pa_recovery_pressure_error_Pa\":"<<low_head_recovery_p
        <<",\"phase_storage_cases\":"<<phase_cases<<",\"dilute_steam_cases\":"<<dilute_cases<<",\"absent_phase_cases\":"<<absent_cases
        <<",\"max_scaled_phase_Jacobian_condition_inf\":"<<max_phase_condition
        <<",\"max_known_phase_recovery_scaled_residual\":"<<max_phase_residual
        <<",\"max_phase_pressure_coordinate_recovery_error_Pa\":"<<max_phase_p_error
        <<",\"max_phase_total_pressure_recovery_error_Pa\":"<<max_phase_total_pressure_error
        <<",\"max_phasic_temperature_recovery_error_K\":"<<max_phase_temperature_error
        <<",\"max_R3_endpoint_forward_pressure_defect_Pa\":"<<max_dense_endpoint_p_error
        <<",\"min_tested_R3_saturation_latent_heat_J_kg\":"<<min_contact_latent_heat
        <<",\"cut_volume_first_moment_identity_m4\":"<<max_centroid_identity
        <<",\"one_active_conversion_cases\":"<<conversion_cases<<",\"native_birth_cases\":"<<birth_cases
        <<",\"max_conversion_mass_error_kg\":"<<max_conversion_mass_error
        <<",\"max_conversion_energy_error_J\":"<<max_conversion_energy_error
        <<",\"max_inactive_phase_energy_work_error_J\":"<<max_inactive_energy_error
        <<",\"max_conversion_total_momentum_error_kg_m_s\":"<<max_conversion_momentum_error
        <<",\"max_direct_component_identity_error\":"<<max_component_identity_error
        <<",\"max_half_quarter_pressure_difference_Pa\":"<<max_quadrature_pressure_difference
        <<",\"max_half_quarter_temperature_difference_K\":"<<max_quadrature_temperature_difference
        <<",\"max_half_quarter_converted_water_difference_kg\":"<<max_quadrature_mass_difference
        <<",\"min_retained_opposite_phase_stability_margin_K\":"<<min_retained_opposite_margin
        <<",\"min_tested_stability_conversion_kg\":"<<min_real_conversion
        <<",\"born_steam_into_NC_kg\":"<<nc_born_steam_mass
        <<",\"pure_free_expansion_born_steam_kg\":"<<born_steam_mass
        <<",\"pure_gas_cooling_born_liquid_kg\":"<<born_liquid_mass
        <<",\"changed_state_tuples\":"<<bench_count<<",\"changed_state_tuple_ns\":"<<bench_ns<<"}\n";
    return failure.empty()?0:1;
}
`;

export async function runNativePropertyAdmission(inputDirectory: string, outputPath: string) {
  const started = performance.now();
  const input = resolve(inputDirectory), output = resolve(outputPath);
  // Refuse to overwrite any earlier evidence, including failure receipts.
  try {
    await readFile(output);
    throw new Error('The receipt already exists; keep the earlier evidence immutable');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const header = await readFile(join(input, 'IF97.h'));
  const license = await readFile(join(input, 'LICENSE'));
  if (sha256(header) !== headerSha256 || sha256(license) !== licenseSha256)
    throw new Error('Header/license do not match the single inspected official candidate');
  const scratch = await mkdtemp(join(tmpdir(), 'leitbild-if97-property-'));
  const source = join(scratch, 'admission.cpp'), executable = join(scratch, 'admission');
  await writeFile(source, cpp, { flag: 'wx' });
  async function execute(command: string[]) {
    const remaining = 120_000 - (performance.now() - started);
    if (remaining <= 0) throw new Error('Aggregate compile/execution allowance exhausted');
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, remaining);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { command, exitCode, timedOut, stdout, stderr };
    } finally { clearTimeout(timer); }
  }
  const compiler = await execute(['clang++', '--version']);
  const flags = ['-std=c++17', '-O2'];
  const build = compiler.exitCode === 0 && !compiler.timedOut
    ? await execute(['clang++', ...flags, '-I', input, source, '-o', executable]) : null;
  const run = build?.exitCode === 0 && !build.timedOut ? await execute([executable]) : null;
  let nativeResult: unknown = null, parseFailure: string | null = null;
  if (run) {
    try { nativeResult = JSON.parse(run.stdout); }
    catch (error) { parseFailure = String(error); }
  }
  const nativePassed = typeof nativeResult === 'object' && nativeResult !== null
    && 'passed' in nativeResult && nativeResult.passed === true;
  const passed = !!run && run.exitCode === 0 && !run.timedOut && nativePassed;
  const receipt = {
    schema: 'ld01-offline-if97-property-admission',
    recordedAt: new Date().toISOString(), passed, upstream: {
      project: 'CoolProp/IF97', version: '2.2.1', revision, headerSha256, licenseSha256,
      license: 'MIT', units: 'SI default', region3: 'REGION3_ITERATE',
    },
    artifact: {
      wrapperPath: import.meta.path, wrapperSha256: sha256(await readFile(import.meta.path)),
      cppSha256: sha256(cpp), scratch, source, executable,
      binarySha256: build?.exitCode === 0 ? sha256(await readFile(executable)) : null,
    },
    allowanceSeconds: 120,
    aggregateElapsedSeconds: (performance.now() - started) / 1000,
    compiler, flags, build, run, nativeResult, parseFailure,
    scope: 'Selected IF97 primitives, finite known-branch phase/NC storage and analytic Jacobians, finite one-active source/work increments with actual donor momentum/Q, and native phase-birth endpoint witnesses. No spatial/time trajectory, global flash, complete exhaustion event, coherent-cap pressure/recoil/ALE or plant throughput qualification.',
  };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (import.meta.main) {
  if (Bun.argv.length !== 4) throw new Error('Expected INPUT_DIRECTORY NEW_RECEIPT.json');
  const receipt = await runNativePropertyAdmission(Bun.argv[2]!, Bun.argv[3]!);
  console.log(JSON.stringify({
    passed: receipt.passed, receipt: resolve(Bun.argv[3]!), elapsed: receipt.aggregateElapsedSeconds,
    nativeResult: receipt.nativeResult, parseFailure: receipt.parseFailure,
    buildError: receipt.build?.exitCode !== 0 ? receipt.build?.stderr : null,
  }, null, 2));
  if (!receipt.passed) process.exitCode = 1;
}
