//! Build script of the TEST-ONLY host spike.
use std::{
    env,
    path::{Path, PathBuf},
};

use leitbild_operating_plant::digest::sha256;

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

/// water-ffi's build script links stock SUNDIALS/KLU dynamically, but its
/// rpath link argument applies to water-ffi's own targets only. This spike's
/// binary and cdylib state the runtime search path themselves: the verified
/// prefix by default, or an explicit `LD01_HOST_SPIKE_RPATH` such as
/// `$ORIGIN/../lib` for a relocatable Linux artifact.
///
/// The kernel identity a snapshot is bound to is the SHA-256 over the
/// kernel's own sources (operating crate, water-ffi glue, this spike), not
/// the executable's bytes: native builds are not byte-reproducible, and the
/// binary and the cdylib carry the same kernel. The water library and the
/// packet are identified separately.
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
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let mut files = Vec::new();
    for directory in [
        "../src",
        "../Cargo.toml",
        "../water-ffi/src",
        "../water-ffi/build.rs",
        "src",
        "Cargo.toml",
        "Cargo.lock",
        "build.rs",
    ] {
        let path = root.join(directory);
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            sources(&path, &mut files);
        } else {
            files.push(path);
        }
    }
    let mut digest_input = Vec::new();
    for file in files {
        let relative = file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .display()
            .to_string();
        digest_input.extend_from_slice(relative.as_bytes());
        digest_input.push(0);
        digest_input.extend_from_slice(sha256(&std::fs::read(&file).expect("source")).as_bytes());
        digest_input.push(b'\n');
    }
    println!(
        "cargo:rustc-env=LD01_KERNEL_SOURCE_SHA256={}",
        sha256(&digest_input)
    );
}
