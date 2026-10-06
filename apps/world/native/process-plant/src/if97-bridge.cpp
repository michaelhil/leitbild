// Included after the shared, inspected nativeIf97Primitives by the Bun admission.
// No copied IF97 coefficients, native exception across FFI, implicit phase choice,
// or mutable global evaluation diagnostics. This boundary only admits stable liquid.
#include <cstring>
#include <stdexcept>

thread_local double max_forward_p = 0, max_dense_endpoint_p_error = 0;
void require(bool ok, const std::string& message) {
    if (!ok) throw std::domain_error(message);
}

extern "C" {
struct LiquidQuery { double temperature, pressure; };
struct LiquidTuple { double pressure, temperature, density, internalEnergy, enthalpy,
    entropy, cp, cv, soundSpeed, expansion, compressibility, viscosity, conductivity; };
int leitbild_liquid_batch(const LiquidQuery* queries, LiquidTuple* output, size_t count,
    size_t* failed, char* error, size_t error_capacity) noexcept {
    for (size_t i = 0; i < count; ++i) {
        try {
            const auto q = liquid(queries[i].temperature, queries[i].pressure);
            require(q.rho>0&&q.cp>0&&q.cv>0&&q.w>0&&q.kappa>0&&q.mu>0&&q.conductivity>0,
                "Unstable single-liquid property tuple");
            require(q.kappa-q.T*q.alpha*q.alpha/(q.rho*q.cp)>0,
                "Nonpositive isentropic storage");
            output[i] = {q.p,q.T,q.rho,q.u,q.h,q.s,q.cp,q.cv,q.w,q.alpha,q.kappa,q.mu,q.conductivity};
        } catch (const std::exception& exception) {
            *failed = i;
            if (error_capacity) {
                std::strncpy(error, exception.what(), error_capacity - 1);
                error[error_capacity - 1] = '\0';
            }
            return 1;
        } catch (...) {
            *failed = i;
            if (error_capacity) {
                std::strncpy(error, "Unknown IF97 native exception", error_capacity - 1);
                error[error_capacity - 1] = '\0';
            }
            return 2;
        }
    }
    return 0;
}
// Explicit cold wet endpoint: steam is at its OWN partial saturation pressure;
// liquid uses total gas pressure. No flash, phase guess or inverse chart.
int leitbild_cold_wet(double T, double p, LiquidTuple* liquid_out,
    LiquidTuple* vapor_out, double* saturation, char* error, size_t capacity) noexcept {
    try {
        require(std::isfinite(T)&&std::isfinite(p)&&T>=IF97::Tmin&&T<=IF97::T23min
            &&p>=IF97::Pmin&&p<=20e6, "Unsupported cold wet endpoint domain");
        const double pv=r4.p_T(T), ts=r4.T_p(p);
        require(T<=ts, "Cold wet liquid above total-pressure saturation");
        const auto l=gibbs(r1,1,T,p), v=gibbs(r2,2,T,pv);
        *liquid_out={l.p,l.T,l.rho,l.u,l.h,l.s,l.cp,l.cv,l.w,l.alpha,l.kappa,l.mu,l.conductivity};
        *vapor_out={v.p,v.T,v.rho,v.u,v.h,v.s,v.cp,v.cv,v.w,v.alpha,v.kappa,v.mu,v.conductivity};
        saturation[0]=pv; saturation[1]=ts;
        return 0;
    } catch (const std::exception& e) {
        if(capacity){std::strncpy(error,e.what(),capacity-1);error[capacity-1]='\0';}
        return 1;
    } catch (...) {
        if(capacity){std::strncpy(error,"Unknown cold wet endpoint exception",capacity-1);error[capacity-1]='\0';}
        return 2;
    }
}
}
