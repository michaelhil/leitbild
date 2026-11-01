use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

// The operating crate's one SHA-256 (dependency-free), for the identities
// below; the build script cannot depend on the crate it links.
#[path = "../src/digest.rs"]
mod digest;

fn sources(directory: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(directory)
        .unwrap_or_else(|e| panic!("{}: {e}", directory.display()))
        .map(|e| e.expect("directory entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            sources(&path, out);
        } else if matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("rs" | "c" | "toml" | "lock")
        ) {
            out.push(path);
        }
    }
}

/// The identities the unit host (`ld01-unit`) binds a snapshot to:
/// `LD01_KERNEL_SOURCE_SHA256`, the SHA-256 over the kernel's own sources
/// (the operating crate and this crate's library and binaries, with their
/// manifests and lock files; not the tests), since native builds are not
/// byte-reproducible; and `LD01_WATER_LIBRARY_SHA256`, the linked IF97
/// archive's.
fn identities(library: &Path) {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let mut files = Vec::new();
    for entry in [
        "../src",
        "../Cargo.toml",
        "../Cargo.lock",
        "src",
        "build.rs",
        "Cargo.toml",
        "Cargo.lock",
    ] {
        let path = root.join(entry);
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            sources(&path, &mut files);
        } else {
            files.push(path);
        }
    }
    let mut input = Vec::new();
    for file in files {
        let relative = file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .display()
            .to_string();
        input.extend_from_slice(relative.as_bytes());
        input.push(0);
        input.extend_from_slice(digest::sha256(&std::fs::read(&file).expect("source")).as_bytes());
        input.push(b'\n');
    }
    println!(
        "cargo:rustc-env=LD01_KERNEL_SOURCE_SHA256={}",
        digest::sha256(&input)
    );
    println!(
        "cargo:rustc-env=LD01_WATER_LIBRARY_SHA256={}",
        digest::sha256(&std::fs::read(library).expect("water archive"))
    );
}

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
    identities(&library);
    println!("cargo:rustc-link-search=native={}", directory.display());
    println!("cargo:rustc-link-lib=static=ld01_operating_water");
    let target = env::var("CARGO_CFG_TARGET_OS").expect("target OS");
    println!(
        "cargo:rustc-link-lib={}",
        if target == "macos" { "c++" } else { "stdc++" }
    );
    println!("cargo:rerun-if-env-changed=LD01_OPERATING_SUNDIALS_PREFIX");
    if env::var_os("CARGO_FEATURE_IDA").is_some() {
        let prefix = PathBuf::from(
            env::var_os("LD01_OPERATING_SUNDIALS_PREFIX")
                .expect("ida feature requires an explicitly verified stock SUNDIALS prefix"),
        );
        // The quadratures feature compiles the same glue against stock IDAS,
        // SUNDIALS's IDA with quadratures, from the same release.
        let idas = env::var_os("CARGO_FEATURE_QUADRATURES").is_some();
        let header = if idas {
            "include/idas/idas.h"
        } else {
            "include/ida/ida.h"
        };
        assert!(prefix.is_absolute() && prefix.join(header).is_file());
        // These headers define the ABI of this glue. A verified prefix can be
        // rebuilt in place; an unchanged path must not leave stale C objects.
        // Cargo scans directory dependencies recursively, including transitive
        // headers, without a second manually maintained header inventory.
        println!(
            "cargo:rerun-if-changed={}",
            prefix.join("include").display()
        );
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        let object = out.join("operating_ida.o");
        assert!(
            Command::new("cc")
                .args([
                    "-std=c11",
                    "-O3",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    if idas {
                        "-DOPERATING_IDAS"
                    } else {
                        "-UOPERATING_IDAS"
                    },
                    "-c",
                    "src/ida.c",
                    "-o"
                ])
                .arg(&object)
                .arg("-I")
                .arg(prefix.join("include"))
                .arg("-I")
                .arg(prefix.join("include/suitesparse"))
                .status()
                .expect("compile stock IDA boundary")
                .success()
        );
        assert!(
            Command::new("ar")
                .arg("crs")
                .arg(out.join("liboperating_ida.a"))
                .arg(&object)
                .status()
                .expect("archive IDA boundary")
                .success()
        );
        println!("cargo:rerun-if-changed=src/ida.c");
        println!("cargo:rustc-link-search=native={}", out.display());
        println!(
            "cargo:rustc-link-search=native={}",
            prefix.join("lib").display()
        );
        println!(
            "cargo:rustc-link-arg=-Wl,-rpath,{}",
            prefix.join("lib").display()
        );
        println!("cargo:rustc-link-lib=static=operating_ida");
        for name in [
            if idas { "idas" } else { "ida" },
            "nvecserial",
            "sunmatrixsparse",
            "sunlinsolklu",
            "core",
        ] {
            println!("cargo:rustc-link-lib=sundials_{name}");
        }
        // The glue's direct SparseLu calls stock klu_l_* from the same prefix.
        println!("cargo:rustc-link-lib=klu");
    }
}
