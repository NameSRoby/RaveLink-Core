//! Positive-magnitude spectral-flux thresholding, with sample-clock refractory
//! time. This detects spectral attacks, not beats, instruments or musical tempo.
//! Background threshold statistics never overwrite the measured audio level.
use serde::Serialize;

pub const REFRACTORY: u64 = 5760; // 120 ms at the explicit 48 kHz source rate.
#[derive(Debug, Serialize, PartialEq)]
pub struct Onset {
    pub id: u64,
    pub detected_at_frame: u64,
    pub strength: f64,
}
pub struct Onsets {
    mean: f64,
    deviation: f64,
    last: Option<u64>,
    sequence: u64,
}
impl Onsets {
    pub fn new() -> Self {
        Self {
            mean: 0.0,
            deviation: 0.0,
            last: None,
            sequence: 0,
        }
    }
    pub fn reset(&mut self) {
        self.mean = 0.0;
        self.deviation = 0.0;
        self.last = None;
    }
    pub fn observe(
        &mut self,
        frame: u64,
        flux: f64,
        power: f64,
        valid: bool,
    ) -> (Option<Onset>, f64) {
        let threshold = (self.mean + 3.0 * self.deviation).max(0.001);
        if !valid {
            self.reset();
            return (None, threshold);
        }
        let eligible = self
            .last
            .is_none_or(|last| frame.saturating_sub(last) >= REFRACTORY);
        let onset = if eligible && power >= 0.000001 && flux > threshold {
            self.sequence += 1;
            self.last = Some(frame);
            Some(Onset {
                id: self.sequence,
                detected_at_frame: frame,
                strength: flux,
            })
        } else {
            None
        };
        let delta = flux - self.mean;
        self.mean += delta * 0.05;
        self.deviation += (delta.abs() - self.deviation) * 0.05;
        (onset, threshold)
    }
}
