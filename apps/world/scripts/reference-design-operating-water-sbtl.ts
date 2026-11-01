/** IAPWS G13-15 SBTL (Spline-Based Table Look-up) for the operating water
 * boundary: the shared C++ part (table layout, transforms, cell polynomial),
 * the generator that tabulates the reference IF97 branches, and the
 * evaluator compiled into the water archive beside the reference path. The
 * method is chosen by an explicit composition setting (water-ffi); IF97 stays
 * the reference these tables reproduce. Owner decision, 1 Nov 2026. */

/** The tables' grids, recorded in the build receipt. Branch 0 is the liquid
 * (IF97 region 1, region 3 above 623.15 K), branch 1 the vapor (region 2,
 * region 3 between saturation and B23). n1 nodes along x1 = ln p + b p/10 MPa
 * over [611.657 Pa, the branch ceiling], n2 along the scaled temperature s in
 * [0, 1]; a sets the node concentration toward saturation. */
export const sbtlGrids=[
  {branch:0,n1:200,n2:300,a:0.4,b:14},
  {branch:1,n1:200,n2:240,a:0.1,b:14},
] as const

// spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#sbtl-water-properties
/** Shared by the generator and the evaluator: one definition of the layout,
 * the coordinate transforms and the cell polynomial. Follows the adapter
 * source (it uses r4, saturation_slope, trial_max_k and the ceilings). */
export const sbtlCommon=String.raw`
#include <cstdint>
#include <cstring>
namespace sbtl {
// Tabulated per branch (G13-15 Sec. 10, user-specified functions of (p,T)):
// u; W = v (liquid) or p v (vapor), so h = u + p v exactly at fixed p; cp;
// alpha; kappa (liquid) or p kappa (vapor); ln mu; conductivity k.
constexpr int U=0,W=1,CP=2,ALPHA=3,KAPPA=4,LNMU=5,K=6,NPROP=7;
struct Grid { int32_t branch,n1,n2,nprop; double x1min,x1max,t0,tmax,a,b,margin; };
struct Header { char magic[8]; int32_t version,count; Grid grid[2]; };
// x1 = ln p + b p / 10 MPa: smooth and denser at operating pressures.
inline double x1_of(const Grid& g,double p){return std::log(p)+g.b*p*1e-7;}
inline double dx1(const Grid& g,double p){return 1/p+g.b*1e-7;}
// The scaled temperature s in [0,1] at fixed p (G13-15 Sec. 3.2.2 scaling):
// liquid T = t0 + (Tsat + margin - t0) G(s), vapor T = (Tsat - margin) +
// (tmax - Tsat + margin) G(s); G concentrates nodes toward saturation with an
// analytic inverse. margin is the band's trial departure (trialMax_K) up to
// the band's top pressure (see margin below).
inline double q_(double a,double s){return (s*s+a*s)/(1+a);}
inline double dq(double a,double s){return (2*s+a)/(1+a);}
inline double qinv(double a,double f){return (-a+std::sqrt(a*a+4*(1+a)*f))/2;}
inline double G(const Grid& g,double s){return g.branch?q_(g.a,s):1-q_(g.a,1-s);}
inline double dG(const Grid& g,double s){return g.branch?dq(g.a,s):dq(g.a,1-s);}
inline double Ginv(const Grid& g,double f){return g.branch?qinv(g.a,f):1-qinv(g.a,1-f);}
// The table's margin beyond saturation: the band's trial departure up to the
// band's top pressure, where the band admits metastable states; above it,
// where every state is stable, it shrinks to 0 by a C2 smootherstep over
// 4 MPa (a table-construction width chosen by the measured deviations, not a
// physical value), so the grid never reaches the region-3 metastable states
// near the critical point.
inline void margin(const Grid& g,double p,double& m,double& dm){
 const double width=4e6,x=(p-band_pressure_high_pa)/width;
 if(x<=0){m=g.margin;dm=0;}
 else if(x>=1){m=0;dm=0;}
 else{m=g.margin*(1-x*x*x*(10-15*x+6*x*x));dm=-g.margin*30*x*x*(1-x)*(1-x)/width;}
}
// lo and span of the scaling at p, with their p-derivatives.
struct Scale{double lo,span,dlo,dspan;};
inline Scale scale(const Grid& g,double p,double ts,double slope){
 double m,dm;margin(g,p,m,dm);
 return g.branch?Scale{ts-m,g.tmax-(ts-m),slope-dm,dm-slope}:Scale{g.t0,ts+m-g.t0,0.,slope+dm};
}
inline double T_of(const Grid& g,const Scale& c,double s){return c.lo+c.span*G(g,s);}
inline double s_of(const Grid& g,const Scale& c,double T){return Ginv(g,(T-c.lo)/c.span);}
// One property in cell coordinates: a[k*3+l] multiplies d1^k d2^l (Eq. 2.2).
inline void cell(const double* a,double e1,double e2,double& z,double& z1,double& z2){
 const double q0=a[0]+e2*(a[1]+e2*a[2]),q1=a[3]+e2*(a[4]+e2*a[5]),q2=a[6]+e2*(a[7]+e2*a[8]);
 z=q0+e1*(q1+e1*q2);z1=q1+2*e1*q2;
 const double r1=a[1]+e1*(a[4]+e1*a[7]),r2=a[2]+e1*(a[5]+e1*a[8]);
 z2=r1+2*e2*r2;
}
inline Grid grid(int branch,int n1,int n2,double a,double b) {
 Grid g{};g.branch=branch;g.n1=n1;g.n2=n2;g.nprop=NPROP;g.t0=IF97::Tmin;g.tmax=IF97::Tmax;g.a=a;g.b=b;g.margin=trial_max_k;
 g.x1min=x1_of(g,pressure_floor_pa);g.x1max=x1_of(g,branch?vapor_ceiling_pa:liquid_ceiling_pa);
 return g;
}
}  // namespace sbtl
`

