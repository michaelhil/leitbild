/**
 * One bounded offline liquid CMT/BAL advancement check. Not an installed plant.
 * Uses actual geometry owners, the shared inspected IF97 adapter and native IDAS.
 * Current experiment qualifies one upstreamable whole-state solver-consistency
 * candidate on an isolated source copy. Not adopted as a production dependency.
 * No maintained fluid boundary, phase seed, alternate backend or automatic retry.
 * Usage: bun .../reference-design-cmt-native-axial.ts IF97_DIR SUNDIALS_ROOT DYLIB_DIR GEOMETRY_OWNER NEW_RECEIPT.json
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry';
import { parseBalancePathBasis } from './reference-design-cmt-balance-path';
import {
  nativeIf97Revision, nativeIf97HeaderSha256, nativeIf97LicenseSha256, nativeIf97Primitives,
} from './reference-design-if97-primitives';
import { nativeIdasConsistencyFixture } from './reference-design-idas-consistency';

const sha256 = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex');
const libraries = [
  'libsundials_core.7.5.0.dylib',
  'libsundials_nvecserial.7.5.0.dylib', 'libsundials_sunmatrixdense.5.5.0.dylib',
  'libsundials_sunmatrixband.5.5.0.dylib', 'libsundials_sunmatrixsparse.5.5.0.dylib',
  'libsundials_sunlinsoldense.5.5.0.dylib', 'libsundials_sunlinsolband.5.5.0.dylib',
];
// Exact upstream IDAS target source set plus its maintained Newton solver. The
// existing hashed core supplies generic operations. The isolated, explicitly
// identified consistency qualification below is not an adopted solver library.
const idasSources = ['idas.c', 'idaa.c', 'idas_cli.c', 'idas_io.c', 'idas_ic.c', 'idaa_io.c',
  'idas_ls.c', 'idas_bbdpre.c', 'idas_nls.c', 'idas_nls_sim.c', 'idas_nls_stg.c'];
const idasBaseSourceSha256 = '5cb27e969a189779adf5750b3a81e1828fd942754a6ce142097e6dfb9f3f83a9';

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
    length: number; slope: number; Dh: number; areaSlope: number; tank: boolean;
    quadrature: { weight: number; radius: number; smoothStrain: number }[] }[] = [];
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
      const x = Math.min(z - b.bottomDatum_m, b.top_m - z);
      const derivative = x >= g.a ? 0 : Math.PI * g.R ** 2 * (2 / g.a - 2 * x / g.a ** 2)
        * (z < (b.top_m + b.bottomDatum_m) / 2 ? 1 : -1);
      return { weight: h * weights[k]! * A(z) / volume, radius: A(z) / perimeter,
        smoothStrain: derivative / (2 * A(z)) };
    });
    cells.push({ V: volume, z: moment / volume, low: lo, high: hi, A0: A(lo), A1: A(hi),
      length: hi - lo, slope: 1, Dh: 4 * volume / axialContact,
      areaSlope: (A(hi) - A(lo)) / (hi - lo), tank: true, quadrature });
  }
  const mainLength = (b.balanceWater_m3 - b.distributorGroupWater_m3) / area;
  const rise = b.top_m - path.headerElevation_m, horizontal = mainLength - rise;
  const route = (V: number, lo: number, hi: number, A0: number, A1: number,
    length: number, z = (lo + hi) / 2) => cells.push({ V, z, low: lo, high: hi, A0, A1,
    length, slope: (hi - lo) / length, Dh: path.bore_m, areaSlope: 0, tank: false,
    quadrature: [{ weight: 1, radius: path.bore_m / 4, smoothStrain: 0 }] });
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
    c.slope, c.Dh, c.areaSlope, c.tank ? 1 : 0].join(',')}}`).join(',\n');
  const layout = ownedAxialLayout(input.cells.map(c => c.tank));
  return String.raw`
${nativeIf97Primitives}
#include <idas/idas.h>
#include <nvector/nvector_serial.h>
#include <sunmatrix/sunmatrix_dense.h>
#include <sunlinsol/sunlinsol_dense.h>
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
static double last_admitted_time=0,active_weight_factor=0;
static bool first_step_only=false;
static std::array<double,8> initial_norm_squares{};
static double initial_wrms=0,initial_step_from_norm=0;
void initial_norm_json() {
    const std::array<const char*,8> names{{"mass","momentum","nativeEnergy","tracer","ownedCmtQ",
        "algebraicPressure","algebraicTemperature","passiveReceipts"}};
    std::cout<<"{\"wrmsDerivativePerSecond\":"<<initial_wrms
        <<",\"defaultFirstStepSeconds\":"<<initial_step_from_norm<<",\"sumSquaredWeightedDerivatives\":{";
    for(size_t i=0;i<names.size();++i){if(i)std::cout<<",";std::cout<<"\""<<names[i]<<"\":"<<initial_norm_squares[i];}
    std::cout<<"}}";
}
double max_forward_p=0,max_dense_endpoint_p_error=0;
void require(bool ok,const std::string& message) {
    ++checks;
    if(std::chrono::duration<double>(Clock::now()-started).count()>guard_seconds)
        throw std::runtime_error("Aggregate native guard exhausted");
    if(!ok)throw std::runtime_error(message);
}
constexpr int N=${input.cells.length},S=7,RM=8,PHYSICAL=${layout.coordinateCount},D=PHYSICAL,OBSERVERS=3*RM,SAMPLE=D+OBSERVERS;
constexpr double gravity=9.80665,holeD=${input.b.holeDiameter_m},Cd=${input.path.Cd},Cv=${input.path.Cv};
struct Cell {double V,z,lo,hi,A0,A1,length,slope,Dh,dA;bool tank;};
const std::array<Cell,N> cells{{${rows}}};
struct GeometricNode {double weight,radius,smoothStrain;};
const std::array<std::vector<GeometricNode>,N> geometryNodes{{${input.cells.map(c =>
    `{${c.quadrature.map(n => `{${n.weight},${n.radius},${n.smoothStrain}}`).join(',')}}`).join(',\n')}}};
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
struct Run {long callbacks=0,quadratureCallbacks=0,recoverable=0;std::string failure;double worstM=0,worstE=0,worstB=0;};

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
    for(int i=0;i<N;++i){const auto&c=cells[i];
        int a=std::max(i<13?0:13,i-1),b=std::min(i<13?12:20,i+1);
        if(a<i&&std::abs(cells[a].A1-c.A0)>1e-12)a=i;
        if(b>i&&std::abs(c.A1-cells[b].A0)>1e-12)b=i;
        const double distance=a==b?1:c.tank?cells[b].z-cells[a].z:
            (cells[a].length+cells[b].length)/2+(a+1<b?cells[a+1].length:0);
        const double dr=(state[b].rho-state[a].rho)/distance,du=(velocity[b]-velocity[a])/distance;
        const double dp=-state[i].rho*gravity;
        const double N2=gravity/state[i].rho*(dp/(state[i].w*state[i].w)-dr);
        double sourceQ=0;
        for(const auto&node:geometryNodes[i]){
            const double transverse=velocity[i]*(c.A1-c.A0)/(2*c.V),deviator=du-transverse;
            double nut=0,kt=0,eps=0;
            if(c.tank&&k[i]>0){double l=std::min(holeD,.7*node.radius);if(N2>0)l=std::min(l,.76*std::sqrt(k[i]/N2));
                require(l>0,"Positive mixing energy lacks physical closure length");
                nut=.1*l*std::sqrt(k[i]);kt=(1+2*l/holeD)*nut;
                eps=(.19+.51*l/holeD)*std::pow(k[i],1.5)/l;
                const double G=-kt*(dr-dp/(state[i].w*state[i].w))*dp;
                const double production=4./3*state[i].rho*nut*deviator*deviator
                    -2./3*state[i].rho*k[i]*(du+2*transverse);
                sourceQ+=node.weight*(production+G-state[i].rho*eps);
            }
            nu[i]+=node.weight*nut;diff[i]+=node.weight*kt;
            tau[i]+=node.weight*(4./3*(state[i].mu+state[i].rho*nut)*deviator-2./3*state[i].rho*k[i]);
            tauPerp[i]+=node.weight*(-2./3*(state[i].mu+state[i].rho*nut)*deviator-2./3*state[i].rho*k[i]);
        }
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

int residual(double,const N_Vector yy,const N_Vector yp,N_Vector rr,void* data) {
    auto&run=*static_cast<Run*>(data);++run.callbacks;
    const double*y=N_VGetArrayPointer(yy),*dy=N_VGetArrayPointer(yp);double*r=N_VGetArrayPointer(rr);
    try{const auto f=rates(y);
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
        return 0;
    }catch(const std::exception&e){run.failure=e.what();++run.recoverable;
        return std::chrono::duration<double>(Clock::now()-started).count()>guard_seconds?-1:1;}
}

int quadrature_rhs(double,const N_Vector yy,const N_Vector,N_Vector qdot,void* data) {
    auto&run=*static_cast<Run*>(data);++run.quadratureCallbacks;
    // IDAS supplies a nonlinear stage candidate here, NOT an admitted endpoint.
    try {const auto f=rates(N_VGetArrayPointer(yy));auto*q=N_VGetArrayPointer(qdot);
        std::copy(f.begin()+D,f.end(),q);return 0;
    } catch(const std::exception&e){run.failure=e.what();++run.recoverable;
        return std::chrono::duration<double>(Clock::now()-started).count()>guard_seconds?-1:1;}
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
struct Result {
    double last=0,attained=0,elapsed=0,gross=0,grossE=0,thermal=0,maxT=0,totalQ=0;
    long steps=0,residuals=0,callbacks=0,quadratureCallbacks=0,jacobians=0,errorFails=0,convergenceFails=0,recoverable=0;
    double massError=0,energyError=0,tracerError=0;
    double chartPressureError=0,chartTemperatureError=0;
    double rawMinimumQ=0,canonicalMinimumQ=0,maximumEndpointDifference=0;
    double maximumDerivativePairDifference=0;
    double firstRawQ=0,firstCanonicalQ=0;
    std::array<long,6> observedOrders{};
    std::array<std::array<double,RM>,3> ring{};
    std::vector<std::array<double,SAMPLE>> common;
};
static Result partial;
static std::vector<Result> completed;
void statistics(void* mem,Run&data,Result&result) {
    IDAGetNumSteps(mem,&result.steps);IDAGetNumResEvals(mem,&result.residuals);IDAGetNumErrTestFails(mem,&result.errorFails);
    IDAGetNumNonlinSolvConvFails(mem,&result.convergenceFails);IDAGetNumJacEvals(mem,&result.jacobians);
    result.callbacks=data.callbacks;result.quadratureCallbacks=data.quadratureCallbacks;result.recoverable=data.recoverable;
}
std::array<double,3> totals(const double* y) {
    std::array<double,3>s{};for(int i=0;i<N;++i){s[0]+=y[ix(i,M)];s[1]+=y[ix(i,E)];s[2]+=y[ix(i,B)];}return s;
}
void ida_ok(int flag,const char* operation){require(flag>=0,std::string("Native IDA failed ")+operation+": "+std::to_string(flag));}
std::string stock_failure(int i,CellView x) {
    const int field=!(x[M]>0)?M:!(x[B]>=0)?B:Q;
    const char* name=field==M?"M [kg]":field==B?"B [kg_eq]":
        "Q [J]";
    std::ostringstream message;
    message<<std::setprecision(17)<<std::scientific<<"Accepted stock admission failed: cell="<<i
        <<" owner="<<(cells[i].tank?"CMT":"BAL")<<" field="<<name<<" value="<<x[field];
    return message.str();
}
Result advance(double factor) {
    active_weight_factor=factor;last_admitted_time=0;
    const auto begin=Clock::now();const auto init=original();Run data;Result result;partial=Result{};
    SUNContext context=nullptr;ida_ok(SUNContext_Create(SUN_COMM_NULL,&context),"context");
    N_Vector y=N_VNew_Serial(D,context),yp=N_VClone(y),id=N_VClone(y),atol=N_VClone(y),constraints=N_VClone(y);
    N_Vector canonical=N_VClone(y),canonicalDerivative=N_VClone(y),quadrature=N_VNew_Serial(OBSERVERS,context);
    require(y&&yp&&id&&atol&&constraints&&canonical&&canonicalDerivative&&quadrature,"Native serial allocation failed");
    auto*x=N_VGetArrayPointer(y),*dx=N_VGetArrayPointer(yp),*ids=N_VGetArrayPointer(id),*tol=N_VGetArrayPointer(atol),*co=N_VGetArrayPointer(constraints);
    const auto f=rates(init.data());
    for(int j=0;j<D;++j){x[j]=init[j];dx[j]=f[j];ids[j]=1;tol[j]=factor*1e-7;co[j]=0;}
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto s=water(init[ix(i,TT)],init[ix(i,PP)]);
        const double Mc=init[ix(i,M)],Mp=Mc*s.kappa,Mt=-Mc*s.alpha;
        const double Ep=(s.u+gravity*c.z)*Mp+Mc*up(s),Et=(s.u+gravity*c.z)*Mt+Mc*ut(s),det=Mp*Et-Mt*Ep;
        // Inverse full native storage sensitivity sets the prospective physical error screens.
        const double dp=50*factor,dT=.01*factor;
        tol[ix(i,M)]=std::min(dp*det/(2*std::abs(Et)),dT*det/(2*std::abs(Ep)));
        tol[ix(i,E)]=std::min(dp*det/(2*std::abs(Mt)),dT*det/(2*std::abs(Mp)));
        tol[ix(i,P)]=Mc*.001*factor;tol[ix(i,B)]=Mc*1e-8*factor;if(c.tank)tol[ix(i,Q)]=Mc*.001*factor;
        tol[ix(i,PP)]=dp;tol[ix(i,TT)]=dT;ids[ix(i,PP)]=ids[ix(i,TT)]=0;
        co[ix(i,M)]=co[ix(i,PP)]=co[ix(i,TT)]=2;co[ix(i,B)]=1;if(c.tank)co[ix(i,Q)]=1;
        dx[ix(i,PP)]=dx[ix(i,TT)]=0;
        const double Rm=f[ix(i,M)],Ru=f[ix(i,E)]-(c.tank?f[ix(i,Q)]:0);
        dx[ix(i,PP)]=(Rm*Et-Mt*Ru)/det;dx[ix(i,TT)]=(Mp*Ru-Rm*Ep)/det;
        require(std::abs(Mp*dx[ix(i,PP)]+Mt*dx[ix(i,TT)]-Rm)<=1e-8+1e-10*std::abs(Rm),
            "Differentiated original mass constraint failed");
        require(std::abs(Ep*dx[ix(i,PP)]+Et*dx[ix(i,TT)]-Ru)<=1e-4+1e-10*std::abs(Ru),
            "Differentiated original total-energy constraint failed");
    }
    N_VConst(0,quadrature);
    initial_norm_squares.fill(0);
    for(int j=0;j<D;++j){int group=7;
        if(j<PHYSICAL){const int field=coordinateOwner[j].field,cell=coordinateOwner[j].cell;
            group=field==M?0:field==P?1:field==E?2:field==B?3:field==Q?4:field==PP?5:6;}
        const double weighted=dx[j]/tol[j];initial_norm_squares[group]+=weighted*weighted;}
    double normSum=0;for(double value:initial_norm_squares)normSum+=value;
    initial_wrms=std::sqrt(normSum/D);initial_step_from_norm=std::min(.001,initial_wrms>0?.5/initial_wrms:.001);
    void*mem=IDACreate(context);require(mem,"Native IDA allocation failed");
    N_Vector initialResidual=N_VClone(y);
    require(residual(0,y,yp,initialResidual,&data)==0,"Original native residual rejected");
    const double*rr=N_VGetArrayPointer(initialResidual);
    for(int j=0;j<D;++j){
        // The thermodynamic rows already have p/T units; use the SAME declared chart screens.
        // Differential rows are exact dx=f plus a1e-6 SI-rate arithmetic screen (kg/s,
        // kg m/s2, J/s, kg_eq/s and their actual integral-ledger rates), not a pressure tolerance.
        const int field=j<PHYSICAL?coordinateOwner[j].field:-1;
        const double limit=field==PP?5*factor:field==TT?.001*factor:1e-6;
        require(std::abs(rr[j])<=limit,"Original native/algebraic residual is not consistent");
    }
    N_VDestroy(initialResidual);
    ida_ok(IDAInit(mem,residual,0,y,yp),"initialization");ida_ok(IDASetUserData(mem,&data),"user data");
    ida_ok(IDASetId(mem,id),"native/algebraic ids");ida_ok(IDASetConstraints(mem,constraints),"physical constraints");
    ida_ok(IDASVtolerances(mem,0,atol),"inverse-storage native weights");
    ida_ok(IDAQuadInit(mem,quadrature_rhs,quadrature),"passive ring quadrature initialization");
    // Observer accuracy is checked by the paired physical arm, not a claimed independent
    // quadrature LTE bound. These read-only ledgers cannot choose physical startup steps.
    ida_ok(IDASetQuadErrCon(mem,SUNFALSE),"passive quadrature outside physical error control");
    SUNMatrix matrix=SUNDenseMatrix(D,D,context);SUNLinearSolver solver=SUNLinSol_Dense(y,matrix,context);
    require(matrix&&solver,"Native dense solver allocation failed");ida_ok(IDASetLinearSolver(mem,solver,matrix),"linear solver");
    ida_ok(IDASetMaxNumSteps(mem,20000),"work guard");ida_ok(IDASetMaxStep(mem,1),"operational boundary spacing");
    const auto initialTotals=totals(init.data());double t=0;
    for(int target=1;target<=30;++target){ida_ok(IDASetStopTime(mem,target),"causal stop boundary");
        while(t<target){const int flag=IDASolve(mem,target,&t,y,yp,IDA_ONE_STEP);
            result.attained=t;result.elapsed=std::chrono::duration<double>(Clock::now()-begin).count();
            statistics(mem,data,result);partial=result;
            if(flag<0)throw std::runtime_error("Accepted time "+std::to_string(t)+" s; "+data.failure+"; IDA status "+std::to_string(flag));
            require(flag==IDA_SUCCESS||flag==IDA_TSTOP_RETURN,"Unexpected IDA event/return");
            double current=0;ida_ok(IDAGetCurrentTime(mem,&current),"current endpoint time");
            require(current==t,"Returned output is not the current solver endpoint");
            // Fresh ONE_STEP can return a stale nonlinear candidate after IDAS corrects
            // its inequality-constrained correction. Always admit the FULL public history
            // pair at this SAME endpoint; never patch a component or mutate solver history.
            ida_ok(IDAGetDky(mem,current,0,canonical),"canonical full endpoint state");
            ida_ok(IDAGetDky(mem,current,1,canonicalDerivative),"canonical full endpoint derivative");
            const auto*raw=N_VGetArrayPointer(y);x=N_VGetArrayPointer(canonical);
            const auto*rawDot=N_VGetArrayPointer(yp);double lastStep=0;int lastOrder=0;
            ida_ok(IDAGetLastStep(mem,&lastStep),"last accepted step");ida_ok(IDAGetLastOrder(mem,&lastOrder),"last accepted order");
            require(lastStep>0&&lastOrder>=1&&lastOrder<=5,"Invalid step/order in accepted history");
            ++result.observedOrders[lastOrder];
            const auto*canonicalDot=N_VGetArrayPointer(canonicalDerivative);
            for(int j=0;j<D;++j){require(std::isfinite(x[j])&&std::isfinite(canonicalDot[j]),"Nonfinite canonical full endpoint pair");
                result.maximumEndpointDifference=std::max(result.maximumEndpointDifference,std::abs(raw[j]-x[j])/tol[j]);
                require(raw[j]==x[j],"Corrected full endpoint and public history differ");
                const double derivativeDifference=std::abs(rawDot[j]-canonicalDot[j])*lastStep/tol[j];
                result.maximumDerivativePairDifference=std::max(result.maximumDerivativePairDifference,derivativeDifference);
                require(std::isfinite(derivativeDifference)&&derivativeDifference<=1e-6,"Corrected full derivative and public history are incoherent");}
            for(int i=0;i<13;++i){result.rawMinimumQ=std::min(result.rawMinimumQ,raw[ix(i,Q)]);
                result.canonicalMinimumQ=std::min(result.canonicalMinimumQ,x[ix(i,Q)]);}
            if(result.steps==1){result.firstRawQ=raw[ix(0,Q)];result.firstCanonicalQ=x[ix(0,Q)];}
            ida_ok(IDAGetQuadDky(mem,current,0,quadrature),"same-endpoint passive ring receipts");
            const auto*q=N_VGetArrayPointer(quadrature);
            for(int j=0;j<OBSERVERS;++j)require(std::isfinite(q[j]),"Nonfinite passive ring receipt");
            partial=result;
            const auto total=totals(x);
            result.massError=std::max(result.massError,std::abs(total[0]-initialTotals[0]));
            result.energyError=std::max(result.energyError,std::abs(total[1]-initialTotals[1]));
            result.tracerError=std::max(result.tracerError,std::abs(total[2]-initialTotals[2]));
            require(result.massError<=1e-6&&result.energyError<=.1&&result.tracerError<=1e-8,"Closed native conservation gate failed");
            for(int i=0;i<N;++i){const auto native=view(x,i);
                const bool valid=native[M]>0&&native[B]>=0&&(!cells[i].tank||native[Q]>=0);
                require(valid,valid?"":stock_failure(i,native));
                const auto s=water(x[ix(i,TT)],x[ix(i,PP)]);
                const double Mc=cells[i].V*s.rho,velocity=x[ix(i,P)]/Mc;
                const double Mp=Mc*s.kappa,Mt=-Mc*s.alpha;
                const double Ep=(s.u+gravity*cells[i].z-velocity*velocity/2)*Mp+Mc*up(s);
                const double Et=(s.u+gravity*cells[i].z-velocity*velocity/2)*Mt+Mc*ut(s),det=Mp*Et-Mt*Ep;
                const double predictedE=Mc*(s.u+gravity*cells[i].z)+x[ix(i,P)]*x[ix(i,P)]/(2*Mc)+(cells[i].tank?x[ix(i,Q)]:0);
                const double rm=x[ix(i,M)]-Mc,re=x[ix(i,E)]-predictedE;
                const double pp=std::abs((rm*Et-Mt*re)/det),tt=std::abs((Mp*re-rm*Ep)/det);
                result.chartPressureError=std::max(result.chartPressureError,pp);
                result.chartTemperatureError=std::max(result.chartTemperatureError,tt);
                require(pp<=5*factor&&tt<=.001*factor,"Accepted native M/E chart coherence failed");
            }
            result.last=t;last_admitted_time=t;
            for(int ring=0;ring<3;++ring)for(int j=0;j<RM;++j)result.ring[ring][j]=q[ring*RM+j];
            // Failure receipts must describe the LAST ADMITTED endpoint, not synthetic
            // unfinished-arm zeros or any subsequently rejected trial's observations.
            result.gross=result.grossE=result.thermal=result.maxT=result.totalQ=0;
            for(int ring=0;ring<3;++ring){result.gross+=result.ring[ring][1];
                result.grossE+=result.ring[ring][3];result.thermal+=result.ring[ring][7];}
            for(int i=0;i<13;++i){result.maxT=std::max(result.maxT,std::abs(x[ix(i,TT)]-313.15));result.totalQ+=x[ix(i,Q)];}
            partial=result;
            if(first_step_only)goto finish_advance;
        }
        require(std::abs(t-target)<=1e-10,"Output is not an accepted IDA stop-time state");
        std::array<double,SAMPLE> row;std::copy(x,x+D,row.begin());
        std::copy(N_VGetArrayPointer(quadrature),N_VGetArrayPointer(quadrature)+OBSERVERS,row.begin()+D);
        result.common.push_back(row);
        std::cerr<<"accepted weight="<<factor<<" t="<<t<<" steps="<<result.steps<<" callbacks="<<data.callbacks<<"\n";
    }
finish_advance:
    statistics(mem,data,result);
    result.elapsed=std::chrono::duration<double>(Clock::now()-begin).count();
    IDAFree(&mem);SUNLinSolFree(solver);SUNMatDestroy(matrix);N_VDestroy(y);N_VDestroy(yp);N_VDestroy(id);N_VDestroy(atol);N_VDestroy(constraints);
    N_VDestroy(canonical);N_VDestroy(canonicalDerivative);N_VDestroy(quadrature);SUNContext_Free(&context);
    return result;
}
void result_json(const Result&r) {
    std::cout<<"{\"acceptedSeconds\":"<<r.last<<",\"wallSeconds\":"<<r.elapsed
        <<",\"solverAttainedSeconds\":"<<r.attained
        <<",\"steps\":"<<r.steps<<",\"residualEvaluations\":"<<r.residuals<<",\"actualCallbacksIncludingNumericalJacobian\":"<<r.callbacks
        <<",\"passiveQuadratureCallbacks\":"<<r.quadratureCallbacks
        <<",\"minimumRawReturnedQJ\":"<<r.rawMinimumQ<<",\"minimumCanonicalEndpointQJ\":"<<r.canonicalMinimumQ
        <<",\"firstRawCell0QJ\":"<<r.firstRawQ<<",\"firstCanonicalCell0QJ\":"<<r.firstCanonicalQ
        <<",\"maximumRawCanonicalDifferenceInAtolUnits\":"<<r.maximumEndpointDifference
        <<",\"maximumFullDerivativePairDifferenceInStepAtolUnits\":"<<r.maximumDerivativePairDifference
        <<",\"observedOrderStepCounts\":[";
    for(size_t k=1;k<r.observedOrders.size();++k){if(k>1)std::cout<<",";std::cout<<r.observedOrders[k];}
    std::cout<<"]"
        <<",\"jacobians\":"<<r.jacobians<<",\"errorTestFailures\":"<<r.errorFails<<",\"nonlinearFailures\":"<<r.convergenceFails
        <<",\"recoverableResiduals\":"<<r.recoverable<<",\"maximumMassDefectKg\":"<<r.massError<<",\"maximumEnergyDefectJ\":"<<r.energyError
        <<",\"maximumTracerDefectKgEq\":"<<r.tracerError<<",\"grossRingMassKg\":"<<r.gross<<",\"grossNativeRingEnergyJ\":"<<r.grossE
        <<",\"datumSubtractedRingEnergyJ\":"<<r.thermal<<",\"maximumReceivingTemperatureChangeK\":"<<r.maxT<<",\"finalReceivingQJ\":"<<r.totalQ
        <<",\"maximumNativeChartPressureResidualPa\":"<<r.chartPressureError<<",\"maximumNativeChartTemperatureResidualK\":"<<r.chartTemperatureError
        <<",\"ringColumns\":[\"signedMassKg\",\"grossMassKg\",\"signedNativeEnergyJ\",\"grossNativeEnergyJ\",\"signedTracerKgEq\",\"incomingReceivingQJ\",\"outgoingReceivingQJ\",\"datumSubtractedEnergyJ\"],\"ringReceipts\":[";
    for(int ring=0;ring<3;++ring){if(ring)std::cout<<",";std::cout<<"[";for(int j=0;j<RM;++j){if(j)std::cout<<",";std::cout<<r.ring[ring][j];}std::cout<<"]";}std::cout<<"]}";
}
int main(int argc,char**argv) {
    std::cout<<std::setprecision(17);
    try{if(argc>=2)guard_seconds=std::stod(argv[1]);
        if(argc==3){require(std::string(argv[2])=="first-step","Unknown offline diagnostic mode");first_step_only=true;}
        local_gates();
        if(first_step_only){const auto diagnostic=advance(1);
            std::cout<<"{\"passed\":true,\"scope\":\"one instrumented first step only, not useful-duration qualification\",\"initialDerivativeNorm\":";
            initial_norm_json();std::cout<<",\"firstStep\":";result_json(diagnostic);std::cout<<"}\n";return 0;}
        const auto a=advance(1);completed.push_back(a);const auto b=advance(.5);completed.push_back(b);
        double dt=0,dp=0,dv=0,dm=0,denergy=0,dthermal=0,dq=0;
        std::array<std::array<double,RM>,3> ringDifference{};
        for(size_t j=0;j<a.common.size();++j){const auto&l=a.common[j];const auto&r=b.common[j];
            for(int i=0;i<N;++i){dt=std::max(dt,std::abs(l[ix(i,TT)]-r[ix(i,TT)]));dp=std::max(dp,std::abs(l[ix(i,PP)]-r[ix(i,PP)]));
                dv=std::max(dv,std::abs(l[ix(i,P)]/l[ix(i,M)]-r[ix(i,P)]/r[ix(i,M)]));}
            double ml=0,mr=0,el=0,er=0,hl=0,hr=0,ql=0,qr=0;
            for(int ring=0;ring<3;++ring){const int k=PHYSICAL+ring*RM;ml+=l[k+1];mr+=r[k+1];el+=l[k+3];er+=r[k+3];hl+=l[k+7];hr+=r[k+7];
                for(int c=0;c<RM;++c)ringDifference[ring][c]=std::max(ringDifference[ring][c],std::abs(l[k+c]-r[k+c]));}
            for(int i=0;i<13;++i){ql+=l[ix(i,Q)];qr+=r[ix(i,Q)];}
            dm=std::max(dm,std::abs(ml-mr));denergy=std::max(denergy,std::abs(el-er));
            dthermal=std::max(dthermal,std::abs(hl-hr));dq=std::max(dq,std::abs(ql-qr));}
        require(dt<=.05&&dp<=100&&dv<=.005,"Paired operational temperature/head/velocity gate failed");
        require(a.gross>10*std::max(dm,1e-6)&&b.gross>10*std::max(dm,1e-6),"Gross actual ring transfer unresolved by paired weights");
        require(std::min(a.grossE,b.grossE)>10*std::max(denergy,.01),"Gross actual ring native energy unresolved");
        require(std::min(a.maxT,b.maxT)>10*std::max(dt,1e-5)||std::min(a.totalQ,b.totalQ)>10*std::max(dq,1e-5),
            "Neither actual receiving thermal nor radial-jet Q response is resolved");
        std::cout<<"{\"passed\":true,\"coarseWeights\":";result_json(a);std::cout<<",\"tighterWeights\":";result_json(b);
        std::cout<<",\"commonAcceptedSamples\":"<<a.common.size()<<",\"maximumPairedTemperatureK\":"<<dt<<",\"maximumPairedPressurePa\":"<<dp
            <<",\"maximumPairedVelocityMS\":"<<dv<<",\"maximumGrossMassDifferenceKg\":"<<dm<<",\"maximumGrossNativeEnergyDifferenceJ\":"<<denergy
            <<",\"maximumDatumSubtractedEnergyDifferenceJ\":"<<dthermal<<",\"maximumQDifferenceJ\":"<<dq
            <<",\"maximumPerRingPairedReceiptDifferences\":[";
        for(int ring=0;ring<3;++ring){if(ring)std::cout<<",";std::cout<<"[";for(int c=0;c<RM;++c){if(c)std::cout<<",";std::cout<<ringDifference[ring][c];}std::cout<<"]";}
        std::cout<<"],\"quadratureErrorControlled\":false,\"checks\":"<<checks<<",\"propertyTuples\":"<<tuple_calls<<",\"forwardPressureDefectPa\":"<<max_forward_p<<"}\n";return 0;
    }catch(const std::exception&e){std::cerr<<e.what()<<"\n";
        std::cout<<"{\"passed\":false,\"lastAdmittedSeconds\":"<<last_admitted_time
            <<",\"weightFactor\":"<<active_weight_factor<<",\"checks\":"<<checks<<",\"propertyTuples\":"<<tuple_calls
            <<",\"initialDerivativeNorm\":";initial_norm_json();
        std::cout<<",\"partialArm\":";result_json(partial);std::cout<<",\"completedArms\":[";
        for(size_t i=0;i<completed.size();++i){if(i)std::cout<<",";result_json(completed[i]);}std::cout<<"]}\n";return 1;}
}
`;
}

/** Explicit candidate artifact for reviewed offline execution; no textual source extraction. */
export function nativeAxialCandidate(document: string) {
  const geometry = fixtureGeometry(document);
  return { geometry, cpp: nativeSource(geometry) };
}

