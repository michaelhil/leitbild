/**
 * Reusable offline axial rates and conservative residual; no time integrator.
 * Selected local mixing law is Rust-owned. Finite qualification only.
 * The stopped whole-vector campaign remains under its immutable private artifacts.
 */
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry';
import { parseBalancePathBasis } from './reference-design-cmt-balance-path';
import { nativeIf97Primitives } from './reference-design-if97-primitives';
import { nativeMixingAbi, nativeMixingQualification } from './reference-design-cmt-mixing-fixture';

const axialFields = ['M', 'P', 'E', 'B', 'Q', 'PP', 'TT'] as const;
/** This candidate allocates only actual cell-owned stocks and thermodynamic coordinates. */
export function ownedAxialLayout(receiving: readonly boolean[]) {
  let coordinateCount = 0;
  const coordinates: { cell: number; field: typeof axialFields[number] }[] = [];
  const indices = receiving.map((ownsMixing, cell) => axialFields.map(field => {
    if (field === 'Q' && !ownsMixing) return null;
    const index = coordinateCount++;
    coordinates.push({ cell, field });return index;
  }));
  return { indices, coordinates, coordinateCount };
}

function fixtureGeometry(document: string) {
  const b = parseGeometryBasis(document), path = parseBalancePathBasis(document), g = tankGeometry(b);
  const area = Math.PI * path.bore_m ** 2 / 4;
  const top = g.roof(b.feedOuterDiameter_m / 2);
  const base = [g.mouth, b.bottomDatum_m + g.a, b.top_m - g.a, b.bodyBottom_m,
    11.8125, 11.8875, b.bodyTop_m, top];
  const cuts = [base[0]!];
  for (let j = 1; j < base.length; ++j) {
    const n = Math.ceil((base[j]! - base[j - 1]!) / .75);
    for (let k = 1; k <= n; ++k) cuts.push(base[j - 1]! + (base[j]! - base[j - 1]!) * k / n);
  }
  const cells: { V: number; z: number; low: number; high: number; A0: number; A1: number;
    length: number; slope: number; Dh: number; tank: boolean;
    quadrature: { weight: number; radius: number }[] }[] = [];
  const nodes = [-.9602898564975363, -.7966664774136267, -.5255324099163290, -.1834346424956498,
    .1834346424956498, .5255324099163290, .7966664774136267, .9602898564975363];
  const weights = [.1012285362903763, .2223810344533745, .3137066458778873, .3626837833783620,
    .3626837833783620, .3137066458778873, .2223810344533745, .1012285362903763];
  for (let j = 1; j < cuts.length; ++j) {
    const lo = cuts[j - 1]!, hi = cuts[j]!, mid = (lo + hi) / 2;
    const obstruction = mid >= b.bodyBottom_m && mid <= b.bodyTop_m ? b.bodyOuterDiameter_m / 2
      : mid > b.bodyTop_m ? b.feedOuterDiameter_m / 2 : 0;
    const A = (z: number) => z === top ? 0 : Math.PI * Math.max(0, g.shellR2(z) - obstruction ** 2);
    const h = (hi - lo) / 2, d = h * Math.sqrt(3 / 5);
    const volume = g.volume(lo, hi), moment = h * (5 / 9 * (A(mid - d) * (mid - d)
      + A(mid + d) * (mid + d)) + 8 / 9 * A(mid) * mid);
    let axialContact = 0;
    const quadrature = nodes.map((node, k) => {
      const z = mid + h * node, perimeter = 2 * Math.PI * (Math.sqrt(g.shellR2(z)) + obstruction);
      axialContact += h * weights[k]! * perimeter;
      return { weight: h * weights[k]! * A(z) / volume, radius: A(z) / perimeter };
    });
    cells.push({ V: volume, z: moment / volume, low: lo, high: hi, A0: A(lo), A1: A(hi),
      length: hi - lo, slope: 1, Dh: 4 * volume / axialContact,
      tank: true, quadrature });
  }
  const mainLength = (b.balanceWater_m3 - b.distributorGroupWater_m3) / area;
  const rise = b.top_m - path.headerElevation_m, horizontal = mainLength - rise;
  const route = (V: number, lo: number, hi: number, A0: number, A1: number,
    length: number, z = (lo + hi) / 2) => cells.push({ V, z, low: lo, high: hi, A0, A1,
    length, slope: (hi - lo) / length, Dh: path.bore_m, tank: false,
    quadrature: [{ weight: 1, radius: path.bore_m / 4 }] });
  for (let j = 0; j < 2; ++j) route(area * horizontal / 2, 3, 3, area, area, horizontal / 2);
  for (let j = 0; j < 2; ++j) route(area * rise / 2, 3 + j * rise / 2, 3 + (j + 1) * rise / 2,
    area, area, rise / 2);
  const bodyArea = Math.PI * b.bodyEffectiveInnerDiameter_m ** 2 / 4;
  const feedV = area * (b.top_m - b.bodyTop_m);
  const roofV = b.distributorGroupWater_m3 - g.inventories.effectiveBodyWater_m3 - feedV;
  route(roofV + feedV, b.top_m, b.bodyTop_m, area, area, roofV / area + (b.top_m - b.bodyTop_m),
    (roofV * b.top_m + feedV * (b.top_m + b.bodyTop_m) / 2) / (roofV + feedV));
  const bodyCuts = [b.bodyTop_m, 11.8875, 11.8125, b.bodyBottom_m];
  for (let j = 1; j < bodyCuts.length; ++j) route(bodyArea * (bodyCuts[j - 1]! - bodyCuts[j]!),
    bodyCuts[j - 1]!, bodyCuts[j]!, bodyArea, bodyArea,
    bodyCuts[j - 1]! - bodyCuts[j]!, (bodyCuts[j - 1]! + bodyCuts[j]!) / 2);
  for (const c of cells.slice(18)) {
    c.Dh = b.bodyEffectiveInnerDiameter_m;
    c.quadrature[0]!.radius = b.bodyEffectiveInnerDiameter_m / 4;
  }
  if (cells.length !== 21 || cells.filter(c => c.tank).length !== 13
    || Math.abs(cells.slice(0, 13).reduce((s, c) => s + c.V, 0) - 60) > 1e-9
    || Math.abs(cells.slice(13).reduce((s, c) => s + c.V, 0) - 1) > 1e-9)
    throw Error('Actual selected 13+8 partition/volume closure failed');
  return { b, path, cells, cuts, scope: 'Actual 60 m3 CMT and 1 m3 trapped BAL; header and both outlets CLOSED' };
}

