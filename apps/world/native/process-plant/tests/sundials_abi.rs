//! Compile-only configuration counterexamples. These mutate test headers, never
//! the selected dependency, and do not construct an integrator or advance time.
#![cfg(feature = "offline-ida")]
use std::{env, fs, path::PathBuf, process::Command};

#[test]
fn selected_abi_compiles_and_incompatible_header_profiles_refuse() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let prefix = PathBuf::from(env::var_os("LEITBILD_SUNDIALS_PREFIX").unwrap());
    let scratch =
        env::temp_dir().join(format!("leitbild-sundials-abi-test-{}", std::process::id()));
    fs::create_dir(&scratch).expect("Fresh ABI test directory");
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("Remove owned ABI test directory");
        }
    }
    let _cleanup = Cleanup(scratch.clone());
    let compile = |prelude: Option<&std::path::Path>| {
        let mut cc = Command::new("cc");
        cc.args(["-std=c11", "-Werror", "-fsyntax-only"])
            .arg("-I")
            .arg(prefix.join("include"));
        if let Some(prelude) = prelude {
            cc.arg("-include").arg(prelude);
        }
        cc.arg(root.join("src/sundials-abi.c")).output().unwrap()
    };
    let valid = compile(None);
    assert!(
        valid.status.success(),
        "{}",
        String::from_utf8_lossy(&valid.stderr)
    );
    for (name, changed_config, reason) in [
        (
            "precision",
            "#undef SUNDIALS_DOUBLE_PRECISION\n#define SUNDIALS_SINGLE_PRECISION 1",
            "requires DOUBLE",
        ),
        (
            "index",
            "#undef SUNDIALS_INT64_T\n#define SUNDIALS_INT32_T 1",
            "requires INT64",
        ),
        (
            "mpi",
            "#undef SUNDIALS_MPI_ENABLED\n#define SUNDIALS_MPI_ENABLED 1",
            "requires non-MPI",
        ),
        (
            "version",
            "#undef SUNDIALS_VERSION_MINOR\n#define SUNDIALS_VERSION_MINOR 9",
            "requires pinned SUNDIALS 7.5.0",
        ),
    ] {
        let prelude = scratch.join(format!("{name}.h"));
        fs::write(
            &prelude,
            format!("#include <sundials/sundials_config.h>\n{changed_config}\n"),
        )
        .unwrap();
        let rejected = compile(Some(&prelude));
        assert!(
            !rejected.status.success(),
            "Accepted incompatible {name} profile"
        );
        assert!(
            String::from_utf8_lossy(&rejected.stderr).contains(reason),
            "Wrong refusal for {name}: {}",
            String::from_utf8_lossy(&rejected.stderr)
        );
    }
}
