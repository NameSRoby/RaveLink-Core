//! Known-signal expectations; these test physical units and events, not a copy
//! of the analyzer's internal formulas. No microphone/player/fixture is used.
use crate::levels::{Level, Levels, RATE};

fn samples(seconds: f64, mut signal: impl FnMut(usize) -> [f32; 2]) -> Vec<u8> {
    (0..(seconds * RATE as f64) as usize)
        .flat_map(|i| signal(i).into_iter().flat_map(f32::to_le_bytes))
        .collect()
}
fn tone(i: usize, hz: f64) -> f32 {
    (0.5 * (std::f64::consts::TAU * hz * i as f64 / RATE as f64).sin()) as f32
}
fn analyze(bytes: &[u8]) -> Vec<Level> {
    Levels::new().push(bytes)
}

#[test]
fn known_tones_select_the_correct_band_with_correct_energy() {
    for (band, hz) in [93.75, 1000.0, 8000.0].into_iter().enumerate() {
        let frames = analyze(&samples(0.4, |i| {
            let s = tone(i, hz);
            [s, s]
        }));
        let a = frames.last().unwrap().analysis.as_ref().unwrap();
        assert!(a.valid);
        assert!(
            (a.band_rms[band] - 0.5 / 2.0_f64.sqrt()).abs() < 0.002,
            "{hz} {:?}",
            a.band_rms
        );
        for other in 0..3 {
            if other != band {
                assert!(a.band_rms[other] < 0.002, "{hz} {:?}", a.band_rms);
            }
        }
    }
}
#[test]
fn spectrum_uses_channel_energy_and_does_not_cancel_opposite_phase() {
    let normal = analyze(&samples(0.5, |i| {
        let s = tone(i, 1000.0);
        [s, s]
    }));
    let inverted = analyze(&samples(0.5, |i| {
        let s = tone(i, 1000.0);
        [s, -s]
    }));
    assert_eq!(normal, inverted);
    let one = analyze(&samples(0.5, |i| [tone(i, 1000.0), 0.0]));
    assert!((one.last().unwrap().analysis.as_ref().unwrap().band_rms[1] - 0.25).abs() < 0.002);
}
#[test]
fn spectrum_and_onsets_ignore_packet_boundaries_and_real_silence_stays_zero() {
    let bytes = samples(1.0, |i| {
        let s = if i % 24000 < 480 {
            tone(i, 1000.0)
        } else {
            0.0
        };
        [s, s]
    });
    let expected = analyze(&bytes);
    for size in [1, 7, 4097] {
        let mut analyzer = Levels::new();
        let actual: Vec<_> = bytes.chunks(size).flat_map(|p| analyzer.push(p)).collect();
        assert_eq!(actual, expected);
    }
    let zero = analyze(&samples(0.3, |_| [0.0, 0.0]));
    for frame in zero {
        assert_eq!(frame.rms, 0.0);
        if let Some(a) = frame.analysis {
            assert_eq!(a.band_rms, [0.0; 3]);
            assert_eq!(a.spectral_flux, 0.0);
            assert!(a.onset.is_none());
        }
    }
}
#[test]
fn spectral_change_is_detectable_without_a_loudness_change() {
    let frames = analyze(&samples(0.6, |i| {
        let s = tone(i, if i < 14400 { 1000.0 } else { 8000.0 });
        [s, s]
    }));
    for frame in &frames {
        assert!((frame.rms - 0.5 / 2.0_f64.sqrt()).abs() < 0.002);
    }
    assert!(frames
        .iter()
        .filter_map(|f| f.analysis.as_ref())
        .filter(|a| a.end_frame >= 14400 && a.end_frame <= 18000)
        .any(|a| a.spectral_flux > 0.1));
}

#[test]
fn parallel_log_detector_finds_weak_high_attacks_over_a_sustained_tone() {
    let hits: Vec<_> = (0..8).map(|i| 14400 + i * 24000).collect();
    let frames = analyze(&samples(4.5, |i| {
        let bed = 0.8 * tone(i, 1000.0);
        let hit = if hits.iter().any(|at| i >= *at && i < *at + 960) {
            0.04 * tone(i, 8000.0)
        } else {
            0.0
        };
        [bed + hit, bed + hit]
    }));
    let events: Vec<_> = frames
        .iter()
        .filter_map(|f| f.analysis.as_ref())
        .filter_map(|a| a.log_onset.as_ref())
        .collect();
    for (index, hit) in hits.iter().enumerate() {
        assert!(
            events
                .iter()
                .any(|event| event.detected_at_frame >= *hit as u64
                    && event.detected_at_frame <= *hit as u64 + 2880),
            "missing log attack {index}: {events:?}"
        );
    }
    assert_eq!(
        events.len(),
        hits.len(),
        "sustained tone must not invent extra log attacks"
    );
    assert!(events.windows(2).all(|pair| pair[0].id < pair[1].id));
    assert!(frames
        .iter()
        .filter_map(|f| f.analysis.as_ref())
        .all(|a| a.log_spectral_flux.is_finite() && a.log_onset_threshold.is_finite()));
}
#[test]
fn ten_generated_attacks_produce_ten_unique_events_with_bounded_detection_delay() {
    let hits: Vec<_> = (0..10).map(|i| 9600 + i * 24000).collect();
    let frames = analyze(&samples(5.0, |i| {
        let s = if hits.iter().any(|at| i >= *at && i < *at + 480) {
            tone(i, 1000.0)
        } else {
            0.0
        };
        [s, s]
    }));
    let onsets: Vec<_> = frames
        .iter()
        .filter_map(|f| f.analysis.as_ref())
        .filter_map(|a| a.onset.as_ref())
        .collect();
    assert_eq!(onsets.len(), hits.len(), "{onsets:?}");
    for (index, (onset, hit)) in onsets.iter().zip(hits).enumerate() {
        assert_eq!(onset.id, index as u64 + 1);
        assert!(
            onset.detected_at_frame >= hit as u64 && onset.detected_at_frame <= hit as u64 + 2880
        );
    }
}
#[test]
fn sustained_tone_and_dc_do_not_manufacture_repeated_onsets() {
    for bytes in [
        samples(1.0, |i| {
            let s = tone(i, 1000.0);
            [s, s]
        }),
        samples(0.3, |_| [0.5, 0.5]),
    ] {
        assert!(analyze(&bytes)
            .iter()
            .filter_map(|f| f.analysis.as_ref())
            .all(|a| a.onset.is_none()));
    }
}
#[test]
fn invalid_overlap_is_flagged_and_discontinuity_rewarms_analysis() {
    let mut analyzer = Levels::new();
    analyzer.push(&samples(0.1, |i| {
        let s = tone(i, 1000.0);
        [s, s]
    }));
    let broken = analyzer.push(&samples(0.06, |i| {
        if i == 0 {
            [f32::NAN, 0.0]
        } else {
            [0.0, 0.0]
        }
    }));
    assert!(!broken[0].analysis.as_ref().unwrap().valid);
    assert!(!broken[1].analysis.as_ref().unwrap().valid);
    assert!(broken
        .iter()
        .filter_map(|f| f.analysis.as_ref())
        .all(|a| a.onset.is_none()));
    analyzer.reset(50000);
    let after = analyzer.silence(2880);
    assert!(after[0].analysis.is_none());
    assert!(after[1].analysis.is_none());
    assert!(after[2].analysis.as_ref().unwrap().valid);
}
