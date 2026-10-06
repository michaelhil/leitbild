/** Finite checks compiled with the actual axial residual. No field advancement. */
export const nativeMixingAbi = String.raw`
#include <cstdint>
#include <cstddef>
struct RustMixingInput {double rho,mu,k,c2,dp,dr,du,transverse,wallDistance,outerLength;};
struct RustMixingOutput {double rates[8],derivatives[8][10];uint32_t derivativeStatus,derivativesAvailable;};
static_assert(sizeof(RustMixingInput)==80&&sizeof(RustMixingOutput)==712,"Mixing ABI layout mismatch");
extern "C" int leitbild_mixing_batch(const RustMixingInput*,RustMixingOutput*,size_t,uint32_t,size_t*,unsigned char*,size_t);
`;

export const nativeMixingQualification = String.raw`
int mixing_qualification() {
    double entropyDefect=0,buoyancyDefect=0,workDefect=0,derivativeFraction=0;
    uint64_t localCases=0,derivativeChecks=0,refusalChecks=0;std::string context;
    auto close=[&](double a,double b,double absolute=1e-10){std::ostringstream detail;detail<<std::setprecision(17)<<context<<" actual="<<a<<" expected="<<b;
        require(std::abs(a-b)<=absolute+1e-10*std::max(std::abs(a),std::abs(b)),"Mixing independent identity failed: "+detail.str());};
    auto evaluate=[](const RustMixingInput&x,uint32_t trial=1){RustMixingOutput y{};mixing_batch(&x,&y,1,trial);return y;};
    for(double temperature:{313.15,450.}){const auto w=water(temperature,15.2e6);
        for(double gradient:{-100.,0.,100.}){const double dp=-w.rho*gravity;
            context="T="+std::to_string(temperature)+" ds/dz="+std::to_string(gradient);
            const double dr=dp/(w.w*w.w)-w.rho*w.alpha*w.T/w.cp*gradient;
            RustMixingInput x{w.rho,w.mu,1e-4,w.w*w.w,dp,dr,1.2,-.3,.5,holeD};
            const auto y=evaluate(x,0);++localCases;const double n2=gravity/w.rho*(dp/x.c2-dr);
            const double expectedG=-w.rho*y.rates[1]*n2;
            close(y.rates[3],expectedG);buoyancyDefect=std::max(buoyancyDefect,std::abs(y.rates[3]-expectedG));
            const double heat=-w.rho*y.rates[1]*w.T*gradient;
            const double dT=w.T/w.cp*(gradient+w.alpha/w.rho*dp);
            const double entropy=-y.rates[3]/w.T-heat*dT/(w.T*w.T),expectedEntropy=w.rho*y.rates[1]*gradient*gradient/w.cp;
            close(entropy,expectedEntropy);require(entropy>=-1e-10,"Turbulent paired entropy is negative");
            entropyDefect=std::max(entropyDefect,std::abs(entropy-expectedEntropy));
            const double molecularAxial=4./3*w.mu*(x.du-x.transverse),molecularTransverse=-2./3*w.mu*(x.du-x.transverse);
            const double work=(y.rates[5]-molecularAxial)*x.du+2*(y.rates[6]-molecularTransverse)*x.transverse;
            close(y.rates[4],work);workDefect=std::max(workDefect,std::abs(y.rates[4]-work));
            close(y.rates[7],y.rates[4]+y.rates[3]-w.rho*y.rates[2]);
            require(y.derivativesAvailable==1,"Selected interior snapshot lacks derivative");
            // Fixed branch-preserving full/half changes in actual independent SI inputs.
            const std::array<double,10> step{{w.rho*1e-6,w.mu*1e-6,1e-10,x.c2*1e-6,std::abs(dp)*1e-6,
                std::max(std::abs(dr),1e-3)*1e-6,1e-6,1e-6,.5e-6,holeD*1e-6}};
            for(int j=0;j<10;++j){auto plus=x,minus=x;
                // Explicit field assignment avoids pointer arithmetic across struct members.
                auto perturb=[&](RustMixingInput&v,double delta){switch(j){case 0:v.rho+=delta;break;case 1:v.mu+=delta;break;
                    case 2:v.k+=delta;break;case 3:v.c2+=delta;break;case 4:v.dp+=delta;break;case 5:v.dr+=delta;break;
                    case 6:v.du+=delta;break;case 7:v.transverse+=delta;break;case 8:v.wallDistance+=delta;break;case 9:v.outerLength+=delta;break;}};
                perturb(plus,step[j]);perturb(minus,-step[j]);
                const auto a=evaluate(plus),b=evaluate(minus);auto halfPlus=x,halfMinus=x;
                perturb(halfPlus,step[j]/2);perturb(halfMinus,-step[j]/2);
                const auto ah=evaluate(halfPlus),bh=evaluate(halfMinus);
                require(a.derivativeStatus==y.derivativeStatus&&b.derivativeStatus==y.derivativeStatus
                    &&ah.derivativeStatus==y.derivativeStatus&&bh.derivativeStatus==y.derivativeStatus,"Derivative probe changed declared branch");
                for(int i=0;i<8;++i){const double predicted=2*step[j]*y.derivatives[i][j],actual=a.rates[i]-b.rates[i],half=ah.rates[i]-bh.rates[i];
                    const double roundoff=1e-10*std::max({std::abs(a.rates[i]),std::abs(b.rates[i]),1e-12});
                    const double budget=.001*std::abs(predicted)+roundoff;
                    std::ostringstream detail;detail<<std::setprecision(17)<<context<<" input="<<j<<" output="<<i<<" full="<<actual<<" twice-half="<<2*half<<" predicted="<<predicted<<" budget="<<budget;
                    require(std::abs(actual-predicted)<=budget&&std::abs(2*half-predicted)<=budget,"Local mixing full/half derivative increment failed: "+detail.str());
                    derivativeFraction=std::max(derivativeFraction,std::max(std::abs(actual-predicted),std::abs(2*half-predicted))/budget);++derivativeChecks;}
            }
            x.k=-1e-4;const auto negative=evaluate(x,1);++localCases;
            close(negative.rates[4],-2./3*w.rho*x.k*(x.du+2*x.transverse));
            close(negative.rates[7],negative.rates[4]);require(negative.derivativeStatus==4,"Signed numerical branch not identified");
            close(negative.derivatives[4][2],-2./3*w.rho*(x.du+2*x.transverse));
            x.k=0;const auto zero=evaluate(x,0);++localCases;
            for(int i=0;i<5;++i)require(zero.rates[i]==0,"Zero modeled turbulent rate was manufactured");
            require(zero.rates[7]==0,"Zero local Q rate was manufactured");
            if(n2>0){require(zero.derivativeStatus==1&&zero.derivativesAvailable==1,"Stable right zero limit missing");
                auto tiny=x;tiny.k=1e-14;const auto right=evaluate(tiny,0);tiny.k/=2;const auto halfRight=evaluate(tiny,0);
                for(int i:{0,1,2,3,4,7}){const double predicted=zero.derivatives[i][2]*1e-14;
                    const double budget=.001*std::abs(predicted)+1e-18;
                    require(std::abs(right.rates[i]-predicted)<=budget&&std::abs(2*halfRight.rates[i]-predicted)<=budget,"Stable zero right-limit increment failed: "+context);++derivativeChecks;}}
            else require(zero.derivativesAvailable==0,"Finite singular zero derivative was invented");
        }
    }
    const auto w=water(313.15,15.2e6);RustMixingInput boundary{w.rho,w.mu,1e-4,w.w*w.w,-w.rho*gravity,-w.rho*gravity/(w.w*w.w),1.2,-.3,.1,.7*.1};
    const auto tie=evaluate(boundary,0);++localCases;require(tie.derivativeStatus==3&&tie.derivativesAvailable==0,"Length tie invented a unique derivative");
    boundary.wallDistance=0;boundary.k=0;const auto solid=evaluate(boundary,0);++localCases;
    require(solid.derivativeStatus==5&&solid.derivativesAvailable==0,"Solid zero was given a positive-k continuation");
    auto refusal=[&](RustMixingInput x,uint32_t role){RustMixingOutput y{};size_t failed=99;unsigned char message[256]{};
        require(leitbild_mixing_batch(&x,&y,1,role,&failed,message,sizeof(message))!=0&&failed==0&&message[0]!=0,"Invalid mixing input/role was accepted");++refusalChecks;};
    boundary.k=1e-4;refusal(boundary,0);boundary.wallDistance=.5;boundary.k=-1e-4;refusal(boundary,0);
    boundary.k=0;refusal(boundary,2);boundary.rho=std::numeric_limits<double>::quiet_NaN();refusal(boundary,0);
    boundary={w.rho,w.mu,1e-240,w.w*w.w,-w.rho*gravity,-w.rho*gravity/(w.w*w.w)-.2*w.rho/gravity,1.2,-.3,.5,holeD};
    const auto tinyStable=evaluate(boundary,0);++localCases;
    const double tinyN2=gravity/w.rho*(boundary.dp/boundary.c2-boundary.dr);
    require(tinyStable.rates[0]>0&&tinyStable.rates[2]>0&&tinyStable.derivativesAvailable==1,"Stable tiny positive rate underflowed");
    close(tinyStable.rates[0]/((.76*.10)*boundary.k/std::sqrt(tinyN2)),1);
    close(tinyStable.rates[2]/((.19/.76)*std::sqrt(tinyN2)*boundary.k),1);
    // Pointwise f(0)=0 does not select the local stage root; demonstration only.
    const double l=holeD,a=.30*l,c=(.19+.51*l/holeD)/l,h=.01;
    const double root=2*h*a/(1+std::sqrt(1+4*h*h*a*c)),k=root*root;
    RustMixingInput orbit{w.rho,w.mu,k,w.w*w.w,-w.rho*gravity,-w.rho*gravity/(w.w*w.w),1,-.5,.5,holeD};
    const auto positiveOrbit=evaluate(orbit,0);
    close(k-h*positiveOrbit.rates[7]/w.rho,0,1e-16);
    require(k>0,"Unforced positive implicit root counterexample missing");
    orbit.k=0;require(evaluate(orbit,0).rates[7]==0,"Unforced zero orbit missing");
    const auto originalState=original();const auto before=mixing_batches;const auto actual=rates(originalState.data());
    require(mixing_batches>before&&mixing_points>=MIXING_NODES,"Actual axial residual did not consume Rust law");
    for(double value:actual)require(std::isfinite(value),"Nonfinite actual residual snapshot");
    double receivingQRate=0;for(int i=0;i<13;++i)receivingQRate+=actual[ix(i,Q)];
    require(receivingQRate>0,"Actual zero-origin radial receipts were suppressed");
    const auto fullResidual=conservative_residual(originalState.data(),actual.data());
    for(int i=0;i<N;++i){for(int field=0;field<5;++field)if(field!=Q||cells[i].tank)
        require(fullResidual[ix(i,field)]==0,"Actual differential snapshot residual failed");
        require(std::abs(fullResidual[ix(i,PP)])<=5&&std::abs(fullResidual[ix(i,TT)])<=.001,"Original native storage chart failed");}
    std::array<State,N> currentWater;std::array<double,N> velocities{};
    for(int i=0;i<N;++i)currentWater[i]=water(originalState[ix(i,TT)],originalState[ix(i,PP)]);
    const int center=4;const auto sampled=smooth_gradients(originalState.data(),currentWater,velocities,center);
    require(!sampled.localReconstruction&&sampled.left!=sampled.right,"Declared actual neighbor test lacks smooth neighbors");
    auto changed=originalState;changed[ix(sampled.right,PP)]+=500;
    const auto changedGradient=smooth_gradients(changed.data(),currentWater,velocities,center);
    close(changedGradient.pressure-sampled.pressure,500/(cells[sampled.right].z-cells[sampled.left].z));
    const auto local=local_reconstructed_gradients(originalState.data(),currentWater[12],12);
    close(local.pressure,-originalState[ix(12,M)]/cells[12].V*gravity);
    close(local.density,currentWater[12].rho*currentWater[12].kappa*local.pressure);
    require(local.localReconstruction&&local.velocity==0,"Local reconstruction masqueraded as sampled gradient");
    std::cout<<"{\"passed\":true,\"scope\":\"finite local law and actual residual snapshots, not advancement or coupled birth admission\",\"localCases\":"<<localCases
        <<",\"derivativeChecks\":"<<derivativeChecks<<",\"refusalChecks\":"<<refusalChecks<<",\"maximumEntropyIdentityDefect\":"<<entropyDefect<<",\"maximumBuoyancyIdentityDefect\":"<<buoyancyDefect
        <<",\"maximumMeanStressQWorkDefect\":"<<workDefect<<",\"maximumDerivativeIncrementBudgetFraction\":"<<derivativeFraction
        <<",\"unforcedPositiveImplicitRootK\":"<<k<<",\"actualOriginalReceivingQRateW\":"<<receivingQRate
        <<",\"actualNonhydroPressureGradientResponsePaM\":"<<(changedGradient.pressure-sampled.pressure)
        <<",\"localIsothermalPressureGradientPaM\":"<<local.pressure<<",\"localIsothermalDensityGradientKgM4\":"<<local.density
        <<",\"actualMixingBatchCalls\":"<<mixing_batches<<",\"actualMixingPointCalls\":"<<mixing_points<<"}\n";return 0;
}
`;
