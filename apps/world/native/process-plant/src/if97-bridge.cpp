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
}
