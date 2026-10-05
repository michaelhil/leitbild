/** One test-only native dependency fixture. No plant equations or runtime backend. */
export const nativeIdasConsistencyFixture = String.raw`
#include <idas/idas.h>
#include <nvector/nvector_serial.h>
#include <sunmatrix/sunmatrix_dense.h>
#include <sunlinsol/sunlinsol_dense.h>
#include <chrono>
#include <algorithm>
#include <cmath>
#include <array>
#include <iostream>
#include <iomanip>
#include <stdexcept>

using Clock=std::chrono::steady_clock;
const auto started=Clock::now();double allowance=100;
void check(bool valid,const char* message){if(std::chrono::duration<double>(Clock::now()-started).count()>allowance)
    throw std::runtime_error("Native dependency fixture allowance exhausted");
    if(!valid)throw std::runtime_error(message);}
void ok(int flag){check(flag>=0,"Native dependency API failure");}
constexpr int count=8;constexpr double fixtureAtol=1e-7;
std::array<double,count> exact(double t){const double p=1+t+.25*t*t+.05*t*t*t+.001*std::pow(t,5);
    return {0,0,t*t,-t*t,p,-p,.5+t-t*t+.25*t*t*t+.001*std::pow(t,5),-t*t};}
std::array<double,count> rate(double t){const double d=1+.5*t+.15*t*t+.005*std::pow(t,4);
    return {0,0,2*t,-2*t,d,-d,1-2*t+.75*t*t+.005*std::pow(t,4),-2*t};}
int residual(double t,N_Vector,N_Vector yp,N_Vector rr,void*){const auto f=rate(t);
    const auto*d=N_VGetArrayPointer(yp);auto*r=N_VGetArrayPointer(rr);
    for(int i=0;i<count;++i)r[i]=d[i]-f[i];return 0;}
int jacobian(double,double cj,N_Vector,N_Vector,N_Vector,SUNMatrix J,void*,N_Vector,N_Vector,N_Vector){
    SUNMatZero(J);for(int i=0;i<count;++i)SM_ELEMENT_D(J,i,i)=cj;return 0;}
int main(int argc,char**argv){std::cout<<std::setprecision(17);
    std::array<long,6> orders{};long steps=0;double t=0,minH=1e100,maxH=0,stateError=0,derivativeError=0,pairError=0;
    try{if(argc==2)allowance=std::stod(argv[1]);SUNContext context=nullptr;ok(SUNContext_Create(SUN_COMM_NULL,&context));
        N_Vector y=N_VNew_Serial(count,context),yp=N_VClone(y),co=N_VClone(y),mask=N_VClone(y),cy=N_VClone(y),cd=N_VClone(y);
        check(y&&yp&&co&&mask&&cy&&cd,"Native dependency vector allocation failed");
        const auto initial=exact(0),initialRate=rate(0);auto*x=N_VGetArrayPointer(y);auto*dx=N_VGetArrayPointer(yp);
        for(int i=0;i<count;++i){x[i]=initial[i];dx[i]=initialRate[i];}
        const std::array<double,count> constraints{{1,-1,1,-1,2,-2,0,0}};
        for(int i=0;i<count;++i)N_VGetArrayPointer(co)[i]=constraints[i];
        void*mem=IDACreate(context);check(mem,"Native dependency solver allocation failed");
        ok(IDAInit(mem,residual,0,y,yp));ok(IDASStolerances(mem,0,fixtureAtol));ok(IDASetConstraints(mem,co));
        SUNMatrix J=SUNDenseMatrix(count,count,context);SUNLinearSolver linear=SUNLinSol_Dense(y,J,context);
        check(J&&linear,"Native dependency linear allocation failed");ok(IDASetLinearSolver(mem,linear,J));ok(IDASetJacFn(mem,jacobian));
        ok(IDASetMaxStep(mem,.01));
        for(double stop:{.013,.071,.2,.43,.79,1.}){ok(IDASetStopTime(mem,stop));
            while(t<stop){const int flag=IDASolve(mem,stop,&t,y,yp,IDA_ONE_STEP);
                check(flag==IDA_SUCCESS||flag==IDA_TSTOP_RETURN,"Native dependency advancement failed");
                double current=0,h=0;int order=0;ok(IDAGetCurrentTime(mem,&current));check(current==t,"Native dependency output is not endpoint");
                ok(IDAGetLastStep(mem,&h));ok(IDAGetLastOrder(mem,&order));check(h>0&&order>=1&&order<=5,"Invalid native dependency step/order");
                ++steps;++orders[order];check(steps<=20000,"Native dependency fixed work guard exceeded");
                minH=std::min(minH,h);maxH=std::max(maxH,h);ok(IDAGetDky(mem,current,0,cy));ok(IDAGetDky(mem,current,1,cd));
                check(N_VConstrMask(co,cy,mask),"Native dependency canonical bound failed");
                const auto truth=exact(t),truthRate=rate(t);const auto*a=N_VGetArrayPointer(cy);const auto*b=N_VGetArrayPointer(cd);
                for(int i=0;i<count;++i){check(std::isfinite(a[i])&&std::isfinite(b[i]),"Nonfinite native dependency pair");
                    check(x[i]==a[i],"Native dependency full endpoint differs from history");
                    stateError=std::max(stateError,std::abs(a[i]-truth[i]));derivativeError=std::max(derivativeError,std::abs(b[i]-truthRate[i]));
                    pairError=std::max(pairError,std::abs(dx[i]-b[i])*h/fixtureAtol);}
                check(a[0]==0&&a[1]==0,"Exact zero field was spuriously born");
                check(a[2]>=0&&a[3]<=0&&std::abs(a[2]+a[7])<=1e-12,"Positive/mirrored birth or reciprocal balance failed");
                check(stateError<=1e-5&&derivativeError<=1e-5&&pairError<=1e-6,"Native dependency analytic/full-pair gate failed");
            }
        }
        int observed=0;for(int k=1;k<=5;++k)observed+=orders[k]>0;
        check(observed>=2&&maxH>2*minH,"Native dependency fixture did not exercise variable step/order");
        std::cout<<"{\"passed\":true,\"scope\":\"one analytic eight-coordinate native dependency fixture, not a plant\",\"steps\":"<<steps
            <<",\"minimumStepSeconds\":"<<minH<<",\"maximumStepSeconds\":"<<maxH<<",\"maximumAnalyticStateError\":"<<stateError
            <<",\"maximumAnalyticDerivativeError\":"<<derivativeError<<",\"maximumFullPairDifferenceInStepAtolUnits\":"<<pairError
            <<",\"observedOrderStepCounts\":[";for(int k=1;k<=5;++k){if(k>1)std::cout<<",";std::cout<<orders[k];}
        std::cout<<"],\"wallSeconds\":"<<std::chrono::duration<double>(Clock::now()-started).count()<<"}\n";
        IDAFree(&mem);SUNLinSolFree(linear);SUNMatDestroy(J);for(N_Vector v:{y,yp,co,mask,cy,cd})N_VDestroy(v);SUNContext_Free(&context);return 0;
    }catch(const std::exception&e){std::cerr<<e.what()<<"\n";
        std::cout<<"{\"passed\":false,\"lastReturnedSeconds\":"<<t<<",\"steps\":"<<steps
            <<",\"minimumStepSeconds\":"<<(steps?minH:0)<<",\"maximumStepSeconds\":"<<maxH
            <<",\"maximumAnalyticStateError\":"<<stateError<<",\"maximumAnalyticDerivativeError\":"<<derivativeError
            <<",\"maximumFullPairDifferenceInStepAtolUnits\":"<<pairError<<",\"observedOrderStepCounts\":[";
        for(int k=1;k<=5;++k){if(k>1)std::cout<<",";std::cout<<orders[k];}
        std::cout<<"],\"wallSeconds\":"<<std::chrono::duration<double>(Clock::now()-started).count()<<"}\n";return 1;}}
`;