/** The generator's main: node values from the reference branches, the
 * tensor-product bi-quadratic spline (G13-15 Eqs. 2.13-2.33: knots at node
 * midpoints, the outer derivatives and corner cross derivatives from the
 * function), per-cell coefficients, written to argv[1]. Deterministic: fixed
 * order, no randomness; compiled with -ffp-contract=off. */
export const sbtlGeneratorMain=(grids:typeof sbtlGrids)=>String.raw`
#include <array>
#include <cstdio>
#include <functional>
#include <vector>
namespace sbtl {
// The reference value at (p,T) on a branch, where the reference admits it:
// liquid region 1 up to 623.15 K and region 3 above it (dense_side, liquid
// side); vapor region 2, and region 3 above 623.15 K beyond B23's pressure
// (dense_side, vapor side). Beyond the admitted domain (metastable states the
// band does not admit, nodes needed for the rectangular grid) the same
// equation on the same side continues it (G13-15 Sec. 4.2: "obtained by
// appropriate extrapolation"); those states are never returned.
// Where (T,p) lies outside region 3's own domain (liquid above 623.15 K below
// B23's pressure, never admitted) its backward equations do not apply: the
// region-3 basic equation's liquid root is found from region 1's density at
// 623.15 K by IF97.h's own Newton (Region3::rhomass), checked as dense_side.
State dense_continued(double T,double p) {
 State q=dense(T,r3.rhomass(T,p,c1.rhomass(IF97::T23min,p)));
 require(std::abs(q.p-p)<=1,"SBTL generator: region-3 continuation pressure defect exceeds 1 Pa");
 q.p=p;return q;
}
std::array<double,NPROP> node(int branch,double p,double T) {
 State q;
 if(branch==0) q=T<=IF97::T23min?c1.caloric(1,T,p):p>IF97::Region23_T(T)?dense_side(T,p,true):dense_continued(T,p);
 else q=(T>IF97::T23min&&p>IF97::Region23_T(T))?dense_side(T,p,false):c2.caloric(2,T,p);
 complete_state(q,FIELD_KAPPA|FIELD_MU|FIELD_K);
 const std::array<double,NPROP> z{{q.u,branch?q.p/q.rho:1/q.rho,q.cp,q.alpha,branch?q.p*q.kappa:q.kappa,std::log(q.mu),q.conductivity}};
 for(double v:z) require(std::isfinite(v),"SBTL generator: non-finite node value");
 return z;
}
// x1 -> p by Newton on the smooth monotone map (generator only).
double p_of(const Grid& g,double x1){
 double p=std::exp(x1);
 for(int k=0;k<60;++k) p-=(x1_of(g,p)-x1)/dx1(g,p);
 return p;
}
std::array<double,NPROP> at(const Grid& g,double x1,double s){
 const double p=p_of(g,x1),ts=r4.T_p(p);
 return node(g.branch,p,T_of(g,scale(g,p,ts,saturation_slope(p)),s));
}
// 1D quadratic spline with knots at node midpoints (Eqs. 1.8-1.12): node
// values z, outer-knot derivatives d0, dn, half-width hh -> knot values.
std::vector<double> knots(const std::vector<double>& z,double d0,double dn,double hh){
 const int n=(int)z.size();std::vector<double> lo(n+1),di(n+1),up(n+1),r(n+1);
 di[0]=3;up[0]=1;r[0]=4*z[0]-2*hh*d0;
 for(int m=1;m<n;++m){lo[m]=1;di[m]=6;up[m]=1;r[m]=4*(z[m-1]+z[m]);}
 lo[n]=1;di[n]=3;r[n]=4*z[n-1]+2*hh*dn;
 for(int m=1;m<=n;++m){const double w=lo[m]/di[m-1];di[m]-=w*up[m-1];r[m]-=w*r[m-1];}
 std::vector<double> K(n+1);K[n]=r[n]/di[n];
 for(int m=n-1;m>=0;--m)K[m]=(r[m]-up[m]*K[m+1])/di[m];
 return K;
}
using P=std::array<double,NPROP>;
// Fourth-order central difference of the function for the outer derivatives.
P D(const std::function<P(double)>& f,double x,double e){
 const P a=f(x-2*e),b=f(x-e),c=f(x+e),d=f(x+2*e);P o;
 for(int k=0;k<NPROP;++k)o[k]=(a[k]-8*b[k]+8*c[k]-d[k])/(12*e);
 return o;
}
std::vector<double> table(const Grid& g){
 const int n1=g.n1,n2=g.n2,L1=2*n1+1,L2=2*n2+1;
 const double d1=(g.x1max-g.x1min)/n1,d2=1.0/n2,h1=d1/2,h2=d2/2,e1=1e-4*d1,e2=1e-4*d2;
 auto X1=[&](int a){return g.x1min+a*h1;};auto X2=[&](int b){return b*h2;};
 std::vector<P> V((size_t)L1*L2);auto v=[&](int a,int b)->P&{return V[(size_t)a*L2+b];};
 for(int a=1;a<L1;a+=2)for(int b=1;b<L2;b+=2)v(a,b)=at(g,X1(a),X2(b));
 for(int b=1;b<L2;b+=2){
  const auto f=[&](double x){return at(g,x,X2(b));};const P d0=D(f,g.x1min,e1),dn=D(f,g.x1max,e1);
  for(int k=0;k<NPROP;++k){std::vector<double> z(n1);for(int i=0;i<n1;++i)z[i]=v(2*i+1,b)[k];
   const auto K=knots(z,d0[k],dn[k],h1);for(int i=0;i<=n1;++i)v(2*i,b)[k]=K[i];}
 }
 std::vector<P> E0(L1),EN(L1);
 for(int side=0;side<2;++side){
  auto& E=side?EN:E0;const double s=side?1.:0.;
  for(int a=1;a<L1;a+=2)E[a]=D([&](double y){return at(g,X1(a),y);},s,e2);
  const auto dx2=[&](double x){return D([&](double y){return at(g,x,y);},s,e2);};
  const P c0=D(dx2,g.x1min,e1),cn=D(dx2,g.x1max,e1);
  for(int k=0;k<NPROP;++k){std::vector<double> z(n1);for(int i=0;i<n1;++i)z[i]=E[2*i+1][k];
   const auto K=knots(z,c0[k],cn[k],h1);for(int i=0;i<=n1;++i)E[2*i][k]=K[i];}
 }
 for(int a=0;a<L1;++a)for(int k=0;k<NPROP;++k){
  std::vector<double> z(n2);for(int j=0;j<n2;++j)z[j]=v(a,2*j+1)[k];
  const auto K=knots(z,E0[a][k],EN[a][k],h2);for(int j=0;j<=n2;++j)v(a,2*j)[k]=K[j];
 }
 std::vector<double> out((size_t)n1*n2*NPROP*9);
 for(int i=0;i<n1;++i)for(int j=0;j<n2;++j)for(int k=0;k<NPROP;++k){
  double M[3][3],Q[3][3];
  for(int x=0;x<3;++x)for(int y=0;y<3;++y)M[x][y]=v(2*i+x,2*j+y)[k];
  for(int y=0;y<3;++y){Q[0][y]=M[1][y];Q[1][y]=(M[2][y]-M[0][y])/(2*h1);Q[2][y]=(M[2][y]+M[0][y]-2*M[1][y])/(2*h1*h1);}
  double* c=&out[(((size_t)i*n2+j)*NPROP+k)*9];
  for(int x=0;x<3;++x){c[x*3]=Q[x][1];c[x*3+1]=(Q[x][2]-Q[x][0])/(2*h2);c[x*3+2]=(Q[x][2]+Q[x][0]-2*Q[x][1])/(2*h2*h2);}
 }
 return out;
}
}  // namespace sbtl
int main(int argc,char** argv){
 if(argc!=2)return 2;
 try{
  sbtl::Header h{};std::memcpy(h.magic,"LD01SBTL",8);h.version=1;h.count=2;
  ${grids.map(g=>`h.grid[${g.branch}]=sbtl::grid(${g.branch},${g.n1},${g.n2},${g.a},${g.b});`).join('')}
  std::FILE* f=std::fopen(argv[1],"wb");if(!f)return 3;
  std::fwrite(&h,sizeof h,1,f);
  for(int b=0;b<2;++b){const auto t=sbtl::table(h.grid[b]);std::fwrite(t.data(),sizeof(double),t.size(),f);}
  return std::fclose(f)==0?0:3;
 }catch(const std::exception& e){std::fprintf(stderr,"%s\n",e.what());return 1;}
}
`

