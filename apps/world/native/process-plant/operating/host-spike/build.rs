use std::{env, path::PathBuf};

/// water-ffi's build script links stock SUNDIALS/KLU dynamically, but its
/// rpath link argument applies to water-ffi's own targets only. This spike's
/// binary and cdylib state the runtime search path themselves: the verified
/// prefix by default, or an explicit `LD01_HOST_SPIKE_RPATH` such as
/// `$ORIGIN/../lib` for a relocatable Linux artifact.
fn main() {
    println!("cargo:rerun-if-env-changed=LD01_OPERATING_SUNDIALS_PREFIX");
    println!("cargo:rerun-if-env-changed=LD01_HOST_SPIKE_RPATH");
    println!("cargo:rerun-if-env-changed=LD01_OPERATING_WATER_LIB_DIR");
    let rpath = match env::var("LD01_HOST_SPIKE_RPATH") {
        Ok(explicit) => explicit,
        Err(_) => {
            let prefix = PathBuf::from(
                env::var_os("LD01_OPERATING_SUNDIALS_PREFIX")
                    .expect("the host spike links the verified stock SUNDIALS prefix"),
            );
            assert!(prefix.is_absolute(), "SUNDIALS prefix must be absolute");
            prefix.join("lib").display().to_string()
        }
    };
    println!("cargo:rustc-link-arg=-Wl,-rpath,{rpath}");
}
