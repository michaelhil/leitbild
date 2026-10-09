use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=LD01_OPERATING_WATER_LIB_DIR");
    let directory =
        PathBuf::from(env::var_os("LD01_OPERATING_WATER_LIB_DIR").expect(
            "Build the pinned IF97 boundary with reference-design-operating-water.ts first",
        ));
    assert!(
        directory.is_absolute(),
        "Water artifact directory must be absolute"
    );
    let library = directory.join("libld01_operating_water.a");
    let receipt = directory.join("water-build.json");
    assert!(
        library.is_file() && receipt.is_file(),
        "Missing water archive/build receipt"
    );
    println!("cargo:rerun-if-changed={}", library.display());
    println!("cargo:rerun-if-changed={}", receipt.display());
    println!("cargo:rustc-link-search=native={}", directory.display());
    println!("cargo:rustc-link-lib=static=ld01_operating_water");
    let target = env::var("CARGO_CFG_TARGET_OS").expect("target OS");
    println!(
        "cargo:rustc-link-lib={}",
        if target == "macos" { "c++" } else { "stdc++" }
    );
}