/** The evaluator compiled into the water archive: the same C ABI shapes as
 * the reference entries (ld01_sbtl_* beside ld01_water_*), the same branch,
 * domain, band and status rules (the adapter's branch_state on SBTL values),
 * and analytic derivatives of the evaluated splines for every direction. */
export const sbtlEvaluator=String.raw`
extern "C" const unsigned char ld01_sbtl_table[];
extern "C" const unsigned char ld01_sbtl_table_end[];
namespace sbtl {
struct Table { Grid g; const double* a; double d1,d2; };
struct Tables { Table t[2]; };
// The embedded table (read-only data of this archive), checked once.
const Tables& tables(){
 static const Tables T=[]{
  Header h;std::memcpy(&h,ld01_sbtl_table,sizeof h);
  require(std::memcmp(h.magic,"LD01SBTL",8)==0&&h.version==1&&h.count==2,"SBTL table header");
  Tables o{};size_t off=sizeof h;
  for(int b=0;b<2;++b){
   const Grid& g=h.grid[b];
   require(g.branch==b&&g.nprop==NPROP&&g.n1>0&&g.n2>0,"SBTL table grid");
   o.t[b]={g,reinterpret_cast<const double*>(ld01_sbtl_table+off),(g.x1max-g.x1min)/g.n1,1.0/g.n2};
   off+=(size_t)g.n1*g.n2*NPROP*9*sizeof(double);
  }
  require(ld01_sbtl_table+off==ld01_sbtl_table_end,"SBTL table size");
  return o;
 }();
 return T;
}
// Fields with their partials in p (at T) and in T (at p).
struct Fields { double rho,u,h,cp,alpha,kappa,mu,k; };
struct Point { Fields v,dp,dT; };
// The latest evaluation on this thread, read by the direction entries right
// after the admission (branch_state) that evaluated it.
thread_local Point last;
Point eval(int b,double p,double T){
 const Table& t=tables().t[b];const Grid& g=t.g;
 const double ts=r4.T_p(p),slope=saturation_slope(p);
 const Scale c=scale(g,p,ts,slope);
 const double x1=x1_of(g,p),s=s_of(g,c,T),u1=(x1-g.x1min)/t.d1,u2=s/t.d2;
 require(u1>=-1e-9&&u1<=g.n1*(1+1e-12)&&u2>=-1e-9&&u2<=g.n2*(1+1e-12),"Outside the SBTL table");
 const int i=std::min(std::max((int)std::floor(u1),0),g.n1-1),j=std::min(std::max((int)std::floor(u2),0),g.n2-1);
 const double e1=x1-(g.x1min+(i+.5)*t.d1),e2=s-(j+.5)*t.d2;
 const double Gp=dG(g,s),dsdT=1/(c.span*Gp),dsdp=-(c.dlo+c.dspan*G(g,s))/(c.span*Gp),dxdp=dx1(g,p);
 const double* a=t.a+((size_t)i*g.n2+j)*NPROP*9;
 double z[NPROP],zp[NPROP],zT[NPROP];
 for(int k=0;k<NPROP;++k){double v,v1,v2;cell(a+9*k,e1,e2,v,v1,v2);z[k]=v;zp[k]=v1*dxdp+v2*dsdp;zT[k]=v2*dsdT;}
 const bool vap=b==1;
 const double pv=vap?z[W]:p*z[W],pvp=vap?zp[W]:z[W]+p*zp[W],pvT=vap?zT[W]:p*zT[W];
 const double rho=p/pv,mu=std::exp(z[LNMU]);
 const double kap=vap?z[KAPPA]/p:z[KAPPA],kapp=vap?zp[KAPPA]/p-z[KAPPA]/(p*p):zp[KAPPA],kapT=vap?zT[KAPPA]/p:zT[KAPPA];
 Point o;
 o.v={rho,z[U],z[U]+pv,z[CP],z[ALPHA],kap,mu,z[K]};
 o.dp={(1-rho*pvp)/pv,zp[U],zp[U]+pvp,zp[CP],zp[ALPHA],kapp,mu*zp[LNMU],zp[K]};
 o.dT={-rho*pvT/pv,zT[U],zT[U]+pvT,zT[CP],zT[ALPHA],kapT,mu*zT[LNMU],zT[K]};
 return o;
}
State state(int b,int region,double T,double p){
 last=eval(b,p,T);
 const double none=std::numeric_limits<double>::quiet_NaN();const Fields& f=last.v;
 return State{region,p,T,f.rho,f.u,f.h,none,f.cp,none,none,f.alpha,f.kappa,f.mu,f.k};
}
int liquid_region(double T){return T<=IF97::T23min?1:3;}
int vapor_region(double T,double p){return T>IF97::T23min&&p>IF97::Region23_T(T)?3:2;}
// branch_state's tuple on the tables: the reference stable paths' checks and
// refusals (liquid_caloric, vapor_caloric, point_caloric, endpoint_caloric)
// in the same order, then the branch table at (p,T).
struct Tuple {
 static State liquid_equation(double T,double p){return state(0,liquid_region(T),T,p);}
 static State vapor_equation(double T,double p){return state(1,2,T,p);}
 static State stable_liquid(double T,double p){
  require(p>0&&p<IF97::Pcrit&&T<=r4.T_p(p),"Liquid left its stable subcritical branch");
  switch(IF97::RegionDetermination_TP(T,p)){
   case IF97::REGION_1:case IF97::REGION_3:return state(0,liquid_region(T),T,p);
   case IF97::REGION_2:case IF97::REGION_5:throw std::domain_error("Actual liquid queried a gas branch");
   default:throw std::domain_error("Ambiguous PT saturation pair needs explicit endpoint/inventory");
  }
 }
 static State stable_vapor(double T,double p){
  require(std::isfinite(p)&&p>0&&T>=IF97::Tmin&&T<=IF97::Text,"Invalid actual vapor PT");
  if(T<=IF97::Tcrit) require(p<=r4.p_T(T),"Supersaturated vapor is not this active branch");
  // The vapor table ends at region 2's 1073.15 K; region 5 is not tabulated.
  require(T<=IF97::Tmax,"SBTL vapor table ends at 1073.15 K");
  switch(IF97::RegionDetermination_TP(T,p)){
   case IF97::REGION_2:case IF97::REGION_3:return state(1,vapor_region(T,p),T,p);
   case IF97::REGION_1:throw std::domain_error("Actual gas queried a liquid branch");
   default:throw std::domain_error("Ambiguous PT saturation pair needs explicit endpoint/inventory");
  }
 }
 static State saturated(double p,bool is_liquid){
  require(p>=IF97::Pmin&&p<IF97::Pcrit,"Unsupported saturation endpoint domain");
  const double T=r4.T_p(p);
  return is_liquid?state(0,liquid_region(T),T,p):state(1,T<=IF97::T23min?2:3,T,p);
 }
 static State dense_liquid(double T,double p){return state(0,3,T,p);}
 static State dense_vapor(double T,double p){return state(1,3,T,p);}
};
// The value a caloric inverse matches: u, or h = u + p v.
double target_of(const Fields& f,bool enthalpy){return enthalpy?f.h:f.u;}
}  // namespace sbtl
extern "C" {
static int sbtl_point_at(int branch,double p,double T,OperatingWaterPoint* out) {
 State q;double ts;
 const int status=branch_state<sbtl::Tuple>(branch,p,T,q,ts,true);if(status)return status;
 const double slope=saturation_slope(q.p);
 require(std::isfinite(slope)&&slope>0,"Invalid saturation derivative");
 *out={q.region,q.p,q.T,q.rho,q.u,q.h,q.cp,q.cv,q.alpha,q.kappa,q.mu,q.conductivity,slope,q.T-ts};
 return 0;
}
// ld01_water_point on the tables: every field but cv (NaN: not tabulated,
// nothing reads it).
int ld01_sbtl_point(int branch,double p,double T,OperatingWaterPoint* out) noexcept {
 if(!out) return 2;
 try{return sbtl_point_at(branch,p,T,out);}
 catch(const std::domain_error&){return 1;}
 catch(...){return 3;}
}
static void sbtl_direction_of(const OperatingWaterPoint& q,double dp,double dT,OperatingWaterPoint& d){
 const sbtl::Point& e=sbtl::last;
 const auto f=[&](double sbtl::Fields::*m){return e.dp.*m*dp+e.dT.*m*dT;};
 d={};d.region=q.region;d.p=dp;d.T=dT;
 d.rho=f(&sbtl::Fields::rho);d.u=f(&sbtl::Fields::u);d.h=f(&sbtl::Fields::h);d.cp=f(&sbtl::Fields::cp);
 d.alpha=f(&sbtl::Fields::alpha);d.kappa=f(&sbtl::Fields::kappa);d.mu=f(&sbtl::Fields::mu);
 d.conductivity=f(&sbtl::Fields::k);
 d.cv=std::numeric_limits<double>::quiet_NaN();
 // The saturation slope's own direction is not evaluated (nothing reads it).
 d.saturation_slope=std::numeric_limits<double>::quiet_NaN();
 d.saturation_departure=dT-q.saturation_slope*dp;
}
// ld01_water_direction on the tables: the analytic derivative of the
// evaluated splines along (dp,dT); a saturated branch moves along saturation,
// dT = (dTsat/dp) dp, with the endpoint's z(p, Tsat(p)) chain rule.
int ld01_sbtl_direction(int branch,double p,double T,double dp,double dT,
 OperatingWaterPoint* out,OperatingWaterPoint* direction) noexcept {
 if(!out||!direction||!std::isfinite(dp)||!std::isfinite(dT))return 2;
 try{
  OperatingWaterPoint q{},d{};
  const int status=sbtl_point_at(branch,p,T,&q);if(status)return status;
  sbtl_direction_of(q,dp,branch==2||branch==3?q.saturation_slope*dp:dT,d);
  *out=q;*direction=d;return 0;
 }catch(const std::domain_error&){return 1;}
 catch(...){return 3;}
}
// The caloric inverse on the tables: T(p,u) or T(p,h) on a liquid or vapor
// branch, with the reference inverse's brackets and refusals (stable end at
// saturation, the band's trial end, the far ends 273.15 K and 1073.15 K;
// TrialBand beyond the trial end, Domain beyond the far end, never clamped).
// In the bracket the root is exact: a search over the cells' lower knot
// lines at this p, then the cell's quadratic in s (Eq. 2.42, its
// cancellation-free form). The returned point is the forward point at the
// root's (p,T).
int ld01_sbtl_inverse(int branch,double p,double target,int enthalpy,OperatingWaterPoint* out) noexcept {
 if(!out||(branch!=0&&branch!=1)||(enthalpy!=0&&enthalpy!=1))return 2;
 try{
  if(!std::isfinite(target))return 1;
  const bool liquid=branch==0,hk=enthalpy==1;
  require(std::isfinite(p)&&p>=pressure_floor_pa&&p<=(liquid?liquid_ceiling_pa:vapor_ceiling_pa),
   "Operating water pressure domain");
  const double ts=r4.T_p(p);
  const double end=sbtl::target_of(sbtl::eval(branch,p,ts).v,hk);
  double lo,hi;
  if((liquid&&target>end)||(!liquid&&target<end)){
   if(!in_band(p)||(liquid&&!(ts<liquid_temperature_max_k)))return TRIAL_BAND;
   const double trial=liquid?std::min(ts+trial_max_k,liquid_temperature_max_k):ts-trial_max_k;
   const double edge=sbtl::target_of(sbtl::eval(branch,p,trial).v,hk);
   if((liquid&&target>edge)||(!liquid&&target<edge))return TRIAL_BAND;
   lo=liquid?ts:trial;hi=liquid?trial:ts;
  }else{
   if(target==end)return ld01_sbtl_point(liquid?2:3,p,0.,out);
   const double far=liquid?IF97::Tmin:IF97::Tmax;
   const double v=sbtl::target_of(sbtl::eval(branch,p,far).v,hk);
   if((liquid&&target<v)||(!liquid&&target>v))return 1;
   lo=liquid?far:ts;hi=liquid?ts:far;
  }
  const sbtl::Table& t=sbtl::tables().t[branch];const sbtl::Grid& g=t.g;
  const sbtl::Scale c=sbtl::scale(g,p,ts,saturation_slope(p));
  const double x1=sbtl::x1_of(g,p);
  const int i=std::min(std::max((int)std::floor((x1-g.x1min)/t.d1),0),g.n1-1);
  const double e1=x1-(g.x1min+(i+.5)*t.d1),h2=t.d2/2,f=liquid?p:1.;
  // The target's polynomial in e2 of cell (i,j) at this e1: A e2^2 + B e2 + C.
  const auto quad=[&](int j,double& A,double& B,double& C){
   const double* a=t.a+((size_t)i*g.n2+j)*sbtl::NPROP*9;double q[9];
   for(int m=0;m<9;++m)q[m]=a[9*sbtl::U+m]+(hk?f*a[9*sbtl::W+m]:0.);
   C=q[0]+e1*(q[3]+e1*q[6]);B=q[1]+e1*(q[4]+e1*q[7]);A=q[2]+e1*(q[5]+e1*q[8]);
  };
  const auto low=[&](int j){double A,B,C;quad(j,A,B,C);return C-h2*B+h2*h2*A;};
  const auto cell_of=[&](double T){return std::min(std::max((int)std::floor(sbtl::s_of(g,c,T)/t.d2),0),g.n2-1);};
  // The last cell in the bracket whose lower knot line lies at or below the target.
  int a=cell_of(lo),b=cell_of(hi);
  while(a<b){const int m=a+(b-a+1)/2;if(low(m)<=target)a=m;else b=m-1;}
  double A,B,C;quad(a,A,B,C);C-=target;
  const double disc=B*B-4*A*C;require(disc>=0,"SBTL inverse: no root in the cell");
  const double e2=-2*C/(B+std::copysign(std::sqrt(disc),B));
  // The root lies in the bracket up to rounding of the cell's last place.
  const double T=std::min(std::max(sbtl::T_of(g,c,(a+.5)*t.d2+e2),lo),hi);
  return sbtl_point_at(branch,p,T,out);
 }catch(const std::domain_error&){return 1;}
 catch(...){return 3;}
}
// The caloric inverse's direction at a point it returned (held): the implicit
// derivative of the spline inverse, dT = (dtarget - t_p dp) / t_T with t = u
// or h, then every field's analytic direction along (dp, dT).
int ld01_sbtl_inverse_direction(int branch,const OperatingWaterPoint* held,int enthalpy,double dp,double dtarget,
 OperatingWaterPoint* direction) noexcept {
 if(!held||!direction||(branch!=0&&branch!=1)||(enthalpy!=0&&enthalpy!=1)||!std::isfinite(dp)||!std::isfinite(dtarget))return 2;
 try{
  OperatingWaterPoint q{},d{};
  const int status=sbtl_point_at(branch,held->p,held->T,&q);if(status)return status;
  const sbtl::Point& e=sbtl::last;
  const double tp=sbtl::target_of(e.dp,enthalpy==1),tT=sbtl::target_of(e.dT,enthalpy==1);
  if(!std::isfinite(tT)||!(tT>0))return 3;
  sbtl_direction_of(q,dp,(dtarget-tp*dp)/tT,d);
  *direction=d;return 0;
 }catch(const std::domain_error&){return 1;}
 catch(...){return 3;}
}
// The saturation entries by temperature (vapor density, enthalpy, viscosity)
// compose ld01_sbtl_point/direction with IF97's p_sat(T) in water-ffi.
}
`

