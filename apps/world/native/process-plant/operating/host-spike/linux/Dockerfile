# LD-01 native stack on Linux (PLATFORM lane spike, TEST-ONLY). Reproduces
# the macOS operating prefix (ida-klu.0A9pxf): SuiteSparse 7.12.3 (config,
# AMD, COLAMD, BTF, KLU 2.3.6; no BLAS/OpenMP/Fortran), stock SUNDIALS 7.5.0
# (IDA + KLU, double, int64, shared), the IF97 bridge (adapter f59a5dbb from
# the pinned header 0be7b51f), then the Rust host spike with $ORIGIN rpaths.
# Stages are cached; INFRA may reuse `ld01-native-build:bookworm-native`.
FROM rust:1.97.1-slim-bookworm AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends g++ make cmake \
 && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_TOOLCHAIN=1.97.1
WORKDIR /build

FROM toolchain AS native
COPY sources/SuiteSparse-7.12.3.tar.gz /build/
RUN echo "158ee4ed2ce3fdcbf52c4e47e94b0d1a8ae13344b4a835991d78a3ad20f08086  SuiteSparse-7.12.3.tar.gz" | sha256sum -c \
 && tar xzf SuiteSparse-7.12.3.tar.gz \
 && cmake -S SuiteSparse-7.12.3 -B suite-build -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/opt/ld01/prefix -DCMAKE_INSTALL_LIBDIR=lib \
    -DSUITESPARSE_ENABLE_PROJECTS="suitesparse_config;amd;colamd;btf;klu" \
    -DSUITESPARSE_USE_FORTRAN=OFF -DSUITESPARSE_USE_OPENMP=OFF -DSUITESPARSE_USE_CUDA=OFF \
    -DSUITESPARSE_REQUIRE_BLAS=OFF -DBLA_VENDOR=Generic -DSUITESPARSE_USE_PYTHON=OFF -DSUITESPARSE_DEMOS=OFF \
    -DKLU_USE_CHOLMOD=OFF -DBUILD_TESTING=OFF -DBUILD_STATIC_LIBS=OFF -DBUILD_SHARED_LIBS=ON \
    -DCMAKE_INSTALL_RPATH='$ORIGIN' \
 && cmake --build suite-build -j4 && cmake --install suite-build
COPY sources/sundials-7.5.0 /build/sundials-7.5.0
RUN cmake -S sundials-7.5.0 -B sundials-build -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/opt/ld01/prefix -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_ARKODE=OFF -DBUILD_CVODE=OFF -DBUILD_CVODES=OFF -DBUILD_IDA=ON -DBUILD_IDAS=OFF \
    -DBUILD_KINSOL=OFF -DBUILD_SHARED_LIBS=ON -DBUILD_STATIC_LIBS=OFF \
    -DENABLE_KLU=ON -DKLU_INCLUDE_DIR=/opt/ld01/prefix/include/suitesparse \
    -DKLU_LIBRARY_DIR=/opt/ld01/prefix/lib -DSUNDIALS_INDEX_SIZE=64 -DSUNDIALS_PRECISION=DOUBLE \
    -DSUNDIALS_LOGGING_LEVEL=2 -DEXAMPLES_ENABLE_C=OFF -DEXAMPLES_ENABLE_CXX=OFF -DEXAMPLES_INSTALL=OFF \
    -DCMAKE_INSTALL_RPATH='$ORIGIN' \
 && cmake --build sundials-build -j4 && cmake --install sundials-build \
 && grep -E 'SUNDIALS_VERSION "7.5.0"|SUNDIALS_INT64_T 1|SUNDIALS_DOUBLE_PRECISION 1' /opt/ld01/prefix/include/sundials/sundials_config.h

FROM native AS water
COPY if97 /build/if97
COPY water /build/water
RUN echo "83693f044b271a6a28b97c06601287d023f94a75fac9723412661ebf3d3791a6  /build/if97/IF97.h" | sha256sum -c \
 && echo "f59a5dbb4c97c9687c187d786244e580dd88a97637347d6f8f77b0b2da43b9f1  /build/water/water.cpp" | sha256sum -c \
 && mkdir -p /opt/ld01/water \
 && c++ -std=c++17 -O2 -fPIC -I /build/if97 -x c++ -c -o /build/water.o /build/water/water.cpp \
 && ar rcs /opt/ld01/water/libld01_operating_water.a /build/water.o \
 && sha=$(sha256sum /opt/ld01/water/libld01_operating_water.a | cut -d' ' -f1) \
 && sed "1s/{/{\"librarySha256\": \"$sha\", \"platform\": \"linux\", \"architecture\": \"$(uname -m)\",/" \
    /build/water/water-receipt-partial.json > /opt/ld01/water/water-build.json

FROM water AS host
# Stock SUNDIALS's CMake hard-sets an absolute install RUNPATH
# (cmake/SundialsSetupCompilers.cmake); a relocatable artifact rewrites it to
# $ORIGIN at packaging (patchelf), leaving the stock source untouched.
RUN apt-get update && apt-get install -y --no-install-recommends patchelf && rm -rf /var/lib/apt/lists/*
COPY vendor /build/vendor
COPY repo /build/repo
RUN mkdir -p /build/repo/operating/host-spike/.cargo \
 && printf '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "/build/vendor"\n' \
    > /build/repo/operating/host-spike/.cargo/config.toml
ENV LD01_OPERATING_SUNDIALS_PREFIX=/opt/ld01/prefix LD01_OPERATING_WATER_LIB_DIR=/opt/ld01/water \
    LD01_HOST_SPIKE_RPATH=\$ORIGIN/../lib CARGO_TARGET_DIR=/build/target CARGO_BUILD_JOBS=4
WORKDIR /build/repo/operating/host-spike
RUN cargo build --release --offline --locked \
 && mkdir -p /opt/ld01/dist/bin /opt/ld01/dist/lib \
 && cp /build/target/release/ld01-host-spike /build/target/release/ld01-spike-measure \
       /build/target/release/ld01-spike-joined /opt/ld01/dist/bin/ \
 && cp /build/target/release/libleitbild_ld01_host_spike.so /opt/ld01/dist/lib/ \
 && cp -P /opt/ld01/prefix/lib/lib*.so* /opt/ld01/dist/lib/ \
 && for f in /opt/ld01/dist/lib/libsundials_*.so.*.*.*; do patchelf --set-rpath '$ORIGIN' "$f"; done \
 && for f in /opt/ld01/dist/lib/*.so*; do [ -L "$f" ] || readelf -d "$f" | grep -q 'RUNPATH.*\$ORIGIN' || { echo "non-relocatable $f"; exit 1; }; done \
 && cp /opt/ld01/water/water-build.json /opt/ld01/dist/ \
 && (cd /opt/ld01/dist && find . -type f | sort | xargs sha256sum > MANIFEST.sha256)

# Runtime only: no compiler, no Rust, no prefix; just glibc/libstdc++ and
# the relocatable artifact. This is the closure a server would receive.
FROM debian:bookworm-slim AS dist
COPY --from=host /opt/ld01/dist /opt/ld01
COPY data /data
RUN ldd /opt/ld01/bin/ld01-host-spike && ldd /opt/ld01/bin/ld01-host-spike | grep -q 'not found' && exit 1 || true
ENV PATH=/opt/ld01/bin:$PATH