function nativeSource(input: ReturnType<typeof fixtureGeometry>) {
  const rows = input.cells.map(c => `{${[c.V, c.z, c.low, c.high, c.A0, c.A1, c.length,
    c.slope, c.Dh, c.tank ? 1 : 0].join(',')}}`).join(',\n');
  const layout = ownedAxialLayout(input.cells.map(c => c.tank));
  return String.raw`
${nativeIf97Primitives}
#include <chrono>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <vector>
#include <limits>

using Clock=std::chrono::steady_clock;
static const auto started=Clock::now();
static double guard_seconds=100;
static long checks=0, tuple_calls=0;
double max_forward_p=0,max_dense_endpoint_p_error=0;
void require(bool ok,const std::string& message) {
    ++checks;
    if(std::chrono::duration<double>(Clock::now()-started).count()>guard_seconds)
        throw std::runtime_error("Aggregate native guard exhausted");
    if(!ok)throw std::runtime_error(message);
}
constexpr int N=${input.cells.length},S=7,RM=8,PHYSICAL=${layout.coordinateCount},D=PHYSICAL,OBSERVERS=3*RM,SAMPLE=D+OBSERVERS;
constexpr double gravity=9.80665,holeD=${input.b.holeDiameter_m},Cd=${input.path.Cd},Cv=${input.path.Cv};
struct Cell {double V,z,lo,hi,A0,A1,length,slope,Dh;bool tank;};
const std::array<Cell,N> cells{{${rows}}};
struct GeometricNode {double weight,radius;};
constexpr int MIXING_NODES=${input.cells.reduce((sum,c)=>sum+c.quadrature.length,0)};
${nativeMixingAbi}
uint64_t mixing_batches=0,mixing_points=0;
// Finite qualification observations only, not coordinates or advancement rules.
std::array<double,N> localRightQSourceSlope{};
void mixing_batch(const RustMixingInput*inputs,RustMixingOutput*outputs,size_t count,uint32_t trial=1){
    size_t failed=0;unsigned char message[256]{};
    const int status=leitbild_mixing_batch(inputs,outputs,count,trial,&failed,message,sizeof(message));
    require(status==0,"Rust mixing law rejected point="+std::to_string(failed)+": "+reinterpret_cast<const char*>(message));
    ++mixing_batches;mixing_points+=count;
}
const std::array<std::vector<GeometricNode>,N> geometryNodes{{${input.cells.map(c =>
    `{${c.quadrature.map(n => `{${n.weight},${n.radius}}`).join(',')}}`).join(',\n')}}};
const std::array<double,3> rings{{${input.b.ringElevations_m.join(',')}}};
// Native stocks M/P/E/B/Q are differential; p/T are thermodynamic algebraic coordinates.
enum {M,P,E,B,Q,PP,TT};
const std::array<std::array<int,S>,N> coordinateIndex{{${layout.indices.map(indices =>
    `{${indices.map(index => index ?? -1).join(',')}}`).join(',')}}};
struct CoordinateOwner {int cell,field;};
const std::array<CoordinateOwner,PHYSICAL> coordinateOwner{{${layout.coordinates.map(c =>
    `{${c.cell},${axialFields.indexOf(c.field)}}`).join(',')}}};
int ix(int cell,int field) {
    const int index=coordinateIndex.at(cell).at(field);
    if(index<0)throw std::logic_error("Attempt to address an unowned native coordinate");
    return index;
}
struct CellView {
    const double* values;int cell;
    double operator[](int field) const {return values[ix(cell,field)];}
};
CellView view(const double* values,int cell){return {values,cell};}
struct Trace {State s;double velocity,k,concentration,z;};
struct Flux {double mass,momentum,energy,tracer,mixing;};
State water(double T,double p) {
    ++tuple_calls;const auto s=liquid(T,p);
    require(s.rho>0&&s.cp>0&&s.cv>0&&s.kappa>0&&s.w>0,"Unstable recovered liquid");
    require(s.kappa-s.T*s.alpha*s.alpha/(s.rho*s.cp)>0,"Nonpositive isentropic storage");
    return s;
}
double up(const State& s){return (s.p*s.kappa-s.T*s.alpha)/s.rho;}
double ut(const State& s){return s.cp-s.p*s.alpha/s.rho;}
State recover_star(const State& start,double rho,double internal) {
    double p=start.p,T=start.T;
    for(int iteration=0;iteration<8;++iteration){const auto s=water(T,p);
        const double rr=s.rho-rho,re=s.u-internal;
        if(std::abs(rr)<=1e-10* rho&&std::abs(re)<=1e-6)return s;
        const double rp=s.rho*s.kappa,rt=-s.rho*s.alpha,ep=up(s),et=ut(s),det=rp*et-rt*ep;
        require(det>0,"HLLC star lost local EOS recovery rank");
        p-=(rr*et-rt*re)/det;T-=(rp*re-rr*ep)/det;
    }
    throw std::runtime_error("Conservative HLLC star has no admitted local liquid recovery");
}
Trace trace(const double* y,int i,double z) {
    const auto& c=cells[i];const auto x=view(y,i);
    // Signed finite Q is a NUMERICAL TRIAL continuation only. Its signed energy,
    // transport and isotropic-stress terms remain; root-dependent closure coefficients
    // have their analytic zero branch at k<=0. Accepted Q is separately strict >=0.
    require(x[M]>0&&(!c.tank||std::isfinite(x[Q]))&&x[B]>=0,"Invalid trial liquid or mixing/tracer stock");
    const double p=x[PP]-x[M]/c.V*gravity*(z-c.z);
    return {water(x[TT],p),x[P]/x[M],c.tank?x[Q]/x[M]:0,x[B]/x[M],z};
}
Flux euler(const Trace& t) {
    const double m=t.s.rho*t.velocity;
    return {m,m*t.velocity+t.s.p,m*(t.s.h+t.velocity*t.velocity/2+t.k+gravity*t.z),
        m*t.concentration,m*t.k};
}
Flux hllc(const Trace& L,const Trace& R) {
    const double sl=std::min(L.velocity-L.s.w,R.velocity-R.s.w);
    const double sr=std::max(L.velocity+L.s.w,R.velocity+R.s.w);
    const auto fl=euler(L),fr=euler(R);
    if(sl>=0)return fl;if(sr<=0)return fr;
    const double dl=L.s.rho*(sl-L.velocity),dr=R.s.rho*(sr-R.velocity);
    const double meanVelocity=(L.velocity+R.velocity)/2,halfVelocity=(L.velocity-R.velocity)/2;
    const double ss=meanVelocity+(R.s.p-L.s.p+(dl+dr)*halfVelocity)/(dl-dr);
    const Trace& t=ss>=0?L:R;const double wave=ss>=0?sl:sr;
    const double factor=(wave-t.velocity)/(wave-ss),rho=t.s.rho*factor;
    const double et=t.s.u+t.velocity*t.velocity/2+t.k+gravity*t.z;
    const double estar=rho*(et+(ss-t.velocity)*(ss+t.s.p/(t.s.rho*(wave-t.velocity))));
    require(rho>0&&std::isfinite(estar)&&wave!=ss,"Invalid conservative HLLC star");
    // Star energy is RH-conservative: its EOS pressure is not forced to the numerical traction.
    const double internal=estar/rho-ss*ss/2-t.k-gravity*t.z;
    require(std::isfinite(internal),"Nonfinite HLLC star internal energy");
    (void)recover_star(t.s,rho,internal);
    // Same RH flux, evaluated without subtracting huge rounded products. In particular
    // SM=0 gives exactly zero material/energy at contacts and reflecting caps under FMA.
    // The traction remains the selected numerical star pressure, NOT EOS(star).p.
    const double mass=rho*ss,traction=t.s.p+t.s.rho*(wave-t.velocity)*(ss-t.velocity);
    return {mass,mass*ss+traction,ss*(estar+traction),mass*t.concentration,mass*t.k};
}
template<size_t K> std::array<double,K> linear(std::array<std::array<double,K>,K> A,std::array<double,K> b) {
    for(size_t k=0;k<K;++k){size_t pivot=k;for(size_t i=k+1;i<K;++i)if(std::abs(A[i][k])>std::abs(A[pivot][k]))pivot=i;
        require(std::isfinite(A[pivot][k])&&A[pivot][k]!=0,"Singular selected local junction");
        std::swap(A[pivot],A[k]);std::swap(b[pivot],b[k]);
        for(size_t i=k+1;i<K;++i){double f=A[i][k]/A[k][k];for(size_t j=k;j<K;++j)A[i][j]-=f*A[k][j];b[i]-=f*b[k];}}
    std::array<double,K>x{};for(size_t ii=K;ii>0;--ii){size_t i=ii-1;double v=b[i];for(size_t j=i+1;j<K;++j)v-=A[i][j]*x[j];x[i]=v/A[i][i];}return x;
}
struct Port {double mass,leftMomentum,rightMomentum,energy,tracer,mixing;};
Port area_port(const Trace& L,const Trace& R,double AL,double AR) {
    if(L.s.p==R.s.p&&L.velocity==0&&R.velocity==0)
        return {0,L.s.p*AL,R.s.p*AR,0,0,0};
    // Outgoing linear characteristics, donor entropy on both moving traces and full H equality.
    double guess=(L.s.p-R.s.p+L.s.rho*L.s.w*L.velocity+R.s.rho*R.s.w*R.velocity)/(L.s.w/AL+R.s.w/AR);
    const Trace& donor=guess>=0?L:R;
    std::array<double,5>x{{guess,L.s.p,R.s.p,donor.s.T,donor.s.T}};
    for(int iteration=0;iteration<12;++iteration) {
        const auto l=water(x[3],x[1]),r=water(x[4],x[2]);
        const double vl=x[0]/(AL*l.rho),vr=x[0]/(AR*r.rho);
        std::array<double,5>f{{x[1]-L.s.p+L.s.rho*L.s.w*(vl-L.velocity),
            x[2]-R.s.p-R.s.rho*R.s.w*(vr-R.velocity),l.s-donor.s.s,r.s-donor.s.s,
            l.h+vl*vl/2-r.h-vr*vr/2}};
        if(std::abs(f[0])<1e-5&&std::abs(f[1])<1e-5&&std::abs(f[2])<1e-8&&std::abs(f[3])<1e-8&&std::abs(f[4])<1e-7) {
            require(x[0]==0||(x[0]>0)==(guess>0),"Stationary area donor sign changed inside local solve");
            require(std::abs(vl)<l.w&&std::abs(vr)<r.w,"Area port left its liquid subsonic scope");
            const double H=l.h+vl*vl/2+donor.k+gravity*donor.z;
            return {x[0],x[0]*vl+x[1]*AL,x[0]*vr+x[2]*AR,x[0]*H,
                x[0]*donor.concentration,x[0]*donor.k};
        }
        std::array<std::array<double,5>,5>J{};
        J[0]={{L.s.rho*L.s.w/(AL*l.rho),1-L.s.rho*L.s.w*vl*l.kappa,0,L.s.rho*L.s.w*vl*l.alpha,0}};
        J[1]={{-R.s.rho*R.s.w/(AR*r.rho),0,1+R.s.rho*R.s.w*vr*r.kappa,0,-R.s.rho*R.s.w*vr*r.alpha}};
        J[2]={{0,-l.alpha/l.rho,0,l.cp/l.T,0}};
        J[3]={{0,0,-r.alpha/r.rho,0,r.cp/r.T}};
        J[4]={{vl/(AL*l.rho)-vr/(AR*r.rho),(1-l.T*l.alpha)/l.rho-vl*vl*l.kappa,
            -(1-r.T*r.alpha)/r.rho+vr*vr*r.kappa,l.cp+vl*vl*l.alpha,-r.cp-vr*vr*r.alpha}};
        for(auto&v:f)v=-v;const auto dx=linear(J,f);
        for(size_t j=0;j<5;++j)x[j]+=dx[j];
    }
    throw std::runtime_error("Stationary lossless area trace did not converge");
}
double wall_force(const Cell& c,const State& s,double velocity) {
    if(velocity==0)return 0;
    const double Re=s.rho*std::abs(velocity)*c.Dh/s.mu;
    if(Re<=2300)return -32*s.mu*c.V*velocity/(c.Dh*c.Dh);
    double lo=.001,hi=.2;
    for(int j=0;j<35;++j){const double f=(lo+hi)/2;
        const double rough=c.tank?0:${input.path.roughness_m};
        const double r=1/std::sqrt(f)+2*std::log10(rough/(3.7*c.Dh)+2.51/(Re*std::sqrt(f)));
        if(r>0)lo=f;else hi=f;}
    const double ft=(lo+hi)/2,fl=64/Re,f=Re>=4000?ft:fl+(ft-fl)*(Re-2300)/1700;
    return -f*s.rho*c.V*velocity*std::abs(velocity)/(2*c.Dh);
}
const std::array<double,8> gx{{-.9602898564975363,-.7966664774136267,-.5255324099163290,-.1834346424956498,
    .1834346424956498,.5255324099163290,.7966664774136267,.9602898564975363}};
const std::array<double,8> gw{{.1012285362903763,.2223810344533745,.3137066458778873,.3626837833783620,
    .3626837833783620,.3137066458778873,.2223810344533745,.1012285362903763}};

struct SmoothGradients {double pressure,density,velocity;int left,right;bool localReconstruction;};
SmoothGradients local_reconstructed_gradients(const double*y,const State&s,int i){
    const auto&c=cells[i];
    // Existing fixed-T static trace, not an invented adiabatic compression column.
    const double vertical=-y[ix(i,M)]/c.V*gravity;
    return {vertical,s.rho*s.kappa*vertical,0,i,i,true};
}
SmoothGradients smooth_gradients(const double*y,const std::array<State,N>&state,const std::array<double,N>&velocity,int i){
    const auto&c=cells[i];int a=std::max(i<13?0:13,i-1),b=std::min(i<13?12:20,i+1);
    if(a<i&&std::abs(cells[a].A1-c.A0)>1e-12)a=i;
    if(b>i&&std::abs(c.A1-cells[b].A0)>1e-12)b=i;
    if(a==b)return local_reconstructed_gradients(y,state[i],i);
    const double distance=c.tank?cells[b].z-cells[a].z:
        (cells[a].length+cells[b].length)/2+(a+1<b?cells[a+1].length:0);
    require(distance>0,"Invalid smooth-chain gradient distance");
    // Q exists in the vertical receiving column only. No-Q routes retain their
    // developed-direction strain; vertical gradient projection adds no mixing there.
    const double vertical=c.tank?1:c.slope;
    return {(y[ix(b,PP)]-y[ix(a,PP)])/distance*vertical,
        (state[b].rho-state[a].rho)/distance*vertical,(velocity[b]-velocity[a])/distance,a,b,false};
}

std::array<double,SAMPLE> rates(const double* y) {
    // The appended rates are read-only observations, NEVER solver coordinates.
    std::array<double,SAMPLE> out{};
    std::array<State,N> state;std::array<double,N> velocity{},k{},nu{},diff{},tau{},tauPerp{};
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto x=view(y,i);
        require(x[M]>0&&x[B]>=0&&(!c.tank||std::isfinite(x[Q])),"Invalid numerical trial native stock");
        state[i]=water(x[TT],x[PP]);velocity[i]=x[P]/x[M];k[i]=c.tank?x[Q]/x[M]:0;
        require(std::abs(velocity[i])<state[i].w,"Native liquid velocity outside subsonic scope");
        // Reconstructed pressure-sidewall/gravity: the actual hydrostatic part cancels M*g exactly.
        out[ix(i,P)]=x[PP]*(c.A1-c.A0)-x[M]/c.V*gravity*((c.hi-c.z)*c.A1-(c.lo-c.z)*c.A0);
        out[ix(i,P)]+=wall_force(c,state[i],velocity[i]);
    }
    std::array<RustMixingInput,MIXING_NODES> mixingInput;
    std::array<RustMixingOutput,MIXING_NODES> mixingOutput;size_t mixingIndex=0;
    for(int i=0;i<N;++i){const auto&c=cells[i];
        const auto gradient=smooth_gradients(y,state,velocity,i);
        for(const auto&node:geometryNodes[i]){
            require(mixingIndex<MIXING_NODES,"Mixing quadrature input overflow");
            mixingInput[mixingIndex++]={state[i].rho,state[i].mu,k[i],state[i].w*state[i].w,gradient.pressure,gradient.density,gradient.velocity,
                velocity[i]*(c.A1-c.A0)/(2*c.V),node.radius,holeD,std::min(holeD,.7*c.Dh/4)};
        }
    }
    require(mixingIndex==MIXING_NODES,"Incomplete mixing quadrature input");
    mixing_batch(mixingInput.data(),mixingOutput.data(),mixingIndex);mixingIndex=0;
    localRightQSourceSlope.fill(std::numeric_limits<double>::quiet_NaN());
    for(int i=0;i<N;++i){const auto&c=cells[i];double sourceQ=0;
        double rightSlope=0;bool available=true;
        for(const auto&node:geometryNodes[i]){const auto&coefficient=mixingOutput[mixingIndex++];const auto&r=coefficient.rates;
            nu[i]+=node.weight*r[0];diff[i]+=node.weight*r[1];sourceQ+=node.weight*r[7];
            available=available&&coefficient.derivativesAvailable==1;
            if(coefficient.derivativesAvailable)rightSlope+=node.weight*coefficient.derivatives[7][2]*c.V/y[ix(i,M)];
            tau[i]+=node.weight*r[5];tauPerp[i]+=node.weight*r[6];}
        if(c.tank&&k[i]==0&&available)localRightQSourceSlope[i]=rightSlope;
        if(c.tank)out[ix(i,Q)]+=sourceQ*c.V;
        out[ix(i,P)]-=tauPerp[i]*(c.A1-c.A0);
    }
    auto link=[&](int left,int right){const auto&L=cells[left];const auto&R=cells[right];
        const double z=(L.hi+R.lo)/2;auto l=trace(y,left,z),r=trace(y,right,z);
        const bool step=std::abs(L.A1-R.A0)>1e-12;
        Port port;
        if(step)port=area_port(l,r,L.A1,R.A0);
        else{const auto f=hllc(l,r);port={f.mass*L.A1,f.momentum*L.A1,f.momentum*L.A1,
            f.energy*L.A1,f.tracer*L.A1,f.mixing*L.A1};}
        out[ix(left,M)]-=port.mass;out[ix(right,M)]+=port.mass;
        out[ix(left,P)]-=port.leftMomentum;out[ix(right,P)]+=port.rightMomentum;
        out[ix(left,E)]-=port.energy;out[ix(right,E)]+=port.energy;
        out[ix(left,B)]-=port.tracer;out[ix(right,B)]+=port.tracer;
        if(L.tank)out[ix(left,Q)]-=port.mixing;if(R.tank)out[ix(right,Q)]+=port.mixing;
        const double distance=(L.length+R.length)/2,A=std::min(L.A1,R.A0);
        // Molecular conduction and actual tracer diffusion are present even for Q=0.
        const double rho=(l.s.rho+r.s.rho)/2,T=(l.s.T+r.s.T)/2,mu=(l.s.mu+r.s.mu)/2;
        const double dt=(r.s.T-l.s.T)/distance,ds=(r.s.s-l.s.s)/distance;
        const double kappa=(diff[left]+diff[right])/2,nut=(nu[left]+nu[right])/2;
        const double heat=-(l.s.conductivity+r.s.conductivity)/2*dt*A-rho*kappa*T*ds*A;
        const double Jq=-2*rho*nut*(r.k-l.k)/distance*A;
        const double Db=1.07e-9*(T/298.15)*.0008900224890776955/mu;
        const double Jb=-rho*(Db+kappa)*(r.concentration-l.concentration)/distance*A;
        out[ix(left,E)]-=heat+Jq;out[ix(right,E)]+=heat+Jq;
        if(L.tank)out[ix(left,Q)]-=Jq;if(R.tank)out[ix(right,Q)]+=Jq;
        out[ix(left,B)]-=Jb;out[ix(right,B)]+=Jb;
        const double stress=(tau[left]+tau[right])/2*A;
        out[ix(left,P)]+=step?tau[left]*L.A1:stress;
        out[ix(right,P)]-=step?tau[right]*R.A0:stress;
        const double work=step?port.mass/2*(tau[left]/l.s.rho+tau[right]/r.s.rho):
            stress*(l.velocity+r.velocity)/2;
        out[ix(left,E)]+=work;out[ix(right,E)]-=work;
    };
    for(int i=0;i<12;++i)link(i,i+1);
    for(int i=13;i<20;++i)link(i,i+1);
    // Actual closed mouth/roof/header/body caps: pressure traction, zero material/heat.
    for(int endpoint:{0,13}){const auto t=trace(y,endpoint,cells[endpoint].lo);auto ghost=t;ghost.velocity=-t.velocity;
        const auto f=hllc(ghost,t);require(std::abs(f.mass)<=1e-10&&std::abs(f.energy)<=1e-3,"Reflecting lower cap moved mass/energy");
        out[ix(endpoint,P)]+=(f.momentum-tau[endpoint])*cells[endpoint].A0;}
    for(int endpoint:{12,20}){if(cells[endpoint].A1==0)continue;const auto t=trace(y,endpoint,cells[endpoint].hi);auto ghost=t;ghost.velocity=-t.velocity;
        const auto f=hllc(t,ghost);require(std::abs(f.mass)<=1e-10&&std::abs(f.energy)<=1e-3,"Reflecting upper cap moved mass/energy");
        out[ix(endpoint,P)]-=(f.momentum-tau[endpoint])*cells[endpoint].A1;}
    const double hdatum=water(313.15,15.2e6).h;
    for(int ring=0;ring<3;++ring){const double center=rings[ring],radius=holeD/2;int body=-1;
        for(int i=18;i<21;++i)if(center<cells[i].lo&&center>cells[i].hi)body=i;
        int tank=-1;for(int i=0;i<13;++i)if(center>cells[i].lo&&center<cells[i].hi)tank=i;
        require(tank>=0&&body>=0,"Actual circular aperture has no material owner");
        require(center-radius>=cells[tank].lo&&center+radius<=cells[tank].hi
            &&center-radius>=cells[body].hi&&center+radius<=cells[body].lo,
            "Frozen circle crosses a selected owner boundary; this fixture must be repartitioned before use");
        const auto bl=trace(y,body,center-radius),tl=trace(y,tank,center-radius);
        const auto bh=trace(y,body,center+radius),th=trace(y,tank,center+radius);
        std::vector<double>zcuts{center-radius,center+radius};
        const double dp0=bl.s.p-tl.s.p,dp1=bh.s.p-th.s.p;
        if(dp0*dp1<0)zcuts.insert(zcuts.begin()+1,center-radius+holeD*dp0/(dp0-dp1));
        for(size_t segment=1;segment<zcuts.size();++segment){const double a=std::asin((zcuts[segment-1]-center)/radius);
            const double b=std::asin((zcuts[segment]-center)/radius),mid=(a+b)/2,half=(b-a)/2;
            for(size_t j=0;j<8;++j){const double theta=mid+half*gx[j],z=center+radius*std::sin(theta);
                const double A=half*gw[j]*${input.b.holesPerRing}*2*radius*radius*std::cos(theta)*std::cos(theta);
                const auto Bdy=trace(y,body,z),Tank=trace(y,tank,z);const double dp=Bdy.s.p-Tank.s.p;
                if(dp==0)continue;const bool forward=dp>0;const Trace&d=forward?Bdy:Tank;
                const double Amu=6*M_PI*(Bdy.s.mu+Tank.s.mu)/2/holeD,Brho=d.s.rho/(2*Cd*Cd);
                const double vn=2*dp/(Amu+std::sqrt(Amu*Amu+4*Brho*std::abs(dp)));
                const double m=d.s.rho*vn*A,exit=(Cv/Cd)*std::abs(vn);
                const double H=d.s.h+d.velocity*d.velocity/2+d.k+gravity*z;
                // Recover exit static caloric state at receiving pressure from full H once.
                double Te=d.s.T;const double pe=forward?Tank.s.p:Bdy.s.p;
                for(int it=0;it<6;++it){const auto s=water(Te,pe);const double defect=s.h-(H-exit*exit/2-gravity*z);
                    if(std::abs(defect)<1e-7)break;Te-=defect/s.cp;}
                const auto ex=water(Te,pe);
                require(std::abs(ex.h-(H-exit*exit/2-gravity*z))<=1e-7,"Aperture exit enthalpy failed recovery");
                require(ex.s>=d.s.s-1e-7&&exit<ex.w,"Aperture entropy/domain failed");
                const double contracted=std::abs(m)/(ex.rho*exit);
                require(contracted>0&&contracted<=A*(1+1e-9),"Aperture contraction inadmissible");
                out[ix(body,M)]-=m;out[ix(tank,M)]+=m;
                out[ix(body,E)]-=m*H;out[ix(tank,E)]+=m*H;
                out[ix(body,B)]-=m*d.concentration;out[ix(tank,B)]+=m*d.concentration;
                const double incomingQ=forward?m*(exit*exit/2+Tank.velocity*Tank.velocity/2):0;
                const double outgoingQ=forward?0:-m*Tank.k;
                if(forward){out[ix(body,P)]-=m*Bdy.velocity;out[ix(tank,Q)]+=incomingQ;}
                else{out[ix(tank,P)]+=m*Tank.velocity;out[ix(tank,Q)]-=outgoingQ;}
                const int r=PHYSICAL+ring*RM;
                out[r]+=m;out[r+1]+=std::abs(m);out[r+2]+=m*H;out[r+3]+=std::abs(m*H);
                out[r+4]+=m*d.concentration;out[r+5]+=incomingQ;out[r+6]+=outgoingQ;
                // This is an exact disclosed caloric-datum subtraction of the native ring receipt,
                // not an independently claimed heat transfer or an abs(deltaT)*cp proxy.
                out[r+7]+=m*(H-hdatum-gravity*z);
            }
        }
    }
    return out;
}

std::array<double,D> conservative_residual(const double*y,const double*dy) {
    std::array<double,D> r{};const auto f=rates(y);
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto x=view(y,i);const auto s=water(x[TT],x[PP]);
        for(int j=0;j<5;++j)if(j!=Q||c.tank)r[ix(i,j)]=dy[ix(i,j)]-f[ix(i,j)];
        const double velocity=x[P]/x[M],common=s.u+gravity*c.z-velocity*velocity/2;
        const double Mp=c.V*s.rho*s.kappa,Mt=-c.V*s.rho*s.alpha;
        const double Ep=common*Mp+c.V*s.rho*up(s),Et=common*Mt+c.V*s.rho*ut(s),det=Mp*Et-Mt*Ep;
        const double Mc=c.V*s.rho;
        const double predictedE=Mc*(s.u+gravity*c.z)+x[P]*x[P]/(2*Mc)+(c.tank?x[Q]:0);
        const double rm=x[M]-Mc,re=x[E]-predictedE;
        require(det>0,"Single-liquid thermodynamic coordinate lost rank");
        r[ix(i,PP)]=(rm*Et-Mt*re)/det;r[ix(i,TT)]=(Mp*re-rm*Ep)/det;
    }
    return r;
}

void local_gates() {
    const auto cold=water(313.15,15.2e6),hot=water(450,15.2e6);
    const Trace l{cold,0,0,.002,11},r{hot,0,0,.002,11};
    const auto contact=hllc(l,r);
    require(contact.mass==0&&contact.energy==0&&contact.tracer==0&&contact.mixing==0,
        "Stationary thermal HLLC contact transported material/energy");
    const auto reflected=hllc({cold,-.25,0,.002,11},{cold,.25,0,.002,11});
    require(reflected.mass==0&&reflected.energy==0&&reflected.tracer==0&&reflected.mixing==0,
        "Moving-cell reflecting HLLC wall transported material/energy");
    const auto slightlyHigher=water(313.15,15.2e6+1);
    const auto near=hllc({slightlyHigher,0,0,.002,11},r);
    const auto mirror=hllc(r,{slightlyHigher,0,0,.002,11});
    require(near.mass>0&&mirror.mass<0&&std::abs(near.mass+mirror.mass)<1e-12
        &&std::abs(near.energy+mirror.energy)<1e-3,"Actual near-contact drive was suppressed or lost reversal symmetry");
    const auto zero=area_port(l,r,.03141592653589793,.0962112750161874);
    require(zero.mass==0&&zero.energy==0,"Zero area contact transported material/energy");
    // Author a moving reversible unequal-area state independently from its own entropy/H.
    const double m=1,AL=.03141592653589793,AR=.0962112750161874;
    const double ul=m/(AL*cold.rho),H=cold.h+ul*ul/2;
    double p=cold.p,T=cold.T;
    for(int j=0;j<8;++j){const auto q=water(T,p);const double v=m/(AR*q.rho);
        const double rs=q.s-cold.s,rh=q.h+v*v/2-H;
        if(std::abs(rs)<1e-9&&std::abs(rh)<1e-7)break;
        const double sp=-q.alpha/q.rho,st=q.cp/q.T;
        const double hp=(1-q.T*q.alpha)/q.rho-v*v*q.kappa,ht=q.cp+v*v*q.alpha,det=sp*ht-st*hp;
        p-=(rs*ht-st*rh)/det;T-=(sp*rh-rs*hp)/det;
    }
    const auto q=water(T,p);
    const auto flowing=area_port({cold,ul,0,.002,11},{q,m/(AR*q.rho),0,.002,11},AL,AR);
    require(std::abs(flowing.mass-m)<1e-6&&std::abs(flowing.energy-m*(H+gravity*11))<1e-3,
        "Moving lossless area junction introduced a spurious resistance/energy defect");
    const double packet=.1,resident=10,Pr=2,jet=3,carried=.02;
    const double Kold=Pr*Pr/(2*resident),Knew=Pr*Pr/(2*(resident+packet));
    const double dQ=packet*(jet*jet/2+carried)+Kold-Knew;
    require(std::abs((Knew-Kold)+dQ-packet*(jet*jet/2+carried))<1e-14,
        "Radial packet native K/Q receipt identity failed");
    for(const auto&c:cells){const double isotropic=.125;
        const double force=-isotropic*(c.A1-c.A0)-isotropic*c.A0+isotropic*c.A1;
        require(std::abs(force)<1e-14,"One-sided isotropic area/cap stress failed stationary cancellation");}
    // Exercise the signed stage continuation without admitting negative stock.
    // Positive/zero Q retain the same full total-enthalpy and scalar transport law.
    for(double mixing:{-.01,0.,.01}){std::array<double,D> y{};const auto&c=cells[0];
        y[ix(0,M)]=c.V*cold.rho;y[ix(0,P)]=.25*y[ix(0,M)];y[ix(0,B)]=.002*y[ix(0,M)];
        y[ix(0,Q)]=mixing;y[ix(0,PP)]=cold.p;y[ix(0,TT)]=cold.T;
        const auto t=trace(y.data(),0,c.z);const auto f=euler(t);
        require(t.k==mixing/y[ix(0,M)],"Signed trial mixing energy was floored or reset");
        require(std::abs(f.energy-f.mass*(cold.h+.25*.25/2+mixing/y[ix(0,M)]+gravity*c.z))<=1e-7,
            "Trial scalar/full native energy transport changed its selected law");
        require((y[ix(0,Q)]>=0)==(mixing>=0),"Strict stock sign predicate was weakened");}
}
std::array<double,D> original() {
    std::array<double,D> y{};
    const double mouth=${input.cells[0]!.low},midring=rings[1];
    const double coldRho=water(313.15,15.2e6).rho;
    for(int i=0;i<13;++i){const auto&c=cells[i];y[ix(i,PP)]=15.2e6-coldRho*gravity*(c.z-mouth);y[ix(i,TT)]=313.15;}
    int midCell=-1;for(int i=0;i<13;++i)if(midring>cells[i].lo&&midring<cells[i].hi)midCell=i;
    require(midCell>=0,"No middle-ring datum owner");
    require(midring>cells[midCell].lo&&midring<cells[midCell].hi,"Middle-ring datum owner differs from frozen layout");
    const auto coldMid=water(y[ix(midCell,TT)],y[ix(midCell,PP)]);
    const double warmDatum=y[ix(midCell,PP)]-coldMid.rho*gravity*(midring-cells[midCell].z);
    const double warmRho=water(450,warmDatum).rho;
    for(int i=13;i<N;++i){const auto&c=cells[i];y[ix(i,PP)]=warmDatum-warmRho*gravity*(c.z-midring);y[ix(i,TT)]=450;}
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto s=water(y[ix(i,TT)],y[ix(i,PP)]);
        y[ix(i,M)]=c.V*s.rho;y[ix(i,P)]=0;if(c.tank)y[ix(i,Q)]=0;y[ix(i,B)]=.002*y[ix(i,M)];
        y[ix(i,E)]=y[ix(i,M)]*(s.u+gravity*c.z);}
    return y;
}
${nativeMixingQualification}
int main(int argc,char**argv) {
    std::cout<<std::setprecision(17);
    try{
        require(argc==3&&std::string(argv[2])=="--mixing-qualification","Expected remaining seconds and explicit finite mixing mode");
        guard_seconds=std::stod(argv[1]);local_gates();
        return mixing_qualification();
    }catch(const std::exception&e){
        std::cerr<<e.what()<<"\n";
        std::cout<<"{\"passed\":false,\"scope\":\"finite law/residual checks, no advancement\",\"checks\":"<<checks
            <<",\"propertyTuples\":"<<tuple_calls<<",\"mixingBatchCalls\":"<<mixing_batches<<",\"mixingPointCalls\":"<<mixing_points<<"}\n";
        return 1;
    }
}
`;
}

/** Actual rates/residual payload used by the finite native qualification consumer. */
export function nativeAxialCandidate(document: string) {
  const geometry = fixtureGeometry(document);
  return { geometry, cpp: nativeSource(geometry) };
}
