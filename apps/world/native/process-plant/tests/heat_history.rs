use leitbild_plant_numerics::heat_history::{Feed, Group, Kernel, Rates};
fn kernel() -> Kernel {
    Kernel::new(
        vec![
            Group {
                feed: Feed::Fission,
                energy_per_event: 2.,
                decay_rate: 0.1,
            },
            Group {
                feed: Feed::FertileCapture,
                energy_per_event: 3.,
                decay_rate: 0.01,
            },
        ],
        10.,
    )
    .unwrap()
}
#[test]
fn separate_feeds_and_event_budget() {
    let k = kernel();
    let mut rhs = [0.; 2];
    let h = k
        .rhs_into(
            &[4., 5.],
            Rates {
                fission: 7.,
                fertile_capture: 11.,
            },
            &mut rhs,
        )
        .unwrap();
    assert!((h.prompt + h.delayed + rhs.iter().sum::<f64>() - (10. * 7. + 3. * 11.)).abs() < 1e-13);
    let h = k
        .rhs_into(
            &[4., 5.],
            Rates {
                fission: 0.,
                fertile_capture: 11.,
            },
            &mut rhs,
        )
        .unwrap();
    assert_eq!(h.prompt, 0.);
    assert!(h.delayed > 0.);
    assert!(rhs[1] > 0.);
}
#[test]
fn general_stage_closes_original_rhs_and_source_tangents() {
    let k = kernel();
    let b = [13., 19.];
    let cj = 2.4;
    let rates = Rates {
        fission: 7.,
        fertile_capture: 11.,
    };
    let mut e = [0.; 2];
    let mut rhs = [0.; 2];
    let h = k.stage_into(cj, &b, rates, &mut e).unwrap();
    k.rhs_into(&e, rates, &mut rhs).unwrap();
    for i in 0..2 {
        assert!((cj * e[i] - b[i] - rhs[i]).abs() < 1e-14);
    }
    let hf = k
        .stage_into(
            cj,
            &b,
            Rates {
                fission: 8.,
                ..rates
            },
            &mut e,
        )
        .unwrap();
    assert!((hf.delayed - h.delayed - h.delayed_fission_tangent).abs() < 1e-14);
    assert!(
        (hf.prompt + hf.delayed - h.prompt - h.delayed - h.total_fission_tangent).abs() < 1e-14
    );
    let hc = k
        .stage_into(
            cj,
            &b,
            Rates {
                fertile_capture: 12.,
                ..rates
            },
            &mut e,
        )
        .unwrap();
    assert!((hc.delayed - h.delayed - h.delayed_capture_tangent).abs() < 1e-14);
}
#[test]
fn validation_and_signed_trial_contract() {
    let k = kernel();
    let mut e = [0.; 2];
    assert!(k
        .stage_into(
            0.,
            &[1., 1.],
            Rates {
                fission: 1.,
                fertile_capture: 1.
            },
            &mut e
        )
        .is_err());
    assert!(k
        .stage_into(
            1.,
            &[f64::NAN, 1.],
            Rates {
                fission: 1.,
                fertile_capture: 1.
            },
            &mut e
        )
        .is_err());
    assert!(k
        .rhs_into(
            &[1.],
            Rates {
                fission: 1.,
                fertile_capture: 1.
            },
            &mut e
        )
        .is_err());
    assert!(k
        .stage_into(
            1.,
            &[-1., -1.],
            Rates {
                fission: 0.,
                fertile_capture: 0.
            },
            &mut e
        )
        .is_ok());
    assert!(e.iter().all(|x| *x < 0.)); // Never clip a Newton trial.
    let mut rhs = [0.; 2];
    let signed = Rates {
        fission: -7.,
        fertile_capture: -11.,
    };
    let h = k.rhs_into(&[-4., -5.], signed, &mut rhs).unwrap();
    assert!(h.prompt < 0. && h.delayed < 0. && rhs.iter().all(|x| *x < 0.));
    close_signed_budget(
        h.prompt + h.delayed + rhs.iter().sum::<f64>(),
        -10. * 7. - 3. * 11.,
    );
    let overflow = Kernel::new(
        vec![Group {
            feed: Feed::Fission,
            energy_per_event: 1.,
            decay_rate: f64::MAX,
        }],
        10.,
    )
    .unwrap();
    assert!(overflow
        .stage_into(
            f64::MAX,
            &[1.],
            Rates {
                fission: 0.,
                fertile_capture: 0.
            },
            &mut [0.]
        )
        .is_err());
    assert!(Kernel::new(
        vec![Group {
            feed: Feed::Fission,
            energy_per_event: 10.,
            decay_rate: 1.
        }],
        10.
    )
    .is_err());
}
fn close_signed_budget(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-13);
}
