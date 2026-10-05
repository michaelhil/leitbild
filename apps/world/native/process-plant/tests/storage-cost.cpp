// Test-only independent calculation for a matched language-boundary cost probe.
// Same compiled IF97 bridge and states; not a second production kernel.
#include <array>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
extern "C" {
struct LiquidQuery {double temperature,pressure;};
struct LiquidTuple {double pressure,temperature,density,internalEnergy,enthalpy,
    entropy,cp,cv,soundSpeed,expansion,compressibility,viscosity,conductivity;};
int leitbild_liquid_batch(const LiquidQuery*,LiquidTuple*,size_t,size_t*,char*,size_t) noexcept;
}
int main() {
    std::array<LiquidQuery,128> query{};std::array<LiquidTuple,128> water{};
    std::cout<<std::setprecision(17);
    for(size_t width:{1,128})for(int repetition=0;repetition<3;++repetition){
        const auto began=std::chrono::steady_clock::now();double checksum=0;
        for(size_t batch=0;batch<128;++batch){
            for(size_t j=0;j<width;++j){const auto i=batch*width+j;
                query[j]={313.15+(i%200)*.1,15.2e6+(i%100)*100.};}
            size_t failed=0;char error[256]{};
            if(leitbild_liquid_batch(query.data(),water.data(),width,&failed,error,sizeof(error)))
                throw std::runtime_error(error);
            for(size_t i=0;i<width;++i){const auto&w=water[i];const double m=.03*w.density,p=1.2*m;
                for(double v:{w.pressure,w.temperature,w.density,w.internalEnergy,w.enthalpy,
                    w.entropy,w.cp,w.cv,w.soundSpeed,w.expansion,w.compressibility,w.viscosity,w.conductivity,p})
                    if(!std::isfinite(v))return 1;
                if(w.pressure<=0||w.temperature<=0||w.density<=0||w.cp<=0||w.cv<=0||w.soundSpeed<=0
                    ||w.compressibility<=0||w.viscosity<=0||w.conductivity<=0
                    ||w.compressibility-w.temperature*w.expansion*w.expansion/(w.density*w.cp)<=0)return 1;
                const double e=m*(w.internalEnergy+9.80665*5)+p*p/(2*m)+2;
                const double mp=m*w.compressibility,mt=-m*w.expansion;
                const double up=(w.pressure*w.compressibility-w.temperature*w.expansion)/w.density;
                const double ut=w.cp-w.pressure*w.expansion/w.density;
                const double ep=(w.internalEnergy+9.80665*5-(p/m)*(p/m)/2)*mp+m*up;
                const double et=(w.internalEnergy+9.80665*5-(p/m)*(p/m)/2)*mt+m*ut;
                for(double v:{m,e,ep,et,mp,mt,p/m})if(!std::isfinite(v))return 1;
                checksum+=e+et+mp+ep+mt+p/m;
            }
        }
        std::cout<<"{\"language\":\"cpp\",\"width\":"<<width<<",\"repetition\":"<<repetition
            <<",\"tuples\":"<<width*128<<",\"seconds\":"
            <<std::chrono::duration<double>(std::chrono::steady_clock::now()-began).count()
            <<",\"checksum\":"<<checksum<<"}\n";
    }
}
