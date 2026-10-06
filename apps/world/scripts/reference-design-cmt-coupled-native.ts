/** Bounded offline CMT/BAL operator and useful-duration qualification.
 * Consumes one actual axial kernel; no new integrator or live Pack registration.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { nativeAxialCandidate } from './reference-design-cmt-native-axial'
import { nativeIf97HeaderSha256, nativeIf97LicenseSha256 } from './reference-design-if97-primitives'

export const nativeCoupledDriver = String.raw`
#include <idas/idas.h>
#include <nvector/nvector_serial.h>
#include <sunmatrix/sunmatrix_dense.h>
#include <sunlinsol/sunlinsol_dense.h>

struct TrialRun {long residuals=0,jacobians=0,quadratures=0,recoverable=0;std::string failure;};
int residual_callback(double,N_Vector y,N_Vector dy,N_Vector out,void* opaque){
    auto&run=*static_cast<TrialRun*>(opaque);++run.residuals;
    try{const auto r=conservative_residual(N_VGetArrayPointer(y),N_VGetArrayPointer(dy));
        std::copy(r.begin(),r.end(),N_VGetArrayPointer(out));return 0;
    }catch(const std::exception&e){run.failure=e.what();++run.recoverable;
        return std::chrono::duration<double>(Clock::now()-started).count()>guard_seconds?-1:1;}}
int jacobian_callback(double,double cj,N_Vector y,N_Vector,N_Vector,SUNMatrix matrix,
    void* opaque,N_Vector,N_Vector,N_Vector){
    auto&run=*static_cast<TrialRun*>(opaque);++run.jacobians;
    try{const auto j=coupled_jacobian(N_VGetArrayPointer(y),cj);SUNMatZero(matrix);
        for(int r=0;r<D;++r)for(int c=0;c<D;++c)SM_ELEMENT_D(matrix,r,c)=j.dense[r*D+c];return 0;
    }catch(const std::exception&e){run.failure=e.what();++run.recoverable;
        return std::chrono::duration<double>(Clock::now()-started).count()>guard_seconds?-1:1;}}
int quadrature_callback(double,N_Vector y,N_Vector,N_Vector out,void* opaque){
    auto&run=*static_cast<TrialRun*>(opaque);++run.quadratures;
    try{const auto f=rates(N_VGetArrayPointer(y));std::copy(f.begin()+D,f.end(),N_VGetArrayPointer(out));return 0;
    }catch(const std::exception&e){run.failure=e.what();++run.recoverable;
        return std::chrono::duration<double>(Clock::now()-started).count()>guard_seconds?-1:1;}}
void solver_ok(int flag,const char* operation){require(flag>=0,std::string(operation)+": IDAS status "+std::to_string(flag));}
// Diagnostic getters must remain usable after the physical work guard expires.
void statistic_ok(int flag,const char* operation){if(flag<0)throw std::runtime_error(std::string(operation)+": IDAS status "+std::to_string(flag));}
struct Arm {
    double admitted=0,attained=0,wall=0,minStep=0,maxStep=0,massDefect=0,energyDefect=0,tracerDefect=0;
    double chartPressure=0,chartTemperature=0,maxTemperatureChange=0,totalQ=0,grossMass=0,grossEnergy=0;
    std::array<double,5> stageDefectWeights{},historyDerivativeDifferenceWeights{};
    long steps=0,errorFailures=0,nonlinearFailures=0,residuals=0,jacobians=0,quadratures=0,recoverable=0;
    std::array<long,6> orders{};std::array<double,OBSERVERS> receipts{};
    std::vector<std::array<double,SAMPLE>> common;
};
Arm partial;double activeFactor=1;std::vector<Arm> completed;
// Refused candidate diagnostics never overwrite the last admitted physical state.
struct Refusal {bool present=false;double time=0,value=0,limit=0;int cell=-1,field=-1;const char*check="none";} refusal;
struct StageDiagnostic {double time=0,h=0,maximum=0,wrms=0,derivative=0,rate=0,residual=0,atol=0;int cell=-1,field=-1,order=0;bool genuine=false;} stageDiagnostic;
void stage_json(){const auto&s=stageDiagnostic;std::cout<<"{\"timeSeconds\":"<<s.time<<",\"stepSeconds\":"<<s.h
    <<",\"order\":"<<s.order<<",\"genuineFLCStage\":"<<(s.genuine?"true":"false")<<",\"maximumStepScaledResidual\":"<<s.maximum
    <<",\"differentialWRMS\":"<<s.wrms<<",\"worstCell\":"<<s.cell<<",\"worstField\":"<<s.field
    <<",\"stageDerivative\":"<<s.derivative<<",\"rate\":"<<s.rate<<",\"residual\":"<<s.residual<<",\"nativeAbsoluteWeight\":"<<s.atol<<"}";}
void candidate_ok(bool ok,double time,int cell,int field,double value,double limit,const char*check){
    if(!ok)refusal={true,time,value,limit,cell,field,check};require(ok,check);}
void refusal_json(){std::cout<<"{\"present\":"<<(refusal.present?"true":"false")<<",\"timeSeconds\":"<<refusal.time
    <<",\"cell\":"<<refusal.cell<<",\"field\":"<<refusal.field<<",\"value\":";
    if(std::isfinite(refusal.value))std::cout<<refusal.value;else std::cout<<"null";
    std::cout<<",\"limit\":"<<refusal.limit<<",\"check\":\""<<refusal.check<<"\"}";}
std::array<double,3> native_totals(const double*y){std::array<double,3> out{};
    for(int i=0;i<N;++i){out[0]+=y[ix(i,M)];out[1]+=y[ix(i,E)];out[2]+=y[ix(i,B)];}return out;}
void arm_json(const Arm&a){std::cout<<"{\"lastAdmittedSeconds\":"<<a.admitted<<",\"solverAttainedSeconds\":"<<a.attained
    <<",\"wallSeconds\":"<<a.wall<<",\"steps\":"<<a.steps<<",\"minimumStepSeconds\":"<<a.minStep
    <<",\"maximumStepSeconds\":"<<a.maxStep<<",\"errorTestFailures\":"<<a.errorFailures
    <<",\"nonlinearFailures\":"<<a.nonlinearFailures<<",\"residualCallbacks\":"<<a.residuals
    <<",\"suppliedJacobianCallbacks\":"<<a.jacobians<<",\"quadratureCallbacks\":"<<a.quadratures
    <<",\"recoverableCallbackRefusals\":"<<a.recoverable<<",\"maximumMassDefectKg\":"<<a.massDefect
    <<",\"maximumEnergyDefectJ\":"<<a.energyDefect<<",\"maximumTracerDefectKgEq\":"<<a.tracerDefect
    <<",\"maximumChartPressureDefectPa\":"<<a.chartPressure<<",\"maximumChartTemperatureDefectK\":"<<a.chartTemperature
    <<",\"maximumReceivingTemperatureChangeK\":"<<a.maxTemperatureChange<<",\"totalReceivingQJ\":"<<a.totalQ
    <<",\"grossRingMassKg\":"<<a.grossMass<<",\"grossRingNativeEnergyJ\":"<<a.grossEnergy<<",\"orders\":[";
    for(int i=1;i<=5;++i){if(i>1)std::cout<<",";std::cout<<a.orders[i];}std::cout<<"],\"ringReceipts\":[";
    for(int j=0;j<OBSERVERS;++j){if(j)std::cout<<",";std::cout<<a.receipts[j];}
    std::cout<<"],\"stageDefectWeightsMPEBQ\":[";for(int j=0;j<5;++j){if(j)std::cout<<",";std::cout<<a.stageDefectWeights[j];}
    std::cout<<"],\"historyDerivativeDifferenceWeightsMPEBQ\":[";for(int j=0;j<5;++j){if(j)std::cout<<",";std::cout<<a.historyDerivativeDifferenceWeights[j];}std::cout<<"]}";}
Arm advance_arm(double factor){
    activeFactor=factor;partial=Arm{};Arm result;TrialRun run;const auto began=Clock::now();
    const auto initial=original();const auto initialTotals=native_totals(initial.data());const auto initialRates=rates(initial.data());
    SUNContext context=nullptr;solver_ok(SUNContext_Create(SUN_COMM_NULL,&context),"context");
    N_Vector y=N_VNew_Serial(D,context),dy=N_VClone(y),ids=N_VClone(y),atol=N_VClone(y),bounds=N_VClone(y);
    N_Vector history=N_VClone(y),historyDerivative=N_VClone(y),quad=N_VNew_Serial(OBSERVERS,context);
    require(y&&dy&&ids&&atol&&bounds&&history&&historyDerivative&&quad,"Native vectors unavailable");
    auto*x=N_VGetArrayPointer(y),*dx=N_VGetArrayPointer(dy),*id=N_VGetArrayPointer(ids);
    auto*tol=N_VGetArrayPointer(atol),*co=N_VGetArrayPointer(bounds);
    for(int j=0;j<D;++j){x[j]=initial[j];dx[j]=initialRates[j];id[j]=1;tol[j]=factor*1e-7;co[j]=0;}
    for(int i=0;i<N;++i){const auto&c=cells[i];const auto s=water(x[ix(i,TT)],x[ix(i,PP)]);
        const double Mc=c.V*s.rho,v=x[ix(i,P)]/Mc,common=s.u+gravity*c.z-v*v/2;
        const double Mp=Mc*s.kappa,Mt=-Mc*s.alpha,Ep=common*Mp+Mc*up(s),Et=common*Mt+Mc*ut(s),det=Mp*Et-Mt*Ep;
        require(det>0,"Initial chart rank failed");const double dp=50*factor,dT=.01*factor;
        tol[ix(i,M)]=std::min(dp*det/(2*std::abs(Et)),dT*det/(2*std::abs(Ep)));
        tol[ix(i,E)]=std::min(dp*det/(2*std::abs(Mt)),dT*det/(2*std::abs(Mp)));
        tol[ix(i,P)]=Mc*.001*factor;tol[ix(i,B)]=Mc*1e-8*factor;if(c.tank)tol[ix(i,Q)]=Mc*.001*factor;
        tol[ix(i,PP)]=dp;tol[ix(i,TT)]=dT;id[ix(i,PP)]=id[ix(i,TT)]=0;
        co[ix(i,M)]=co[ix(i,PP)]=co[ix(i,TT)]=2;co[ix(i,B)]=1;if(c.tank)co[ix(i,Q)]=1;
        const double massRate=initialRates[ix(i,M)];
        const double thermalRate=initialRates[ix(i,E)]-v*initialRates[ix(i,P)]-(c.tank?initialRates[ix(i,Q)]:0);
        dx[ix(i,PP)]=(massRate*Et-Mt*thermalRate)/det;dx[ix(i,TT)]=(Mp*thermalRate-massRate*Ep)/det;
    }
    const auto initialResidual=conservative_residual(x,dx);
    for(int j=0;j<D;++j){const int field=coordinateOwner[j].field;
        const double limit=field==PP?5*factor:field==TT?.001*factor:1e-6;
        require(std::isfinite(tol[j])&&tol[j]>0&&std::abs(initialResidual[j])<=limit,"Inconsistent original residual/error weight");}
    void*mem=IDACreate(context);require(mem,"IDAS unavailable");
    solver_ok(IDAInit(mem,residual_callback,0,y,dy),"initialization");solver_ok(IDASetUserData(mem,&run),"user data");
    solver_ok(IDASetId(mem,ids),"differential ids");solver_ok(IDASetConstraints(mem,bounds),"stock constraints");
    solver_ok(IDASVtolerances(mem,0,atol),"reference-independent weights");N_VConst(0,quad);
    solver_ok(IDAQuadInit(mem,quadrature_callback,quad),"passive receipts");solver_ok(IDASetQuadErrCon(mem,SUNFALSE),"passive receipt ownership");
    SUNMatrix matrix=SUNDenseMatrix(D,D,context);SUNLinearSolver linear=SUNLinSol_Dense(y,matrix,context);
    require(matrix&&linear,"Linear boundary unavailable");solver_ok(IDASetLinearSolver(mem,linear,matrix),"linear boundary");
    solver_ok(IDASetJacFn(mem,jacobian_callback),"supplied complete approximate Newton matrix");
    solver_ok(IDASetMaxNumSteps(mem,20000),"bounded solver work");solver_ok(IDASetMaxStep(mem,1),"operating stop spacing");
    auto statistics=[&]{statistic_ok(IDAGetNumSteps(mem,&result.steps),"steps");statistic_ok(IDAGetNumErrTestFails(mem,&result.errorFailures),"error failures");
        statistic_ok(IDAGetNumNonlinSolvConvFails(mem,&result.nonlinearFailures),"nonlinear failures");
        result.residuals=run.residuals;result.jacobians=run.jacobians;result.quadratures=run.quadratures;result.recoverable=run.recoverable;
        result.wall=std::chrono::duration<double>(Clock::now()-began).count();partial=result;};
    double t=0;
    for(int target=1;target<=30;++target){solver_ok(IDASetStopTime(mem,target),"stop time");
        while(t<target){const int flag=IDASolve(mem,target,&t,y,dy,IDA_ONE_STEP);result.attained=t;statistics();
            if(flag<0)throw std::runtime_error("IDAS status "+std::to_string(flag)+"; "+run.failure);
            require(flag==IDA_SUCCESS||flag==IDA_TSTOP_RETURN,"Unexpected event role");double current=0,h=0;int order=0;
            require(result.steps<=20000,"Aggregate solver step allowance exhausted");
            solver_ok(IDAGetCurrentTime(mem,&current),"current time");require(current==t,"Output is not current endpoint");
            solver_ok(IDAGetDky(mem,current,0,history),"whole history state");solver_ok(IDAGetDky(mem,current,1,historyDerivative),"history polynomial derivative");
            solver_ok(IDAGetLastStep(mem,&h),"last step");solver_ok(IDAGetLastOrder(mem,&order),"last order");
            require(h>0&&order>=1&&order<=5,"Invalid step/order");++result.orders[order];
            result.minStep=result.minStep==0?h:std::min(result.minStep,h);result.maxStep=std::max(result.maxStep,h);
            x=N_VGetArrayPointer(history);const auto*raw=N_VGetArrayPointer(y),*hd=N_VGetArrayPointer(historyDerivative);
            for(int j=0;j<D;++j)require(std::isfinite(x[j])&&std::isfinite(hd[j])&&raw[j]==x[j],"Nonfinite or unmatched complete endpoint/history");
            for(int i=0;i<N;++i){const auto native=view(x,i);
                for(int field:{M,B,Q}){if(field==Q&&!cells[i].tank)continue;
                    if(!(field==M?native[field]>0:native[field]>=0)){
                        candidate_ok(false,t,i,field,native[field],0,"Accepted stock sign failed");}}
                const auto s=water(native[TT],native[PP]);require(std::abs(native[P]/native[M])<s.w,"Accepted liquid outside subsonic scope");
            }
            const auto totals=native_totals(x);
            const double massDefect=std::abs(totals[0]-initialTotals[0]),energyDefect=std::abs(totals[1]-initialTotals[1]),tracerDefect=std::abs(totals[2]-initialTotals[2]);
            require(massDefect<=1e-6&&energyDefect<=.1&&tracerDefect<=1e-8,"Closed native conservation failed");
            // Algebraic rows do not involve dy; this recomputes the exact nonlinear chart.
            const auto chart=conservative_residual(x,N_VGetArrayPointer(dy));
            std::array<double,5> stageDefects{},historyDifferences{};
            stageDiagnostic=StageDiagnostic{};stageDiagnostic.time=t;stageDiagnostic.h=h;stageDiagnostic.order=order;
            stageDiagnostic.genuine=flag==IDA_SUCCESS;double squares=0;int differentialCount=0;
            for(int j=0;j<D;++j){const int field=coordinateOwner[j].field;if(field>=PP)continue;
                const double defect=h*std::abs(chart[j])/tol[j];
                const double historyDifference=h*std::abs(hd[j]-N_VGetArrayPointer(dy)[j])/tol[j];
                stageDefects[field]=std::max(stageDefects[field],defect);historyDifferences[field]=std::max(historyDifferences[field],historyDifference);
                require(std::isfinite(defect)&&std::isfinite(historyDifference),"Nonfinite stage/history derivative diagnostic");
                squares+=defect*defect;++differentialCount;
                if(defect>stageDiagnostic.maximum){stageDiagnostic.maximum=defect;stageDiagnostic.cell=coordinateOwner[j].cell;stageDiagnostic.field=field;
                    stageDiagnostic.derivative=N_VGetArrayPointer(dy)[j];stageDiagnostic.rate=stageDiagnostic.derivative-chart[j];
                    stageDiagnostic.residual=chart[j];stageDiagnostic.atol=tol[j];}}
            stageDiagnostic.wrms=std::sqrt(squares/differentialCount);
            // h*F is neither an LTE nor J^-1*F state correction for a stiff DAE.
            // It is descriptive, not a second invented nonlinear convergence test.
            double chartPressure=0,chartTemperature=0;
            for(int i=0;i<N;++i){const double p=std::abs(chart[ix(i,PP)]),T=std::abs(chart[ix(i,TT)]);
                chartPressure=std::max(chartPressure,p);chartTemperature=std::max(chartTemperature,T);
                candidate_ok(p<=5*factor,t,i,PP,p,5*factor,"Accepted native pressure chart failed");
                candidate_ok(T<=.001*factor,t,i,TT,T,.001*factor,"Accepted native temperature chart failed");}
            solver_ok(IDAGetQuadDky(mem,current,0,quad),"same-endpoint ring receipts");
            const auto*q=N_VGetArrayPointer(quad);for(int j=0;j<OBSERVERS;++j)require(std::isfinite(q[j]),"Nonfinite passive receipt");
            // Only this now-admitted complete state supplies report data; a later refusal cannot replace it.
            result.massDefect=std::max(result.massDefect,massDefect);result.energyDefect=std::max(result.energyDefect,energyDefect);
            result.tracerDefect=std::max(result.tracerDefect,tracerDefect);result.chartPressure=std::max(result.chartPressure,chartPressure);
            result.chartTemperature=std::max(result.chartTemperature,chartTemperature);
            for(int field=0;field<5;++field){result.stageDefectWeights[field]=std::max(result.stageDefectWeights[field],stageDefects[field]);
                result.historyDerivativeDifferenceWeights[field]=std::max(result.historyDerivativeDifferenceWeights[field],historyDifferences[field]);}
            result.admitted=t;std::copy(q,q+OBSERVERS,result.receipts.begin());
            result.grossMass=result.grossEnergy=result.maxTemperatureChange=result.totalQ=0;
            for(int ring=0;ring<3;++ring){result.grossMass+=q[ring*RM+1];result.grossEnergy+=q[ring*RM+3];}
            for(int i=0;i<N;++i)if(cells[i].tank){result.maxTemperatureChange=std::max(result.maxTemperatureChange,std::abs(x[ix(i,TT)]-initial[ix(i,TT)]));result.totalQ+=x[ix(i,Q)];}
            statistics();
        }
        require(std::abs(t-target)<=1e-10,"Common sample not accepted stop-time state");
        std::array<double,SAMPLE> row;std::copy(x,x+D,row.begin());std::copy(result.receipts.begin(),result.receipts.end(),row.begin()+D);result.common.push_back(row);
        std::cerr<<"admitted arm="<<factor<<" time="<<t<<" steps="<<result.steps<<"\n";
    }
    statistics();IDAFree(&mem);SUNLinSolFree(linear);SUNMatDestroy(matrix);
    for(auto v:{y,dy,ids,atol,bounds,history,historyDerivative,quad})N_VDestroy(v);SUNContext_Free(&context);return result;
}
void operator_json(const CoupledOperatorMetrics&m){std::cout<<"{\"snapshots\":"<<m.snapshots<<",\"colors\":"<<m.colors
    <<",\"rateEvaluations\":"<<m.rateEvaluations<<",\"structuralEntries\":"<<m.nonzeroEntries
    <<",\"maximumQEnergyConservationDefect\":"<<m.maximumQEnergyConservationDefect
    <<",\"maximumQTracerConservationDefect\":"<<m.maximumQTracerConservationDefect
    <<",\"maximumFullHalfRelativeDifference\":"<<m.maximumFullHalfRelativeDifference
    <<",\"maximumDirectionalBudgetFraction\":"<<m.maximumDirectionalBudgetFraction<<"}";}
int main(int argc,char**argv){std::cout<<std::setprecision(17);bool operatorPassed=false;CoupledOperatorMetrics operatorMetrics;
    try{require(argc==2,"Expected remaining aggregate seconds");guard_seconds=std::stod(argv[1]);
        local_gates();operatorMetrics=coupled_operator_gates();operatorPassed=true;
        const auto a=advance_arm(1);completed.push_back(a);const auto b=advance_arm(.5);completed.push_back(b);
        require(a.common.size()==30&&b.common.size()==30,"Missing useful-duration arm");
        double dt=0,dp=0,dv=0,dm=0,de=0,dq=0,signedMass=0,signedEnergy=0;
        for(size_t j=0;j<a.common.size();++j){const auto&l=a.common[j];const auto&r=b.common[j];
            double grossMError=0,grossEError=0,signedMError=0,signedEError=0,qError=0;
            for(int i=0;i<N;++i){dt=std::max(dt,std::abs(l[ix(i,TT)]-r[ix(i,TT)]));dp=std::max(dp,std::abs(l[ix(i,PP)]-r[ix(i,PP)]));
                dv=std::max(dv,std::abs(l[ix(i,P)]/l[ix(i,M)]-r[ix(i,P)]/r[ix(i,M)]));
                if(cells[i].tank)qError+=std::abs(l[ix(i,Q)]-r[ix(i,Q)]);}
            for(int ring=0;ring<3;++ring){grossMError+=std::abs(l[D+ring*RM+1]-r[D+ring*RM+1]);
                grossEError+=std::abs(l[D+ring*RM+3]-r[D+ring*RM+3]);
                signedMError+=std::abs(l[D+ring*RM]-r[D+ring*RM]);signedEError+=std::abs(l[D+ring*RM+2]-r[D+ring*RM+2]);}
            signedMass=std::max(signedMass,signedMError);signedEnergy=std::max(signedEnergy,signedEError);
            dm=std::max({dm,grossMError,signedMError});de=std::max({de,grossEError,signedEError});dq=std::max(dq,qError);}
        require(dt<=.05&&dp<=100&&dv<=.005,"Paired thermal/head/velocity comparison failed");
        require(std::min(a.grossMass,b.grossMass)>10*std::max(dm,1e-6),"Gross mass transfer unresolved");
        require(std::min(a.grossEnergy,b.grossEnergy)>10*std::max(de,.01),"Gross native energy transfer unresolved");
        require(std::min(a.maxTemperatureChange,b.maxTemperatureChange)>10*std::max(dt,1e-5)||std::min(a.totalQ,b.totalQ)>10*std::max(dq,1e-5),"Thermal/Q consequence unresolved");
        std::cout<<"{\"passed\":true,\"operatorGatesPassed\":true,\"operatorMetrics\":";operator_json(operatorMetrics);
        std::cout<<",\"coarse\":";arm_json(a);std::cout<<",\"tighter\":";arm_json(b);
        std::cout<<",\"lastStageDiagnostic\":";stage_json();
        std::cout<<",\"pairedTemperatureK\":"<<dt<<",\"pairedPressurePa\":"<<dp<<",\"pairedVelocityMS\":"<<dv
            <<",\"pairedGrossMassKg\":"<<dm<<",\"pairedGrossEnergyJ\":"<<de<<",\"pairedQJ\":"<<dq
            <<",\"pairedPerRingSignedMassKg\":"<<signedMass<<",\"pairedPerRingSignedEnergyJ\":"<<signedEnergy
            <<",\"propertyTuples\":"<<tuple_calls<<",\"checks\":"<<checks<<"}\n";return 0;
    }catch(const std::exception&e){std::cerr<<e.what()<<"\n";
        std::cout<<"{\"passed\":false,\"operatorGatesPassed\":"<<(operatorPassed?"true":"false")<<",\"operatorMetrics\":";operator_json(operatorMetrics);
        std::cout<<",\"activeWeightFactor\":"<<activeFactor
            <<",\"refusedCandidate\":";refusal_json();std::cout<<",\"lastStageDiagnostic\":";stage_json();
        std::cout<<",\"partialArm\":";arm_json(partial);std::cout<<",\"completedArms\":[";
        for(size_t i=0;i<completed.size();++i){if(i)std::cout<<",";arm_json(completed[i]);}
        std::cout<<"],\"propertyTuples\":"<<tuple_calls<<",\"checks\":"<<checks<<"}\n";return 1;}}
`

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Identity = { path: string; sha256: string }
interface SolverReceipt {
  flags: string[]
  nativeFixture: { result: { passed: boolean } }
  solver: {
    version: string; idasLibrary: string; idasLibrarySha256: string
    artifacts: Identity[]; headerInputs: Identity[]; idasInputs: Identity[]
    solverLicensePath: string; solverLicenseSha256: string
    offlineConsistencyCandidate: { patchPath: string; patchSha256: string; privateSource: string; patchedSourceSha256: string }
    loaderEnvironment: Record<string, string>
  }
}

export async function qualifyCoupledCmt(if97Directory: string, solverReceiptPath: string, ownerPath: string,
  outputPath: string, allowanceMs = 120_000) {
  if (!Number.isFinite(allowanceMs) || allowanceMs <= 0 || allowanceMs > 120_000) throw Error('Invalid remaining coupled allowance')
  const began = performance.now(), output = resolve(outputPath)
  if (await Bun.file(output).exists() || await Bun.file(output + '.artifacts/admission.cpp').exists()) throw Error('Refusing existing receipt/artifacts')
  const solverBytes = await readFile(resolve(solverReceiptPath)), previous = JSON.parse(solverBytes.toString()) as SolverReceipt
  const solver = previous.solver
  if (solver.version !== '7.5.0' || previous.nativeFixture.result.passed !== true) throw Error('Dependency consistency fixture not admitted')
  const identity: Identity[] = [
    { path: join(resolve(if97Directory), 'IF97.h'), sha256: nativeIf97HeaderSha256 },
    { path: join(resolve(if97Directory), 'LICENSE'), sha256: nativeIf97LicenseSha256 },
    { path: solver.idasLibrary, sha256: solver.idasLibrarySha256 }, ...solver.artifacts, ...solver.headerInputs, ...solver.idasInputs,
    { path: solver.solverLicensePath, sha256: solver.solverLicenseSha256 },
    { path: solver.offlineConsistencyCandidate.patchPath, sha256: solver.offlineConsistencyCandidate.patchSha256 },
    { path: solver.offlineConsistencyCandidate.privateSource, sha256: solver.offlineConsistencyCandidate.patchedSourceSha256 },
  ]
  for (const item of identity) if (sha(await readFile(item.path)) !== item.sha256) throw Error('Changed qualified native input: ' + item.path)
  const owner = resolve(ownerPath), ownerBytes = await readFile(owner), candidate = nativeAxialCandidate(ownerBytes.toString())
  const sourceFiles = [import.meta.path, resolve(import.meta.dir, 'reference-design-cmt-native-axial.ts'),
    resolve(import.meta.dir, 'reference-design-cmt-mixing-fixture.ts'), resolve(import.meta.dir, 'reference-design-if97-primitives.ts'),
    resolve(import.meta.dir, 'reference-design-cmt-geometry.ts'), resolve(import.meta.dir, 'reference-design-cmt-balance-path.ts'),
    resolve(import.meta.dir, '../native/process-plant/src/mixing.rs')]
  const sources = await Promise.all(sourceFiles.map(path => readFile(path))), scratch = await mkdtemp(join(tmpdir(), 'ld01-coupled-cmt-'))
  const artifacts = output + '.artifacts';await mkdir(artifacts)
  const cpp = join(scratch, 'admission.cpp'), library = join(scratch, 'libmixing.a'), binary = join(scratch, 'admission')
  const payload = candidate.kernelCpp + nativeCoupledDriver
  await writeFile(cpp, payload, { flag: 'wx' });await writeFile(join(artifacts, 'admission.cpp'), payload, { flag: 'wx' })
  await Promise.all(sourceFiles.map((path, i) => writeFile(join(artifacts, basename(path)), sources[i]!, { flag: 'wx' })))
  async function execute(command: string[]) {
    const remaining = allowanceMs - (performance.now() - began)
    if (remaining <= 0) return { command, exitCode: null, timedOut: true, stdout: '', stderr: 'Aggregate allowance exhausted before command' }
    const child = Bun.spawn(command, { env: { ...process.env, ...solver.loaderEnvironment }, stdout: 'pipe', stderr: 'pipe' })
    let timedOut = false;const timer = setTimeout(() => { timedOut = true;child.kill() }, remaining)
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      .finally(() => clearTimeout(timer))
    return { command, exitCode, timedOut, stdout, stderr }
  }
  const successful = (r: {exitCode: number | null;timedOut: boolean} | undefined) => r?.exitCode === 0 && !r.timedOut
  const rustVersion = await execute(['rustc', '--version']), cppVersion = await execute(['clang++', '--version'])
  const rustBuild = successful(rustVersion) && successful(cppVersion)
    ? await execute(['rustc', '--edition=2024', '--crate-type=staticlib', '-C', 'opt-level=2', '-C', 'panic=abort', sourceFiles[6]!, '-o', library]) : undefined
  // Only the exact already-qualified serial/dense boundary is linked. No new backend or fallback.
  const denseArtifacts = solver.artifacts.filter(a => /(?:core|nvecserial|sunmatrixdense|sunlinsoldense)\./.test(basename(a.path)))
  if (denseArtifacts.length !== 4) throw Error('Incomplete qualified serial/dense dependency boundary')
  const includes = previous.flags.flatMap((value, index) => value === '-I' && previous.flags[index + 1] !== resolve(if97Directory)
    ? ['-I', previous.flags[index + 1]!] : [])
  const compile = successful(rustBuild)
    ? await execute(['clang++', '-std=c++17', '-O2', '-I', resolve(if97Directory), ...includes,
      cpp, library, solver.idasLibrary, ...denseArtifacts.map(a => a.path), '-o', binary]) : undefined
  const run = successful(compile)
    // Reserve half a second INSIDE the same allowance for native refusal/receipt
    // flushing before the independent process kill. This is not extra solver work.
    ? await execute([binary, String(Math.max(0, (allowanceMs - (performance.now() - began)) / 1000 - .5))]) : undefined
  let result: unknown, parseError: string | undefined
  if (run) try { result = JSON.parse(run.stdout) } catch (error) { parseError = error instanceof Error ? error.message : String(error) }
  const nativePassed = !!result && typeof result === 'object' && 'passed' in result && result.passed === true
  const unchanged = (await Promise.all(sourceFiles.map(path => readFile(path)))).every((bytes, i) => sha(bytes) === sha(sources[i]!))
    && sha(await readFile(owner)) === sha(ownerBytes) && sha(await readFile(resolve(solverReceiptPath))) === sha(solverBytes)
    && (await Promise.all(identity.map(async item => sha(await readFile(item.path)) === item.sha256))).every(Boolean)
  const binaries: Identity[] = []
  for (const path of [...(successful(rustBuild) ? [library] : []), ...(successful(compile) ? [binary] : [])]) {
    const bytes = await readFile(path), retained = join(artifacts, basename(path));await writeFile(retained, bytes, { flag: 'wx' });binaries.push({ path: retained, sha256: sha(bytes) })
  }
  const elapsedSeconds = (performance.now() - began) / 1000
  const receipt = { schema: 'ld01-cmt-coupled-operator-and-advancement', recordedAt: new Date().toISOString(),
    passed: successful(run) && nativePassed && unchanged && elapsedSeconds <= allowanceMs / 1000,
    allowanceSeconds: allowanceMs / 1000, elapsedSeconds, result, parseError, unchanged,
    owner: { path: owner, sha256: sha(ownerBytes) }, solverReceipt: { path: resolve(solverReceiptPath), sha256: sha(solverBytes) },
    identity, sources: sourceFiles.map((path, i) => ({ path, sha256: sha(sources[i]!) })), payloadSHA256: sha(payload),
    geometry: candidate.geometry, scratch, artifacts, binaries, rustVersion, cppVersion, rustBuild, compile, run,
    scope: 'One actual 139-coordinate isolated CMT/BAL consumer; complete approximate Newton matrix, unchanged strict stock/chart/conservation and original 30-second plus tighter-arm mission. No live installation, phase/exhaustion, complete plant, production solver adoption or target-host/four-unit throughput claim.' }
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });return receipt
}
if (import.meta.main) {
  const [input, solver, owner, output, ...extra] = Bun.argv.slice(2)
  if (!input || !solver || !owner || !output || extra.length) throw Error('Expected pinned IF97 directory, qualified solver receipt, CMT owner and NEW receipt')
  const receipt = await qualifyCoupledCmt(input, solver, owner, output)
  console.log(JSON.stringify({ passed: receipt.passed, elapsedSeconds: receipt.elapsedSeconds, result: receipt.result, parseError: receipt.parseError, output }))
  if (!receipt.passed) process.exitCode = 1
}