export async function runNativeAxialAdmission(if97Directory: string, sundialsRoot: string,
  dylibDirectory: string, ownerPath: string, outputPath: string,
  budget: { allowanceSeconds: number; previousSetupReceipt?: string } = { allowanceSeconds: 120 }) {
  // One explicitly authorized setup correction, not an automatic retry mechanism.
  const allowanceSeconds = budget.allowanceSeconds;
  if (!(allowanceSeconds > 2 && allowanceSeconds <= 120)) throw Error('Invalid explicit remaining allowance');
  const priorToolingFailurePath = budget.previousSetupReceipt;
  const priorBytes = priorToolingFailurePath ? await readFile(resolve(priorToolingFailurePath)) : null;
  const prior = priorBytes ? JSON.parse(priorBytes.toString()) : null;
  const priorChargeSeconds = 120 - allowanceSeconds;
  if (prior && (prior.passed !== false || prior.nativeFixture?.build?.exitCode !== 1
    || prior.nativeFixture?.run !== null || prior.run !== null
    || prior.aggregateElapsedSeconds > priorChargeSeconds)) throw Error('Prior receipt is not the authorized compile-only failure');
  if (!prior && priorChargeSeconds !== 0) throw Error('Reduced allowance requires explicit prior receipt');
  const input = resolve(if97Directory), solverRoot = resolve(sundialsRoot), dylibs = resolve(dylibDirectory);
  const owner = resolve(ownerPath), output = resolve(outputPath);
  try { await readFile(output); throw Error('Receipt exists; refusing overwrite'); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  const header = await readFile(join(input, 'IF97.h')), license = await readFile(join(input, 'LICENSE'));
  if (sha256(header) !== nativeIf97HeaderSha256 || sha256(license) !== nativeIf97LicenseSha256)
    throw Error('Pinned IF97 identity mismatch');
  const ownerBytes = await readFile(owner), { geometry, cpp } = nativeAxialCandidate(ownerBytes.toString());
  const solverArtifacts = await Promise.all(libraries.map(async name => ({ path: join(dylibs, name), sha256: sha256(await readFile(join(dylibs, name))) })));
  const solverLicensePath = join(solverRoot, 'sundials-7.5.0', 'LICENSE');
  const solverLicense = await readFile(solverLicensePath);
  const primitivePath = new URL('./reference-design-if97-primitives.ts', import.meta.url);
  const primitiveSha256 = sha256(await readFile(primitivePath));
  const scratch = await mkdtemp(join(tmpdir(), 'ld01-native-axial-'));
  const source = join(scratch, 'admission.cpp'), executable = join(scratch, 'admission');
  await writeFile(source, cpp, { flag: 'wx' });
  const nativeFixtureSource = join(scratch, 'solver-invariants.cpp'), nativeFixtureBinary = join(scratch, 'solver-invariants');
  await writeFile(nativeFixtureSource, nativeIdasConsistencyFixture, { flag: 'wx' });
  const nativeFixtureModulePath = new URL('./reference-design-idas-consistency.ts', import.meta.url).pathname;
  const nativeFixtureModuleSha256 = sha256(await readFile(nativeFixtureModulePath));
  const upstreamRoot = join(solverRoot, 'sundials-7.5.0');
  const idasInputPaths = [...idasSources.map(name => join(upstreamRoot, 'src', 'idas', name)),
    join(upstreamRoot, 'src', 'sunnonlinsol', 'newton', 'sunnonlinsol_newton.c')];
  const idasInputs = await Promise.all(idasInputPaths.map(async path => ({ path, sha256: sha256(await readFile(path)) })));
  if (idasInputs[0]!.sha256 !== idasBaseSourceSha256) throw Error('Pinned IDAS7.5 implementation identity mismatch');
  const idasHeaderPaths = ['idas.h', 'idas_ls.h', 'idas_bbdpre.h'].map(name => join(upstreamRoot, 'include', 'idas', name));
  const privateHeaderPaths = ['idas_impl.h', 'idas_ls_impl.h', 'idas_bbdpre_impl.h'].map(name => join(upstreamRoot, 'src', 'idas', name));
  const headerInputs = await Promise.all([...idasHeaderPaths, ...privateHeaderPaths].map(async path => ({ path, sha256: sha256(await readFile(path)) })));
  const idasLibrary = join(scratch, 'libsundials_idas.7.5.0.dylib');
  const patchPath = new URL('./reference-design-idas-consistency.patch', import.meta.url).pathname;
  const patchBytes = await readFile(patchPath);
  const regressionPaths = ['reference-design-ida-history.test.ts', 'reference-design-cmt-native-axial.test.ts']
    .map(name => new URL(name, import.meta.url).pathname);
  const regressionInputs = await Promise.all(regressionPaths.map(async path => ({ path, sha256: sha256(await readFile(path)) })));
  const privateRoot = join(scratch, 'private-idas-candidate'), privateSource = join(privateRoot, 'src', 'idas', 'idas.c');
  const began = performance.now();
  await mkdir(join(privateRoot, 'src', 'idas'), { recursive: true });
  await writeFile(privateSource, await readFile(idasInputPaths[0]!), { flag: 'wx' });
  async function execute(command: string[], cwd?: string) {
    const remaining = (allowanceSeconds - 1) * 1000 - (performance.now() - began);
    if (remaining <= 0) return { command, exitCode: -1, timedOut: true, stdout: '', stderr: 'Aggregate compile/native allowance exhausted before launch' };
    // The inspected macOS wheel dylibs retain upstream /DLC install names.
    // Resolve only against the explicitly supplied, hashed native artifact directory.
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', cwd: cwd ?? process.cwd(),
      env: { ...process.env, DYLD_LIBRARY_PATH: dylibs } });let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, remaining);
    try { const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);return { command, exitCode, timedOut, stdout, stderr }; }
    finally { clearTimeout(timer); }
  }
  const staticRegressions = await execute(['bun', 'test', ...regressionPaths]);
  const patchApplication = staticRegressions.exitCode === 0 && !staticRegressions.timedOut
    ? await execute(['patch', '-f', '-F', '0', '-p', '1', '-i', patchPath], privateRoot) : null;
  const patchedSourceSha256 = patchApplication?.exitCode === 0 ? sha256(await readFile(privateSource)) : null;
  const compiler = patchedSourceSha256 ? await execute(['clang++', '--version']) : null;
  const flags = ['-std=c++17', '-O2', '-I', input, '-I', join(solverRoot, 'headers', 'include'),
    '-I', join(solverRoot, 'sundials-7.5.0', 'include')];
  const idasFlags = ['-std=gnu99', '-O2', '-fPIC', '-dynamiclib', '-I', join(solverRoot, 'headers', 'include'),
    '-I', join(upstreamRoot, 'include'), '-I', join(upstreamRoot, 'src', 'sundials'),
    '-I', join(solverRoot, 'headers', 'src', 'sundials'), '-I', join(upstreamRoot, 'src', 'idas')];
  const idasBuild = compiler?.exitCode === 0 && !compiler.timedOut
    ? await execute(['clang', ...idasFlags, privateSource, ...idasInputPaths.slice(1), ...solverArtifacts.map(x => x.path),
      '-Wl,-install_name,' + idasLibrary, '-o', idasLibrary]) : null;
  const nativeFixtureBuild = idasBuild?.exitCode === 0 && !idasBuild.timedOut
    ? await execute(['clang++', ...flags, nativeFixtureSource, idasLibrary, ...solverArtifacts.map(x => x.path), '-o', nativeFixtureBinary]) : null;
  const nativeFixtureRun = nativeFixtureBuild?.exitCode === 0 && !nativeFixtureBuild.timedOut
    ? await execute([nativeFixtureBinary, String(Math.max(0, allowanceSeconds - 2 - (performance.now() - began) / 1000))]) : null;
  let nativeFixtureResult: unknown = null;
  if (nativeFixtureRun && !nativeFixtureRun.timedOut) {
    try { nativeFixtureResult = JSON.parse(nativeFixtureRun.stdout); } catch { /* Retain failed fixture output; no field launch. */ }
  }
  const nativeFixturePassed = nativeFixtureRun?.exitCode === 0 && !nativeFixtureRun.timedOut
    && !!nativeFixtureResult && typeof nativeFixtureResult === 'object'
    && 'passed' in nativeFixtureResult && nativeFixtureResult.passed === true;
  const build = nativeFixturePassed
    ? await execute(['clang++', ...flags, source, idasLibrary, ...solverArtifacts.map(x => x.path), '-o', executable]) : null;
  // Let the native guard emit its admitted-state/cost receipt before the outer
  // Child deadline retains a final1s receipt reserve within the cumulative120s limit.
  const remaining = Math.max(0, allowanceSeconds - 2 - (performance.now() - began) / 1000);
  const run = build?.exitCode === 0 && !build.timedOut ? await execute([executable, String(remaining)]) : null;
  let nativeResult: unknown = null, parseFailure: string | null = null;
  if (run) { try { nativeResult = JSON.parse(run.stdout); } catch (error) { parseFailure = String(error); } }
  const passed = !!run && run.exitCode === 0 && !run.timedOut && typeof nativeResult === 'object'
    && nativeResult !== null && 'passed' in nativeResult && nativeResult.passed === true;
  const receipt = {
    schema: 'ld01-offline-native-liquid-axial-admission', recordedAt: new Date().toISOString(), passed,
    upstream: { project: 'CoolProp/IF97', version: '2.2.1', revision: nativeIf97Revision,
      headerSha256: nativeIf97HeaderSha256, licenseSha256: nativeIf97LicenseSha256, license: 'MIT' },
    solver: { project: 'SUNDIALS IDAS', version: '7.5.0', license: 'BSD-3-Clause',
      solverLicensePath, solverLicenseSha256: sha256(solverLicense), artifacts: solverArtifacts,
      idasInputs, headerInputs, idasLibrary,
      offlineConsistencyCandidate: { productionAdopted: false, privateSource, patchedSourceSha256,
        patchPath, patchSha256: sha256(patchBytes), baseSourceSha256: idasBaseSourceSha256,
        scope: 'Whole-state constraint correction/endpoint/history consistency only; no physical laws, tolerance or higher-column update changes. Sensitivities and adjoints unqualified.' },
      idasLibrarySha256: idasBuild?.exitCode === 0 ? sha256(await readFile(idasLibrary)) : null,
      generatedConfigSha256: sha256(await readFile(join(solverRoot, 'headers', 'include', 'sundials', 'sundials_config.h'))),
      loaderEnvironment: { DYLD_LIBRARY_PATH: dylibs },
      realization: 'Isolated upstreamable IDAS whole-state consistency candidate/native serial vectors/dense direct solver; 139 owned coordinates, 24 passive quadratures outside physical error control; 64-bit double, 32-bit indices' },
    artifact: { wrapperPath: import.meta.path, wrapperSha256: sha256(await readFile(import.meta.path)),
      primitiveModulePath: primitivePath.pathname, primitiveModuleSha256: primitiveSha256,
      primitivePayloadSha256: sha256(nativeIf97Primitives),
      geometryHelperSha256: sha256(await readFile(new URL('./reference-design-cmt-geometry.ts', import.meta.url))),
      pathHelperSha256: sha256(await readFile(new URL('./reference-design-cmt-balance-path.ts', import.meta.url))),
      cppSha256: sha256(cpp), scratch, source, executable,
      binarySha256: build?.exitCode === 0 ? sha256(await readFile(executable)) : null },
    owner: { path: owner, sha256: sha256(ownerBytes) }, geometry,
    allowanceSeconds, aggregateElapsedSeconds: (performance.now() - began) / 1000,
    aggregateBudget: { maximumSeconds: 120, priorChargeSeconds,
      priorReceipt: priorBytes ? { path: resolve(priorToolingFailurePath!), sha256: sha256(priorBytes),
        actualElapsedSeconds: prior.aggregateElapsedSeconds } : null,
      cumulativeChargedSeconds: priorChargeSeconds + (performance.now() - began) / 1000 },
    regressionInputs, staticRegressions, patchApplication,
    nativeFixture: { modulePath: nativeFixtureModulePath, moduleSha256: nativeFixtureModuleSha256,
      source: nativeFixtureSource, sourceSha256: sha256(nativeIdasConsistencyFixture), executable: nativeFixtureBinary,
      binarySha256: nativeFixtureBuild?.exitCode === 0 ? sha256(await readFile(nativeFixtureBinary)) : null,
      build: nativeFixtureBuild, run: nativeFixtureRun, result: nativeFixtureResult },
    compiler, flags, idasFlags, idasBuild, build, run, nativeResult, parseFailure,
    scope: 'One finite all-liquid isolated CMT60/BAL1 assembly, real closed header/outlets,30s and paired temporal weights. No maintained fluid boundaries, injection, primary return, phase/NC advancement, actuator qualification, spatial convergence, empirical fidelity, whole plant or multiunit performance claim.',
  };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });return receipt;
}
if (import.meta.main) {
  if (Bun.argv.length !== 7 && Bun.argv.length !== 9) throw Error('Expected IF97_DIR SUNDIALS_ROOT DYLIB_DIR GEOMETRY_OWNER NEW_RECEIPT.json [REMAINING_SECONDS AUTHORIZED_PRIOR_COMPILE_FAILURE.json]');
  const receipt = await runNativeAxialAdmission(Bun.argv[2]!, Bun.argv[3]!, Bun.argv[4]!, Bun.argv[5]!, Bun.argv[6]!,
    Bun.argv.length === 9 ? { allowanceSeconds: Number(Bun.argv[7]), previousSetupReceipt: Bun.argv[8]! } : undefined);
  console.log(JSON.stringify({ passed: receipt.passed, receipt: resolve(Bun.argv[6]!),
    elapsed: receipt.aggregateElapsedSeconds, nativeResult: receipt.nativeResult,
    patchError: receipt.patchApplication?.exitCode !== 0 ? receipt.patchApplication?.stderr : null,
    fixtureBuildError: receipt.nativeFixture.build?.exitCode !== 0 ? receipt.nativeFixture.build?.stderr : null,
    fixtureError: receipt.nativeFixture.run?.exitCode !== 0 ? receipt.nativeFixture.run?.stderr : null,
    solverBuildError: receipt.idasBuild?.exitCode !== 0 ? receipt.idasBuild?.stderr : null,
    buildError: receipt.build?.exitCode !== 0 ? receipt.build?.stderr : null,
    runError: receipt.run?.exitCode !== 0 ? receipt.run?.stderr : null }, null, 2));
  if (!receipt.passed) process.exitCode = 1;
}