/** The tables' check (G13-15 Secs. 4.5/5.5 deviations and the numerical
 * consistency of Secs. 3.2.3/3.2.5): linked with the archive's own objects,
 * it compares ld01_sbtl_* with the reference ld01_water_* at points spread
 * uniformly in ln p and T over each branch's admitted domain (the band
 * included), and prints one JSON object. Deterministic (a fixed LCG). */
export const sbtlCheckerMain=(points:number)=>String.raw`
#include <cstdio>
#include <cstdint>
#include <cmath>
#include <algorithm>
extern "C" {
struct OWP { int region; double p,T,rho,u,h,cp,cv,alpha,kappa,mu,k,slope,dep; };
int ld01_water_point(int,double,double,OWP*);
int ld01_sbtl_point(int,double,double,OWP*);
int ld01_sbtl_direction(int,double,double,double,double,OWP*,OWP*);
int ld01_sbtl_inverse(int,double,double,int,OWP*);
int ld01_water_metastable_band(double*);
}
static uint64_t st=0x9e3779b97f4a7c15ull;
static double rnd(){st=st*6364136223846793005ull+1442695040888963407ull;return (st>>11)*(1.0/9007199254740992.0);}
struct Stat{double max=0,sum=0,at_p=0,at_T=0;long n=0;void add(double e,double p,double T){sum+=e*e;++n;if(e>max){max=e;at_p=p;at_T=T;}}};
// IF97 Eq. (6), the B23 temperature at p (n3, n4, n5 of Table 1).
static double b23T(double p){const double n3=0.10192970039326e-2,n4=0.57254459862746e3,n5=0.13918839778870e2;
 return n4+std::sqrt((p/1e6-n5)/n3);}
int main(){
 const long N=${points};
 double band[10];ld01_water_metastable_band(band);
 const double lowp=band[0],highp=band[1],trial=band[2],tl=band[6],ceil_l=band[7],ceil_v=band[8];
 std::printf("{\"points\":%ld,\"branches\":[",N);
 long inconsistent=0;
 for(int b=0;b<2;++b){
  Stat dev[2][10];Stat inv,c0,sat;long refused=0;
  const char* nm[10]={"rho","u","h","cp","alpha","kappa","mu","k","T_ph_K","T_pu_K"};
  for(long q=0;q<N;++q){
   const double p=std::exp(std::log(611.657)+rnd()*(std::log(b?ceil_v:ceil_l)-std::log(611.657)));
   OWP s;if(ld01_water_point(b?3:2,p,0,&s)){++refused;continue;}
   const double ts=s.T;const bool inb=p>lowp&&p<=highp;
   const double T=b==0?273.15+rnd()*(std::min(inb?ts+trial:ts,inb?tl:1e9)-273.15):(inb?ts-trial:ts)+rnd()*(1073.15-(inb?ts-trial:ts));
   OWP a,c;if(ld01_water_point(b,p,T,&a)||ld01_sbtl_point(b,p,T,&c)){++refused;continue;}
   const bool edge=std::abs(T-623.15)<0.5||(p>16.529e6&&std::abs(T-b23T(p))<0.5);
   const double r[8]={a.rho,a.u,a.h,a.cp,a.alpha,a.kappa,a.mu,a.k},g[8]={c.rho,c.u,c.h,c.cp,c.alpha,c.kappa,c.mu,c.k};
   // Relative, except u and h by their thermal scale cp T and alpha by 1/T.
   const double sc[8]={a.rho,a.cp*a.T,a.cp*a.T,a.cp,1/a.T,a.kappa,a.mu,a.k};
   for(int k=0;k<8;++k){const double e=std::abs(g[k]-r[k])/std::abs(sc[k]);dev[0][k].add(e,p,T);if(!edge)dev[1][k].add(e,p,T);}
   OWP ih,iu;
   if(!ld01_sbtl_inverse(b,p,a.h,1,&ih)){const double e=std::abs(ih.T-T);dev[0][8].add(e,p,T);if(!edge)dev[1][8].add(e,p,T);}
   if(!ld01_sbtl_inverse(b,p,a.u,0,&iu)){const double e=std::abs(iu.T-T);dev[0][9].add(e,p,T);if(!edge)dev[1][9].add(e,p,T);}
   // Consistency: the inverse of the spline's own value recovers T (Sec. 3.2.3).
   OWP ic;if(!ld01_sbtl_inverse(b,p,c.u,0,&ic))inv.add(std::abs(ic.T-T)/T,p,T);
   if(!ld01_sbtl_inverse(b,p,c.h,1,&ic))inv.add(std::abs(ic.T-T)/T,p,T);
   // h = u + p v exactly (one table for u and v at fixed p).
   c0.add(std::abs(c.h-c.u-p/c.rho)/std::abs(c.h),p,T);
   // Phase-boundary consistency (Sec. 3.2.5): the endpoint is the branch at (p,Tsat).
   OWP e,f;if(!ld01_sbtl_point(b?3:2,p,0,&e)&&!ld01_sbtl_point(b,p,e.T,&f))sat.add(std::abs(e.rho-f.rho)+std::abs(e.u-f.u),p,T);
  }
  if(inv.max>1e-12||c0.max>1e-12||sat.max!=0)++inconsistent;
  std::printf("%s{\"branch\":%d,\"refused\":%ld,\"inverseSelfConsistency\":%.3e,\"hEqualsUPlusPv\":%.3e,\"endpointEqualsBranch\":%.3e,\"deviation\":{",b?",":"",b,refused,inv.max,c0.max,sat.max);
  for(int z=0;z<2;++z){std::printf("%s\"%s\":{",z?",":"",z?"outsideIf97BoundaryBands":"all");
   for(int k=0;k<10;++k)std::printf("%s\"%s\":{\"max\":%.3e,\"rms\":%.3e,\"at\":[%.6g,%.6g]}",k?",":"",nm[k],dev[z][k].max,std::sqrt(dev[z][k].sum/std::max(dev[z][k].n,1L)),dev[z][k].at_p,dev[z][k].at_T);
   std::printf("}");}
  std::printf("}}");
 }
 std::printf("],\"inconsistentBranches\":%ld}\n",inconsistent);
 return inconsistent?1:0;
}
`

/** The assembler source embedding the table as read-only data. */
export const sbtlTableAssembly=(tablePath:string,platform:string)=>{
  const sym=(n:string)=>platform==='darwin'?'_'+n:n
  const section=platform==='darwin'?'.section __TEXT,__const':'.section .rodata'
  return `${section}\n.globl ${sym('ld01_sbtl_table')}\n.globl ${sym('ld01_sbtl_table_end')}\n.p2align 4\n`+
    `${sym('ld01_sbtl_table')}:\n.incbin ${JSON.stringify(tablePath)}\n${sym('ld01_sbtl_table_end')}:\n`
}
