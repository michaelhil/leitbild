/**
 * Bounded offline pure-water property admission, not an LD-01 runtime.
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
    // Debits the earlier immutable 2.020 s receipt conservatively as 3 s.
    const remaining = 117_000 - (performance.now() - started);
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
    allowanceSeconds: 117, predecessorElapsedSeconds: 2.019801125,
    aggregateElapsedSeconds: (performance.now() - started) / 1000,
    compiler, flags, build, run, nativeResult, parseFailure,
    scope: 'Changed pure-water property points, fixed-region derivatives, native storage identities, local known-branch rho/u recovery and four subcritical saturation endpoints; no trajectory, global multiphase flash or plant throughput admission.',
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
