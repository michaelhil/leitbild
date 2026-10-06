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
export function ownedStockLayout(receiving: readonly boolean[]) {
  const expanded = ownedAxialLayout(receiving);
  const coordinates = expanded.coordinates.filter(c => c.field !== 'PP' && c.field !== 'TT');
  const indices = receiving.map((_, cell) => axialFields.map(field => {
    const index = coordinates.findIndex(c => c.cell === cell && c.field === field);
    return index < 0 ? null : index;
  }));
  return { indices, coordinates, coordinateCount: coordinates.length };
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
  const stocks = ownedStockLayout(input.cells.map(c => c.tank));
  const links = input.cells.flatMap((c, i) => i + 1 < input.cells.length
    && c.tank === input.cells[i + 1]!.tank ? [{ left: i, right: i + 1 }] : []);
  const ringOwners = input.b.ringElevations_m.map(z => ({
    tank: input.cells.findIndex(c => c.tank && z > c.low && z < c.high),
    body: input.cells.findIndex(c => !c.tank && z < c.low && z > c.high),
  }));
  if (ringOwners.some(pair => pair.tank < 0 || pair.body < 0))
    throw Error('Actual aperture lacks receiving and distributor owner');
  const kernelCpp = String.raw`
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
struct CellLink {int left,right;};
const std::array<CellLink,${links.length}> chainLinks{{${links.map(l => `{${l.left},${l.right}}`).join(',')}}};
const std::array<CellLink,3> ringOwners{{${ringOwners.map(l => `{${l.body},${l.tank}}`).join(',')}}};
constexpr int Q_COLUMNS=${layout.coordinates.filter(c => c.field === 'Q').length};
const std::array<int,N> qColumn{{${input.cells.map((c, i) => c.tank
    ? input.cells.slice(0, i).filter(c => c.tank).length : -1).join(',')}}};
using RateQJacobian=std::array<std::array<double,Q_COLUMNS>,D>;
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
CellLink gradient_neighbors(int i){
    int a=i,b=i;
    for(const auto&link:chainLinks){if(link.right==i&&std::abs(cells[link.left].A1-cells[i].A0)<=1e-12)a=link.left;
        if(link.left==i&&std::abs(cells[i].A1-cells[link.right].A0)<=1e-12)b=link.right;}
    return {a,b};
}
SmoothGradients local_reconstructed_gradients(const double*y,const State&s,int i){
    const auto&c=cells[i];
    // Existing fixed-T static trace, not an invented adiabatic compression column.
    const double vertical=-y[ix(i,M)]/c.V*gravity;
    return {vertical,s.rho*s.kappa*vertical,0,i,i,true};
}
SmoothGradients smooth_gradients(const double*y,const std::array<State,N>&state,const std::array<double,N>&velocity,int i){
    const auto&c=cells[i];const auto neighbors=gradient_neighbors(i);const int a=neighbors.left,b=neighbors.right;
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

std::array<double,SAMPLE> rates(const double* y,RateQJacobian* qJacobian=nullptr,const std::array<State,N>* recovered=nullptr) {
    // The appended rates are read-only observations, NEVER solver coordinates.
    std::array<double,SAMPLE> out{};
    std::array<State,N> state;std::array<double,N> velocity{},k{},nu{},diff{},tau{},tauPerp{};
    std::array<double,N> nuQ{},diffQ{},tauQ{},tauPerpQ{};
    if(qJacobian)*qJacobian={};
    auto addQ=[&](int row,int cell,double value){if(qJacobian&&cells[cell].tank)(*qJacobian)[row][qColumn[cell]]+=value;};
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto x=view(y,i);
        require(x[M]>0&&x[B]>=0&&(!c.tank||std::isfinite(x[Q])),"Invalid numerical trial native stock");
        state[i]=recovered?(*recovered)[i]:water(x[TT],x[PP]);velocity[i]=x[P]/x[M];k[i]=c.tank?x[Q]/x[M]:0;
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
            if(qJacobian&&c.tank){require(coefficient.derivativesAvailable==1,"Coupled Q tangent unavailable at selected mixing length/domain tie");
                const double scale=node.weight/y[ix(i,M)];
                nuQ[i]+=scale*coefficient.derivatives[0][2];diffQ[i]+=scale*coefficient.derivatives[1][2];
                tauQ[i]+=scale*coefficient.derivatives[5][2];tauPerpQ[i]+=scale*coefficient.derivatives[6][2];
                addQ(ix(i,Q),i,scale*coefficient.derivatives[7][2]*c.V);}
            tau[i]+=node.weight*r[5];tauPerp[i]+=node.weight*r[6];}
        if(c.tank&&k[i]==0&&available)localRightQSourceSlope[i]=rightSlope;
        if(c.tank)out[ix(i,Q)]+=sourceQ*c.V;
        out[ix(i,P)]-=tauPerp[i]*(c.A1-c.A0);
        addQ(ix(i,P),i,-tauPerpQ[i]*(c.A1-c.A0));
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
        // At fixed native p/T/M/P, HLLC/area mass and traction do not depend on Q.
        // Their donor energy and mixing transport are the same exact linear receipt.
        const int donor=port.mass>=0?left:right;
        if(cells[donor].tank){const double derivative=port.mass/y[ix(donor,M)];
            addQ(ix(left,E),donor,-derivative);addQ(ix(right,E),donor,derivative);
            if(L.tank)addQ(ix(left,Q),donor,-derivative);if(R.tank)addQ(ix(right,Q),donor,derivative);}
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
        for(int owner:{left,right})if(cells[owner].tank){
            const double dnut=nuQ[owner]/2,dkappa=diffQ[owner]/2;
            const double dJump=(owner==right?1:-1)/y[ix(owner,M)];
            const double dHeat=-rho*dkappa*T*ds*A;
            const double dJq=-2*rho*(dnut*(r.k-l.k)+nut*dJump)/distance*A;
            const double dJb=-rho*dkappa*(r.concentration-l.concentration)/distance*A;
            addQ(ix(left,E),owner,-dHeat-dJq);addQ(ix(right,E),owner,dHeat+dJq);
            if(L.tank)addQ(ix(left,Q),owner,-dJq);if(R.tank)addQ(ix(right,Q),owner,dJq);
            addQ(ix(left,B),owner,-dJb);addQ(ix(right,B),owner,dJb);
            if(step){if(owner==left)addQ(ix(left,P),owner,tauQ[left]*L.A1);
                if(owner==right)addQ(ix(right,P),owner,-tauQ[right]*R.A0);}
            else{const double dStress=tauQ[owner]/2*A;addQ(ix(left,P),owner,dStress);addQ(ix(right,P),owner,-dStress);}
            const double dWork=step?port.mass/2*tauQ[owner]/(owner==left?l.s.rho:r.s.rho):
                tauQ[owner]/2*A*(l.velocity+r.velocity)/2;
            addQ(ix(left,E),owner,dWork);addQ(ix(right,E),owner,-dWork);
        }
    };
    for(const auto&pair:chainLinks)link(pair.left,pair.right);
    // Actual closed mouth/roof/header/body caps: pressure traction, zero material/heat.
    for(int endpoint:{0,13}){const auto t=trace(y,endpoint,cells[endpoint].lo);auto ghost=t;ghost.velocity=-t.velocity;
        const auto f=hllc(ghost,t);require(std::abs(f.mass)<=1e-10&&std::abs(f.energy)<=1e-3,"Reflecting lower cap moved mass/energy");
        out[ix(endpoint,P)]+=(f.momentum-tau[endpoint])*cells[endpoint].A0;
        addQ(ix(endpoint,P),endpoint,-tauQ[endpoint]*cells[endpoint].A0);}
    for(int endpoint:{12,20}){if(cells[endpoint].A1==0)continue;const auto t=trace(y,endpoint,cells[endpoint].hi);auto ghost=t;ghost.velocity=-t.velocity;
        const auto f=hllc(t,ghost);require(std::abs(f.mass)<=1e-10&&std::abs(f.energy)<=1e-3,"Reflecting upper cap moved mass/energy");
        out[ix(endpoint,P)]-=(f.momentum-tau[endpoint])*cells[endpoint].A1;
        addQ(ix(endpoint,P),endpoint,tauQ[endpoint]*cells[endpoint].A1);}
    const double hdatum=water(313.15,15.2e6).h;
    for(int ring=0;ring<3;++ring){const double center=rings[ring],radius=holeD/2;int body=-1;
        body=ringOwners[ring].left;const int tank=ringOwners[ring].right;
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
                const int donor=forward?body:tank;
                if(cells[donor].tank){addQ(ix(body,E),donor,-m/y[ix(donor,M)]);addQ(ix(tank,E),donor,m/y[ix(donor,M)]);}
                out[ix(body,B)]-=m*d.concentration;out[ix(tank,B)]+=m*d.concentration;
                const double incomingQ=forward?m*(exit*exit/2+Tank.velocity*Tank.velocity/2):0;
                const double outgoingQ=forward?0:-m*Tank.k;
                if(forward){out[ix(body,P)]-=m*Bdy.velocity;out[ix(tank,Q)]+=incomingQ;}
                else{out[ix(tank,P)]+=m*Tank.velocity;out[ix(tank,Q)]-=outgoingQ;
                    addQ(ix(tank,Q),tank,m/y[ix(tank,M)]);}
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

std::array<double,D> native_chart_defects(const double*y,const std::array<State,N>* recovered=nullptr) {
    std::array<double,D> r{};
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto x=view(y,i);const auto s=recovered?(*recovered)[i]:water(x[TT],x[PP]);
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
std::array<double,D> conservative_residual(const double*y,const double*dy) {
    auto r=native_chart_defects(y);const auto f=rates(y);
    for(int i=0;i<N;++i){const auto&c=cells[i];
        for(int j=0;j<5;++j)if(j!=Q||c.tank)r[ix(i,j)]=dy[ix(i,j)]-f[ix(i,j)];}
    return r;
}

// One declared approximate Newton matrix of the ACTUAL residual. Differential
// non-Q columns use structural coloring and finite SI probes; Q columns use the
// local Rust partials and same-consumer linear receipts above. Storage rows use
// the actual current inverse chart frozen during linearization. This omits the
// derivative of that inverse multiplying a nonzero off-manifold storage defect;
// it is exact at the coherent root, not an exact Jacobian claim away from it.
struct CoupledJacobian {
    std::array<double,D*D> dense{};
    std::vector<int> rowOffsets,columnIndices;
    std::vector<double> values;
    size_t colors=0,rateEvaluations=0;
};
struct RateIncidence {
    std::array<std::array<bool,D>,D> entry{};
    std::vector<std::vector<int>> colors;
};
const RateIncidence& rate_incidence(){
    static const RateIncidence pattern=[](){RateIncidence p;
        auto contribution=[&](const std::vector<int>&recipients,const std::vector<int>&inputs){
            for(int receiver:recipients)for(int field=0;field<5;++field)if(field!=Q||cells[receiver].tank){
                const int row=ix(receiver,field);
                for(int owner:inputs)for(int inputField:{M,P,B,PP,TT})
                    if(inputField!=B||field==B)p.entry[row][ix(owner,inputField)]=true;
            }
        };
        auto mixing_inputs=[](int i){const auto neighbor=gradient_neighbors(i);return std::vector<int>{i,neighbor.left,neighbor.right};};
        for(int i=0;i<N;++i)contribution({i},mixing_inputs(i));
        for(const auto&link:chainLinks){auto inputs=mixing_inputs(link.left);const auto right=mixing_inputs(link.right);
            inputs.insert(inputs.end(),right.begin(),right.end());contribution({link.left,link.right},inputs);}
        for(const auto&pair:ringOwners)contribution({pair.left,pair.right},{pair.left,pair.right});
        for(int column=0;column<D;++column){bool present=false;
            for(int row=0;row<D;++row)present=present||p.entry[row][column];if(!present)continue;
            size_t color=0;
            for(;color<p.colors.size();++color){bool conflict=false;
                for(int other:p.colors[color])for(int row=0;row<D;++row)
                    conflict=conflict||(p.entry[row][column]&&p.entry[row][other]);
                if(!conflict)break;
            }
            if(color==p.colors.size())p.colors.emplace_back();p.colors[color].push_back(column);
        }
        return p;
    }();return pattern;
}
std::array<double,D> rate_probe_steps(const double*y,double scale){
    require(std::isfinite(scale)&&scale>0,"Invalid declared rate probe scale");std::array<double,D> step{};
    for(int column=0;column<D;++column){const auto owner=coordinateOwner[column];const double mass=y[ix(owner.cell,M)];
        switch(owner.field){
            case M:step[column]=mass*1e-6*scale;break;
            case P:step[column]=mass*1e-6*scale;break; // physical 1 micrometre/s increment
            case B:step[column]=std::max(std::abs(y[column]),mass*.002)*1e-6*scale;break;
            case PP:step[column]=1.*scale;break; // 1 Pa, not relative to absolute-pressure datum
            case TT:step[column]=1e-4*scale;break;
            default:break; // E is absent from rates; Q is analytic, never caloric-datum differenced.
        }
    }return step;
}
CoupledJacobian coupled_jacobian(const double*y,double cj,double probeScale=1){
    require(std::isfinite(cj),"Invalid current DAE derivative coefficient");CoupledJacobian J;
    const auto&pattern=rate_incidence();const auto step=rate_probe_steps(y,probeScale);
    RateQJacobian QJ{};(void)rates(y,&QJ);++J.rateEvaluations;
    J.colors=pattern.colors.size();
    for(const auto&group:pattern.colors){std::array<double,D> plus{},minus{};
        std::copy(y,y+D,plus.begin());std::copy(y,y+D,minus.begin());
        for(int column:group){plus[column]+=step[column];
            // Actual zero tracer has a right domain; do not manufacture negative B.
            const bool right=coordinateOwner[column].field==B&&y[column]<step[column];
            if(!right)minus[column]-=step[column];
            require(plus[column]!=y[column]&&(right||minus[column]!=y[column]),"Native finite rate probe not representable");}
        const auto fp=rates(plus.data()),fm=rates(minus.data());J.rateEvaluations+=2;
        for(int column:group)for(int row=0;row<D;++row)if(pattern.entry[row][column])
            J.dense[row*D+column]=-(fp[row]-fm[row])/(plus[column]-minus[column]);
    }
    for(int row=0;row<D;++row)for(int i=0;i<N;++i)if(cells[i].tank)
        J.dense[row*D+ix(i,Q)]=-QJ[row][qColumn[i]];
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto x=view(y,i);const auto s=water(x[TT],x[PP]);
        for(int field=0;field<5;++field)if(field!=Q||c.tank)J.dense[ix(i,field)*D+ix(i,field)]+=cj;
        const double velocity=x[P]/x[M],common=s.u+gravity*c.z-velocity*velocity/2;
        const double Mp=c.V*s.rho*s.kappa,Mt=-c.V*s.rho*s.alpha;
        const double Ep=common*Mp+c.V*s.rho*up(s),Et=common*Mt+c.V*s.rho*ut(s),det=Mp*Et-Mt*Ep;
        require(det>0,"Approximate Newton storage chart lost rank");
        const double Mc=c.V*s.rho,chartCommon=s.u+gravity*c.z-x[P]*x[P]/(2*Mc*Mc);
        const double predictedEp=chartCommon*Mp+Mc*up(s),predictedEt=chartCommon*Mt+Mc*ut(s);
        auto entry=[&](int field,double dMass,double dEnergy){
            J.dense[ix(i,PP)*D+ix(i,field)]=(dMass*Et-Mt*dEnergy)/det;
            J.dense[ix(i,TT)*D+ix(i,field)]=(Mp*dEnergy-dMass*Ep)/det;
        };
        entry(M,1,0);entry(P,0,-x[P]/Mc);entry(E,0,1);if(c.tank)entry(Q,0,-1);
        entry(PP,-Mp,-predictedEp);entry(TT,-Mt,-predictedEt);
    }
    J.rowOffsets.push_back(0);
    for(int row=0;row<D;++row){for(int column=0;column<D;++column){const double value=J.dense[row*D+column];
        require(std::isfinite(value),"Nonfinite coupled approximate Newton entry");
        const auto receiver=coordinateOwner[row],input=coordinateOwner[column];
        const bool differential=receiver.field<PP;
        // Retain a fixed structural superset, including currently zero coefficients.
        // A sparse consumer may reuse symbolic factorization as flow/Q turn on.
        const bool structural=pattern.entry[row][column]||(differential&&row==column)
            ||(differential&&input.field==Q&&pattern.entry[row][ix(input.cell,M)])
            ||(!differential&&receiver.cell==input.cell&&input.field!=B);
        require(value==0||structural,"Coupled matrix entry escaped its structural incidence");
        if(structural){J.columnIndices.push_back(column);J.values.push_back(value);}}
        J.rowOffsets.push_back(static_cast<int>(J.values.size()));}
    return J;
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

struct CoupledOperatorMetrics {
    size_t snapshots=0,colors=0,rateEvaluations=0,nonzeroEntries=0;
    double maximumQEnergyConservationDefect=0,maximumQTracerConservationDefect=0;
    double maximumFullHalfRelativeDifference=0,maximumDirectionalBudgetFraction=0;
};
CoupledOperatorMetrics coupled_operator_gates(){
    CoupledOperatorMetrics result;
    std::vector<int> frozenRows,frozenColumns;
    const auto&pattern=rate_incidence();
    for(const auto&group:pattern.colors)for(size_t a=0;a<group.size();++a)for(size_t b=a+1;b<group.size();++b)
        for(int row=0;row<D;++row)require(!(pattern.entry[row][group[a]]&&pattern.entry[row][group[b]]),
            "Graph color aliases two actual differential dependencies");
    const auto prepared=original();
    for(int sample=0;sample<3;++sample){auto y=prepared;
        if(sample){const double direction=sample==1?1:-1;
            for(int i=0;i<N;++i){const auto&c=cells[i];
                y[ix(i,PP)]+=direction*500*(i%3-1);y[ix(i,TT)]+=.01*(i%2);
                const auto s=water(y[ix(i,TT)],y[ix(i,PP)]);y[ix(i,M)]=c.V*s.rho;
                y[ix(i,P)]=direction*.03*y[ix(i,M)];y[ix(i,B)]=.002*y[ix(i,M)];
                if(c.tank)y[ix(i,Q)]=1e-5*y[ix(i,M)];
                y[ix(i,E)]=y[ix(i,M)]*(s.u+gravity*c.z)+y[ix(i,P)]*y[ix(i,P)]/(2*y[ix(i,M)])+(c.tank?y[ix(i,Q)]:0);
            }
        }
        const auto J=coupled_jacobian(y.data(),2),half=coupled_jacobian(y.data(),2,.5);
        ++result.snapshots;result.colors=J.colors;result.rateEvaluations+=J.rateEvaluations+half.rateEvaluations;
        result.nonzeroEntries=std::max(result.nonzeroEntries,J.values.size());
        require(J.rateEvaluations<2*(D-Q_COLUMNS-N)+1,
            "Structural coloring did not reduce the actual non-Q/non-E per-column probe count");
        require(J.rowOffsets.size()==D+1&&J.values.size()==J.columnIndices.size(),"Incomplete sparse approximate Newton matrix");
        if(!sample){frozenRows=J.rowOffsets;frozenColumns=J.columnIndices;}
        else require(J.rowOffsets==frozenRows&&J.columnIndices==frozenColumns,
            "Flow/Q activation changed the declared fixed sparse symbolic structure");
        for(int row=0;row<D;++row)for(int index=J.rowOffsets[row];index<J.rowOffsets[row+1];++index)
            require(J.dense[row*D+J.columnIndices[index]]==J.values[index],"Sparse/dense matrix bridge disagrees");
        auto changedE=y;for(int i=0;i<N;++i)changedE[ix(i,E)]+=1e5;
        require(rates(y.data())==rates(changedE.data()),"Actual rates acquired an E dependency outside the declared explicit p/T chart");
        result.rateEvaluations+=2;
        for(int i=0;i<N;++i){const int pr=ix(i,PP),tr=ix(i,TT),ec=ix(i,E);
            require(std::abs(J.dense[pr*D+pr]+1)<1e-10&&std::abs(J.dense[tr*D+tr]+1)<1e-10,
                "Coherent frozen native chart did not recover its pressure/temperature identity");
            if(cells[i].tank){const int qc=ix(i,Q);
                require(J.dense[pr*D+qc]!=0&&J.dense[tr*D+qc]!=0,
                    "Q-to-storage column disappeared under absolute caloric datum roundoff");
                require(J.dense[pr*D+qc]==-J.dense[pr*D+ec]&&J.dense[tr*D+qc]==-J.dense[tr*D+ec],
                    "Exact native storage E/Q sign and recipient identity failed");
                double sumE=0,sumB=0,scaleE=0,scaleB=0;
                for(int owner=0;owner<N;++owner){sumE+=J.dense[ix(owner,E)*D+qc];sumB+=J.dense[ix(owner,B)*D+qc];
                    scaleE+=std::abs(J.dense[ix(owner,E)*D+qc]);scaleB+=std::abs(J.dense[ix(owner,B)*D+qc]);}
                result.maximumQEnergyConservationDefect=std::max(result.maximumQEnergyConservationDefect,std::abs(sumE));
                result.maximumQTracerConservationDefect=std::max(result.maximumQTracerConservationDefect,std::abs(sumB));
                require(std::abs(sumE)<=1e-12*std::max(scaleE,1e-20)&&std::abs(sumB)<=1e-12*std::max(scaleB,1e-20),
                    "Same-consumer analytic Q-column failed paired total energy/tracer transport");
            }
        }
        for(int row=0;row<D;++row)for(int column=0;column<D;++column){const auto owner=coordinateOwner[row];
            if(owner.field>=PP)continue;const double a=J.dense[row*D+column],b=half.dense[row*D+column];
            const double scale=std::max(std::abs(a),std::abs(b));
            if(scale>1e-8)result.maximumFullHalfRelativeDifference=std::max(result.maximumFullHalfRelativeDifference,std::abs(a-b)/scale);
        }
        if(sample){
            const auto steps=rate_probe_steps(y.data(),.1);std::array<double,D> direction{},plus=y,minus=y;
            for(int column=0;column<D;++column){const auto owner=coordinateOwner[column];
                direction[column]=steps[column]*(column%2?1:-1);
                if(owner.field==Q)direction[column]=y[ix(owner.cell,M)]*1e-8*(column%2?1:-1);
                plus[column]+=direction[column];minus[column]-=direction[column];}
            const auto fp=rates(plus.data()),fm=rates(minus.data());result.rateEvaluations+=2;
            for(int row=0;row<D;++row){const auto owner=coordinateOwner[row];if(owner.field>=PP)continue;
                double predicted=0;for(int column=0;column<D;++column)
                    predicted+=-2*(J.dense[row*D+column]-(row==column?2:0))*direction[column];
                const double actual=fp[row]-fm[row];
                // Qualification of a declared approximate matrix, NOT relaxation of
                // nonlinear/physical or temporal admission. The original zero/contact
                // branch is tested separately above, not called globally smooth here.
                const double roundoff=2e-9*std::max({std::abs(fp[row]),std::abs(fm[row]),1e-12});
                const double budget=.1*std::max(std::abs(predicted),std::abs(actual))+roundoff;
                const double fraction=std::abs(predicted-actual)/budget;
                result.maximumDirectionalBudgetFraction=std::max(result.maximumDirectionalBudgetFraction,fraction);
                require(fraction<=1,"Complete approximate rate matrix failed resolved changed-state directional increment");
            }
            // Isolate the Q column; large acoustic/advective increments must not
            // conceal a missing Q-to-momentum, diffusion, or local source term.
            plus=y;minus=y;direction.fill(0);
            for(int i=0;i<N;++i)if(cells[i].tank){const int column=ix(i,Q);
                direction[column]=y[ix(i,Q)]*.01*(i%2?1:-1);
                plus[column]+=direction[column];minus[column]-=direction[column];}
            const auto qPlus=rates(plus.data()),qMinus=rates(minus.data());result.rateEvaluations+=2;
            for(int row=0;row<D;++row){const auto owner=coordinateOwner[row];if(owner.field>=PP)continue;
                double predicted=0;for(int i=0;i<N;++i)if(cells[i].tank){const int column=ix(i,Q);
                    predicted+=-2*(J.dense[row*D+column]-(row==column?2:0))*direction[column];}
                const double actual=qPlus[row]-qMinus[row];
                const double pressureRoundoff=owner.field==P?100*std::numeric_limits<double>::epsilon()
                    *y[ix(owner.cell,PP)]*std::max(cells[owner.cell].A0,cells[owner.cell].A1):0;
                const double roundoff=pressureRoundoff+1000*std::numeric_limits<double>::epsilon()
                    *std::max({std::abs(qPlus[row]),std::abs(qMinus[row]),1e-12});
                const double budget=.01*std::max(std::abs(predicted),std::abs(actual))+roundoff;
                const double fraction=std::abs(predicted-actual)/budget;
                result.maximumDirectionalBudgetFraction=std::max(result.maximumDirectionalBudgetFraction,fraction);
                require(fraction<=1,"Isolated same-consumer Q column failed resolved directional increment");
            }
        }
        // Off-manifold chart is deliberately frozen, not differentiated as though
        // its inverse prefactor were constant in the nonlinear residual itself.
        auto off=y;off[ix(0,M)]*=1+1e-6;off[ix(0,E)]+=100;
        const auto offJ=coupled_jacobian(off.data(),2);result.rateEvaluations+=offJ.rateEvaluations;
        const auto offRates=rates(off.data());const auto offResidual=conservative_residual(off.data(),offRates.data());
        result.rateEvaluations+=2;
        require(offResidual[ix(0,PP)]!=0||offResidual[ix(0,TT)]!=0,"Off-manifold qualification was silently made coherent");
    }
    return result;
}
`;
  const stockKernelCpp = kernelCpp + String.raw`
#include <cstring>
// Solver stocks and derived observation/partial coordinates are different records.
constexpr int STOCKS=${stocks.coordinateCount},STOCK_SAMPLE=STOCKS+OBSERVERS;
const std::array<std::array<int,S>,N> stockIndex{{${stocks.indices.map(indices =>
    `{${indices.map(index => index ?? -1).join(',')}}`).join(',')}}};
const std::array<CoordinateOwner,STOCKS> stockOwner{{${stocks.coordinates.map(c =>
    `{${c.cell},${axialFields.indexOf(c.field)}}`).join(',')}}};
int sx(int cell,int field){const int index=stockIndex.at(cell).at(field);
    if(index<0)throw std::logic_error("Attempt to address a derived or unowned stock");return index;}
struct RustLiquidQuery {double temperature,pressure;};
struct RustLiquid {double pressure,temperature,density,internalEnergy,enthalpy,entropy,cp,cv,
    soundSpeed,expansion,compressibility,viscosity,conductivity;};
struct RustCellGeometry {double volume,elevation;};
struct RustStorage {double mass,momentum,energy,mixingEnergy;};
struct RustStorageJacobian {double Mp,Mt,Ep,Et,v;};
struct RustChartAccuracy {double pressure,temperature;size_t iterations;};
struct RustTrialLiquidInput {RustCellGeometry geometry;RustStorage target;RustLiquidQuery guess;RustChartAccuracy accuracy;};
struct RustRecoveredLiquid {RustLiquid liquid;RustStorageJacobian chart;double pressureDefect,temperatureDefect;size_t iterations;};
static_assert(sizeof(RustLiquid)==13*sizeof(double)&&sizeof(RustTrialLiquidInput)==88&&sizeof(RustRecoveredLiquid)==168,
    "Rust recovery POD layout differs from the compiled 64-bit ABI");
extern "C" int leitbild_recover_trial_liquid_batch(const RustTrialLiquidInput*,RustRecoveredLiquid*,size_t,size_t*,char*,size_t);
// Rust storage/recovery uses THIS consumer's actual counted property authority.
extern "C" int leitbild_liquid_batch(const RustLiquidQuery*queries,RustLiquid*output,size_t count,
    size_t*failed,char*error,size_t capacity){
    for(size_t i=0;i<count;++i)try{const auto s=water(queries[i].temperature,queries[i].pressure);
        output[i]={s.p,s.T,s.rho,s.u,s.h,s.s,s.cp,s.cv,s.w,s.alpha,s.kappa,s.mu,s.conductivity};
    }catch(const std::exception&e){*failed=i;if(capacity){const size_t n=std::min(capacity-1,std::strlen(e.what()));
        std::memcpy(error,e.what(),n);error[n]=0;}return 1;}return 0;
}
State recovered_state(const RustLiquid&s){const auto region=IF97::RegionDetermination_TP(s.temperature,s.pressure);
    require(region==IF97::REGION_1||region==IF97::REGION_3,"Recovered tuple left the known-liquid branch");
    return {region==IF97::REGION_1?1:3,s.pressure,s.temperature,s.density,s.internalEnergy,s.enthalpy,
        s.entropy,s.cp,s.cv,s.soundSpeed,s.expansion,s.compressibility,s.viscosity,s.conductivity};}
std::array<double,STOCKS> pack_stocks(const double*expanded){std::array<double,STOCKS> z{};
    for(int j=0;j<STOCKS;++j){const auto o=stockOwner[j];z[j]=expanded[ix(o.cell,o.field)];}return z;}
struct StockEvaluation {std::array<double,D> expanded{};std::array<RustRecoveredLiquid,N> recovered{};
    std::array<State,N> centers{};std::array<double,SAMPLE> rates{};};
uint64_t recovery_batches=0,recovery_points=0,recovery_iterations=0;
StockEvaluation recover_stocks(const double*z,double factor=1){
    require(std::isfinite(factor)&&factor>0,"Invalid inner recovery allocation");StockEvaluation out;
    // Fixed authored preparation is a caller-owned nearby seed, not runtime fallback
    // or remembered material state. The bounded fixture does not claim global recovery.
    static const auto seed=original();std::array<RustTrialLiquidInput,N> inputs;
    for(int j=0;j<STOCKS;++j){const auto o=stockOwner[j];out.expanded[ix(o.cell,o.field)]=z[j];}
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto x=view(out.expanded.data(),i);
        inputs[i]={{c.V,c.z},{x[M],x[P],x[E],c.tank?x[Q]:0},
            {seed[ix(i,TT)],seed[ix(i,PP)]},{.5*factor,1e-4*factor,12}};}
    size_t failed=0;char error[256]{};++recovery_batches;recovery_points+=N;
    const int status=leitbild_recover_trial_liquid_batch(inputs.data(),out.recovered.data(),N,&failed,error,sizeof(error));
    // A failed batch is a partial numerical candidate and is never used as state.
    require(status==0,"Known-liquid stock trial recovery failed cell="+std::to_string(failed)+": "+error);
    for(int i=0;i<N;++i){const auto&r=out.recovered[i];recovery_iterations+=r.iterations;
        out.expanded[ix(i,PP)]=r.liquid.pressure;out.expanded[ix(i,TT)]=r.liquid.temperature;
        out.centers[i]=recovered_state(r.liquid);}
    out.rates=::rates(out.expanded.data(),nullptr,&out.centers);return out;
}
std::array<double,STOCK_SAMPLE> project_stock_rates(const StockEvaluation&x){
    std::array<double,STOCK_SAMPLE> f{};for(int j=0;j<STOCKS;++j){const auto o=stockOwner[j];f[j]=x.rates[ix(o.cell,o.field)];}
    std::copy(x.rates.begin()+D,x.rates.end(),f.begin()+STOCKS);return f;}
std::array<double,STOCK_SAMPLE> stock_rates(const double*z,double factor=1){return project_stock_rates(recover_stocks(z,factor));}
std::array<double,STOCKS> stock_residual(const double*z,const double*dz,double factor=1){const auto f=stock_rates(z,factor);
    std::array<double,STOCKS> out{};for(int j=0;j<STOCKS;++j)out[j]=dz[j]-f[j];return out;}
struct StockJacobian {std::array<double,STOCKS*STOCKS> dense{};size_t colors=0,rateEvaluations=0;};
StockJacobian stock_jacobian(const double*z,double cj,double factor=1){const auto x=recover_stocks(z,factor);
    // Partial derivatives of the SAME actual rates in their explicit chart; no
    // native E/Q finite difference against a large absolute caloric datum.
    const auto partial=coupled_jacobian(x.expanded.data(),0);StockJacobian J;
    J.colors=partial.colors;J.rateEvaluations=partial.rateEvaluations+1;
    for(int column=0;column<STOCKS;++column){const auto o=stockOwner[column];const auto&a=x.recovered[o.cell].chart;
        const double det=a.Mp*a.Et-a.Mt*a.Ep;require(det>0,"Condensed inverse chart lost rank");
        const double dm=o.field==M?1:0,de=o.field==E?1:o.field==Q?-1:o.field==P?-a.v:0;
        const double dp=(dm*a.Et-a.Mt*de)/det,dT=(a.Mp*de-dm*a.Ep)/det;
        for(int row=0;row<STOCKS;++row){const auto r=stockOwner[row];const int expandedRow=ix(r.cell,r.field);
            J.dense[row*STOCKS+column]=partial.dense[expandedRow*D+ix(o.cell,o.field)]
                +partial.dense[expandedRow*D+ix(o.cell,PP)]*dp+partial.dense[expandedRow*D+ix(o.cell,TT)]*dT;
            require(std::isfinite(J.dense[row*STOCKS+column]),"Nonfinite condensed Newton entry");}
        J.dense[column*STOCKS+column]+=cj;
    }return J;
}
struct StockOperatorMetrics {size_t snapshots=0,colors=0,rateEvaluations=0;
    double maximumPressureDefectPa=0,maximumTemperatureDefectK=0,maximumKnownPressureErrorPa=0,
        maximumKnownTemperatureErrorK=0,maximumGuessPressureDifferencePa=0,maximumGuessTemperatureDifferenceK=0,
                maximumRateRelativeDifference=0,maximumComposedDirectionalBudgetFraction=0,maximumQDirectionalBudgetFraction=0;};
void stock_operator_gates(StockOperatorMetrics&m){m={};const auto initial=original();
    for(int sample=0;sample<3;++sample){auto expanded=initial;
        if(sample)for(int i=0;i<N;++i){const auto&c=cells[i];expanded[ix(i,PP)]+=(sample==1?1:-1)*500*(i%3-1);
            expanded[ix(i,TT)]+=.01*(i%2);const auto s=water(expanded[ix(i,TT)],expanded[ix(i,PP)]);
            const double mass=c.V*s.rho;expanded[ix(i,M)]=mass;expanded[ix(i,P)]=(sample==1?1:-1)*.03*mass;
            // Disclosed constitutive fixture, never the real mission preparation:
            // positive k=1 J/kg lets a fixed-E Q probe resolve its thermal feedback.
            if(c.tank)expanded[ix(i,Q)]=(sample==1?1:-1e-5)*mass;
            expanded[ix(i,E)]=mass*(s.u+gravity*c.z)+expanded[ix(i,P)]*expanded[ix(i,P)]/(2*mass)+(c.tank?expanded[ix(i,Q)]:0);}
        const auto z=pack_stocks(expanded.data());const auto recovered=recover_stocks(z.data());++m.snapshots;
        const auto direct=rates(expanded.data());++m.rateEvaluations;
        const auto repeated=rates(recovered.expanded.data());++m.rateEvaluations;
        for(int row=0;row<SAMPLE;++row){const double difference=std::abs(repeated[row]-recovered.rates[row]);
            require(difference<=100*std::numeric_limits<double>::epsilon()*
                std::max({1e-30,std::abs(repeated[row]),std::abs(recovered.rates[row])}),
                "Returned property tuple reuse changed actual rates or ring receipts");}
        for(int i=0;i<N;++i){const auto&r=recovered.recovered[i];
            m.maximumPressureDefectPa=std::max(m.maximumPressureDefectPa,std::abs(r.pressureDefect));
            m.maximumTemperatureDefectK=std::max(m.maximumTemperatureDefectK,std::abs(r.temperatureDefect));
            const double pe=std::abs(recovered.expanded[ix(i,PP)]-expanded[ix(i,PP)]),te=std::abs(recovered.expanded[ix(i,TT)]-expanded[ix(i,TT)]);
            m.maximumKnownPressureErrorPa=std::max(m.maximumKnownPressureErrorPa,pe);m.maximumKnownTemperatureErrorK=std::max(m.maximumKnownTemperatureErrorK,te);
            require(pe<=.5&&te<=1e-4,"Condensed known-state recovery failed independent p/T agreement");
            RustTrialLiquidInput input{{cells[i].V,cells[i].z},{z[sx(i,M)],z[sx(i,P)],z[sx(i,E)],cells[i].tank?z[sx(i,Q)]:0},
                {expanded[ix(i,TT)]+.005,expanded[ix(i,PP)]+100},{.5,1e-4,12}};RustRecoveredLiquid other;size_t failed=0;char error[256]{};
            require(leitbild_recover_trial_liquid_batch(&input,&other,1,&failed,error,sizeof(error))==0,"Second supplied nearby guess failed");
            const double pg=std::abs(other.liquid.pressure-r.liquid.pressure),tg=std::abs(other.liquid.temperature-r.liquid.temperature);
            m.maximumGuessPressureDifferencePa=std::max(m.maximumGuessPressureDifferencePa,pg);m.maximumGuessTemperatureDifferenceK=std::max(m.maximumGuessTemperatureDifferenceK,tg);
            require(pg<=1&&tg<=2e-4,"Recovery depends materially on supplied nearby guess");
            const auto&a=r.chart;const double det=a.Mp*a.Et-a.Mt*a.Ep,Mc=cells[i].V*r.liquid.density;
            const double positive=Mc*Mc*r.liquid.cp*(r.liquid.compressibility-r.liquid.temperature*r.liquid.expansion*r.liquid.expansion/(r.liquid.density*r.liquid.cp));
            require(std::abs(det-positive)<=1e-10*positive,"Condensed inverse determinant identity failed");}
        for(int row=0;row<SAMPLE;++row)if(row>=D||coordinateOwner[row].field<PP){const double difference=std::abs(direct[row]-recovered.rates[row]);
            const double scale=std::max({1.,std::abs(direct[row]),std::abs(recovered.rates[row])});
            m.maximumRateRelativeDifference=std::max(m.maximumRateRelativeDifference,difference/scale);
            require(difference<=.02*scale,"Recovered actual rates diverged from known explicit chart");}
        const auto J=stock_jacobian(z.data(),0);m.colors=J.colors;m.rateEvaluations+=J.rateEvaluations;
        RateQJacobian directQ{};(void)rates(recovered.expanded.data(),&directQ,&recovered.centers);++m.rateEvaluations;
        for(int i=0;i<N;++i)if(cells[i].tank){const auto&a=recovered.recovered[i].chart;
            const auto&matrix=J.dense;
            // Inverse-chart E and Q responses are exactly opposite, even when
            // Q is too small to change an absolute caloric datum representably.
            const double det=a.Mp*a.Et-a.Mt*a.Ep;
            const double ep=-a.Mt/det,et=a.Mp/det,qp=a.Mt/det,qt=-a.Mp/det;
            require(ep+qp==0&&et+qt==0,"Native E/Q inverse-chain antisymmetry failed");
            for(int row=0;row<STOCKS;++row){const auto owner=stockOwner[row];
                const double actual=matrix[row*STOCKS+sx(i,E)]+matrix[row*STOCKS+sx(i,Q)];
                const double expected=-directQ[ix(owner.cell,owner.field)][qColumn[i]];
                const double cancellation=100*std::numeric_limits<double>::epsilon()*
                    std::max(std::abs(matrix[row*STOCKS+sx(i,E)]),std::abs(matrix[row*STOCKS+sx(i,Q)]));
                require(std::abs(actual-expected)<=cancellation+1e-10*std::max({1.,std::abs(actual),std::abs(expected)}),
                    "Composed E+Q canceled an explicit Q rate contribution");}
        }
        auto paired=z;for(int i=0;i<N;++i)if(cells[i].tank){const double increment=paired[sx(i,M)]*.001;
            paired[sx(i,E)]+=increment;paired[sx(i,Q)]+=increment;}
        const auto sameChart=recover_stocks(paired.data());++m.rateEvaluations;
        for(int i=0;i<N;++i)require(std::abs(sameChart.expanded[ix(i,PP)]-recovered.expanded[ix(i,PP)])<=1
            &&std::abs(sameChart.expanded[ix(i,TT)]-recovered.expanded[ix(i,TT)])<=2e-4,
            "Equal E/Q increments changed the recovered thermal chart");
        if(sample==0)continue; // Zero-right is directional, not a central smooth-Q claim.
        // Resolved native energy and Q perturbations exercise opposite thermo
        // chains and explicit Q stress/transport; never assume E+Q leaves rates fixed.
        auto plus=z,minus=z;std::array<double,STOCKS> direction{};
        // Nonuniform physical-chart direction resolves actual intercell forces.
        // The previous common-mode fixture remains an under-resolved failed
        // receipt: its tiny net force was smaller than achieved inversion jitter.
        // This is a prospective fixture change, NOT a looser error budget, a
        // caloric-datum-dependent L1 norm or a solver/recovery tolerance change.
        for(int i=0;i<N;++i){const auto&a=recovered.recovered[i].chart;const double sign=i%2?1:-1;
            direction[sx(i,M)]=sign*(a.Mp*.5+a.Mt*1e-4);direction[sx(i,P)]=sign*z[sx(i,M)]*1e-5;
            direction[sx(i,B)]=sign*z[sx(i,M)]*1e-8;
            if(cells[i].tank)direction[sx(i,Q)]=sign*z[sx(i,M)]*1e-6;
            direction[sx(i,E)]=sign*(a.Ep*.5+a.Et*1e-4)+a.v*direction[sx(i,P)]
                +(cells[i].tank?direction[sx(i,Q)]:0)+sign*z[sx(i,M)]*.01;}
        for(int j=0;j<STOCKS;++j){plus[j]+=direction[j];minus[j]-=direction[j];}
        const auto plusTrial=recover_stocks(plus.data(),.01),minusTrial=recover_stocks(minus.data(),.01);
        const auto fp=project_stock_rates(plusTrial),fm=project_stock_rates(minusTrial);m.rateEvaluations+=2;
        for(int row=0;row<STOCKS;++row){double predicted=0;for(int column=0;column<STOCKS;++column)predicted-=J.dense[row*STOCKS+column]*direction[column];
            const auto owner=stockOwner[row];const double roundoff=owner.field==P
                ?100*std::numeric_limits<double>::epsilon()*std::abs(expanded[ix(owner.cell,PP)])*std::max(cells[owner.cell].A0,cells[owner.cell].A1)
                :1000*std::numeric_limits<double>::epsilon()*std::max(std::abs(fp[row]),std::abs(fm[row]));
            const double observed=(fp[row]-fm[row])/2,budget=roundoff+.1*std::max({1e-8,std::abs(observed),std::abs(predicted)});
            m.maximumComposedDirectionalBudgetFraction=std::max(m.maximumComposedDirectionalBudgetFraction,std::abs(observed-predicted)/budget);
            if(std::abs(observed-predicted)>budget){std::ostringstream detail;detail<<std::setprecision(17)
                <<"Condensed composed energy/Q directional screen failed snapshot="<<sample<<" row="<<row
                <<" cell="<<owner.cell<<" field="<<owner.field<<" observed="<<observed<<" predicted="<<predicted
                <<" budget="<<budget<<" roundoff="<<roundoff<<" plus="<<fp[row]<<" minus="<<fm[row];
                std::array<double,5> contributions{};double absoluteSum=0;
                for(int column=0;column<STOCKS;++column){const double contribution=-J.dense[row*STOCKS+column]*direction[column];
                    contributions[stockOwner[column].field]+=contribution;absoluteSum+=std::abs(contribution);}
                detail<<" contributionMPEBQ=";for(double value:contributions)detail<<value<<",";
                detail<<" absoluteContributionSum="<<absoluteSum<<" probeFactor=.01";
                for(int i=0;i<N;++i){const auto&a=recovered.recovered[i].chart;const double det=a.Mp*a.Et-a.Mt*a.Ep;
                    const double dm=direction[sx(i,M)],de=direction[sx(i,E)]-a.v*direction[sx(i,P)]-(cells[i].tank?direction[sx(i,Q)]:0);
                    const auto&rp=plusTrial.recovered[i];const auto&rm=minusTrial.recovered[i];
                    detail<<" cell"<<i<<"=dp:"<<(plusTrial.expanded[ix(i,PP)]-minusTrial.expanded[ix(i,PP)])/2
                        <<"/"<<(dm*a.Et-a.Mt*de)/det<<",dT:"<<(plusTrial.expanded[ix(i,TT)]-minusTrial.expanded[ix(i,TT)])/2
                        <<"/"<<(a.Mp*de-dm*a.Ep)/det<<",corrections:"<<rp.pressureDefect<<","<<rm.pressureDefect
                        <<","<<rp.temperatureDefect<<","<<rm.temperatureDefect;}
                require(false,detail.str());}}
        if(sample==1){plus=z;minus=z;direction.fill(0);
            for(int i=0;i<N;++i)if(cells[i].tank){direction[sx(i,Q)]=.01*z[sx(i,M)];
                plus[sx(i,Q)]+=direction[sx(i,Q)];minus[sx(i,Q)]-=direction[sx(i,Q)];}
            const auto qPlus=stock_rates(plus.data(),.01),qMinus=stock_rates(minus.data(),.01);m.rateEvaluations+=2;
            for(int row=0;row<STOCKS;++row){double predicted=0;for(int column=0;column<STOCKS;++column)
                    predicted-=J.dense[row*STOCKS+column]*direction[column];
                const auto owner=stockOwner[row];const double roundoff=owner.field==P
                    ?100*std::numeric_limits<double>::epsilon()*std::abs(expanded[ix(owner.cell,PP)])*std::max(cells[owner.cell].A0,cells[owner.cell].A1)
                    :1000*std::numeric_limits<double>::epsilon()*std::max(std::abs(qPlus[row]),std::abs(qMinus[row]));
                const double observed=(qPlus[row]-qMinus[row])/2;
                const double budget=roundoff+.1*std::max({1e-8,std::abs(observed),std::abs(predicted)});
                m.maximumQDirectionalBudgetFraction=std::max(m.maximumQDirectionalBudgetFraction,std::abs(observed-predicted)/budget);
                if(std::abs(observed-predicted)>budget){std::ostringstream detail;detail<<std::setprecision(17)
                    <<"Condensed isolated fixed-E Q directional screen failed snapshot="<<sample<<" row="<<row
                    <<" cell="<<owner.cell<<" field="<<owner.field<<" observed="<<observed<<" predicted="<<predicted
                    <<" budget="<<budget<<" roundoff="<<roundoff<<" plus="<<qPlus[row]<<" minus="<<qMinus[row];
                    require(false,detail.str());}}
        }
    }
    auto invalid=pack_stocks(initial.data());invalid[sx(0,M)]=-1;bool refused=false;
    try{(void)recover_stocks(invalid.data());}catch(const std::exception&){refused=true;}
    require(refused,"Invalid trial target was silently recovered");
    RustTrialLiquidInput branch{{cells[0].V,cells[0].z},{initial[ix(0,M)],0,initial[ix(0,E)],0},
        {450,101325},{.5,1e-4,12}};RustRecoveredLiquid unused;size_t failed=0;char error[256]{};
    require(leitbild_recover_trial_liquid_batch(&branch,&unused,1,&failed,error,sizeof(error))!=0,
        "Known-liquid recovery silently switched a gas guess to liquid");
}
`;
  return { kernelCpp, stockKernelCpp, cpp: kernelCpp + String.raw`
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
` };
}

/** Actual rates/residual payload used by the finite native qualification consumer. */
export function nativeAxialCandidate(document: string) {
  const geometry = fixtureGeometry(document);
  return { geometry, ...nativeSource(geometry) };
}
