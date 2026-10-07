use std::{env, path::PathBuf, process::Command};

fn run(command: &mut Command) {
    let status = command
        .status()
        .expect("Cannot start native compiler/archive tool");
    assert!(status.success(), "Native tool failed: {command:?}");
}

fn main() {
    // The Bun admission command validates upstream hashes and generates this bridge
    // from the same inspected adapter used by the earlier native checks.
    println!("cargo:rerun-if-env-changed=LEITBILD_IF97_BRIDGE_DIR");
    println!("cargo:rerun-if-env-changed=LEITBILD_IF97_DIR");
    let input = PathBuf::from(
        env::var_os("LEITBILD_IF97_DIR")
            .expect("Run the Bun native admission command; pinned IF97 input is required"),
    );
    let bridge = PathBuf::from(
        env::var_os("LEITBILD_IF97_BRIDGE_DIR").expect("Generated shared IF97 adapter is required"),
    );
    let source = bridge.join("if97-bridge.cpp");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let target = env::var("TARGET").unwrap();
    assert_eq!(
        target,
        env::var("HOST").unwrap(),
        "Cross-compilation needs an explicitly selected native toolchain"
    );
    let runtime = if target.contains("apple-darwin") {
        "c++"
    } else if target.contains("linux") {
        "stdc++"
    } else {
        panic!("Unqualified native target: {target}")
    };
    for path in [
        &source,
        &input.join("IF97.h"),
        &PathBuf::from("src/if97-bridge.cpp"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let object = out.join("if97-bridge.o");
    run(Command::new("c++")
        .args(["-std=c++17", "-O2", "-fPIC", "-c"])
        .arg(&source)
        .arg("-I")
        .arg(&input)
        .arg("-o")
        .arg(&object));
    run(Command::new("ar")
        .arg("crs")
        .arg(out.join("libleitbild_if97.a"))
        .arg(object));
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=leitbild_if97");
    println!("cargo:rustc-link-lib={runtime}");

    // This checks the selected headers, not library provenance. Bun separately
    // verifies the actually linked closure (including the private IDA patch).
    println!("cargo:rerun-if-env-changed=LEITBILD_SUNDIALS_PREFIX");
    if env::var_os("CARGO_FEATURE_OFFLINE_IDA").is_some() {
        let prefix = PathBuf::from(
            env::var_os("LEITBILD_SUNDIALS_PREFIX")
                .expect("offline-ida requires the explicit inspected LEITBILD_SUNDIALS_PREFIX"),
        );
        let include = prefix.join("include");
        assert!(
            include.is_dir(),
            "Missing selected SUNDIALS include directory"
        );
        println!("cargo:rerun-if-changed=src/sundials-abi.c");
        println!("cargo:rerun-if-changed={}", include.display());
        let object = out.join("sundials-abi.o");
        run(Command::new("cc")
            .args(["-std=c11", "-Werror", "-O2", "-fPIC", "-c"])
            .arg("src/sundials-abi.c")
            .arg("-I")
            .arg(include)
            .arg("-o")
            .arg(&object));
        run(Command::new("ar")
            .arg("crs")
            .arg(out.join("libleitbild_sundials_abi.a"))
            .arg(object));
        println!("cargo:rustc-link-lib=static=leitbild_sundials_abi");
        // Deliberately no prefix/lib search: that could shadow patched IDA.
    }
}
