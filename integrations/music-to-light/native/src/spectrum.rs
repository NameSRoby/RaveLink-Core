//! First-party Hann-windowed spectrum. Power is normalized by N * sum(w^2),
//! with one-sided bin doubling, then averaged across channel energies.
//! This follows periodogram/Parseval scaling, not an RMS-derived imitation of
//! frequency bands. See docs/research/music-to-light-analysis-and-leases.md.
use crate::{
    levels::{CHANNELS, RATE},
    onsets::{Onset, Onsets},
};
use serde::Serialize;
use std::f64::consts::TAU;

pub const SIZE: usize = 2048;
pub const EDGES: [u32; 4] = [20, 250, 4000, 20000];

#[derive(Clone, Copy, Default)]
struct Complex {
    re: f64,
    im: f64,
}

/// Iterative radix-two transform: fixed storage, no recursion, no audio-sized
/// allocation per transform. Butterfly order is deterministic for split tests.
fn fft(data: &mut [Complex]) {
    let n = data.len();
    debug_assert!(n.is_power_of_two());
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            data.swap(i, j);
        }
    }
    let mut width = 2;
    while width <= n {
        let angle = -TAU / width as f64;
        let step = Complex {
            re: angle.cos(),
            im: angle.sin(),
        };
        for start in (0..n).step_by(width) {
            let mut w = Complex { re: 1.0, im: 0.0 };
            for offset in 0..width / 2 {
                let a = data[start + offset];
                let b = data[start + offset + width / 2];
                let re = w.re * b.re - w.im * b.im;
                let im = w.re * b.im + w.im * b.re;
                data[start + offset] = Complex {
                    re: a.re + re,
                    im: a.im + im,
                };
                data[start + offset + width / 2] = Complex {
                    re: a.re - re,
                    im: a.im - im,
                };
                w = Complex {
                    re: w.re * step.re - w.im * step.im,
                    im: w.re * step.im + w.im * step.re,
                };
            }
        }
        width *= 2;
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Analysis {
    pub first_frame: u64,
    pub end_frame: u64,
    pub band_rms: [f64; 3],
    pub spectral_flux: f64,
    pub onset_threshold: f64,
    pub onset: Option<Onset>,
    pub log_spectral_flux: f64,
    pub log_onset_threshold: f64,
    pub log_onset: Option<Onset>,
    pub valid: bool,
}

pub struct Spectrum {
    ring: Vec<[f64; CHANNELS]>,
    invalid: Vec<bool>,
    invalid_count: usize,
    cursor: usize,
    filled: usize,
    window: Vec<f64>,
    normalizer: f64,
    scratch: Vec<Complex>,
    power: Vec<f64>,
    previous: Vec<f64>,
    primed: bool,
    onsets: Onsets,
    log_onsets: Onsets,
}
impl Spectrum {
    pub fn new() -> Self {
        let window: Vec<_> = (0..SIZE)
            .map(|i| 0.5 - 0.5 * (TAU * i as f64 / SIZE as f64).cos())
            .collect();
        let normalizer = SIZE as f64 * window.iter().map(|v| v * v).sum::<f64>();
        Self {
            ring: vec![[0.0; CHANNELS]; SIZE],
            invalid: vec![false; SIZE],
            invalid_count: 0,
            cursor: 0,
            filled: 0,
            window,
            normalizer,
            scratch: vec![Complex::default(); SIZE],
            power: vec![0.0; SIZE / 2 + 1],
            previous: vec![0.0; SIZE / 2 + 1],
            primed: false,
            onsets: Onsets::new(),
            log_onsets: Onsets::new(),
        }
    }
    pub fn reset(&mut self) {
        self.ring.fill([0.0; CHANNELS]);
        self.invalid.fill(false);
        self.invalid_count = 0;
        self.cursor = 0;
        self.filled = 0;
        self.previous.fill(0.0);
        self.primed = false;
        self.onsets.reset();
        self.log_onsets.reset();
    }
    pub fn push(&mut self, samples: [f64; CHANNELS], invalid: bool) {
        self.invalid_count -= usize::from(self.invalid[self.cursor]);
        self.invalid[self.cursor] = invalid;
        self.invalid_count += usize::from(invalid);
        self.ring[self.cursor] = samples;
        self.cursor = (self.cursor + 1) % SIZE;
        self.filled = (self.filled + 1).min(SIZE);
    }
    pub fn analyze(&mut self, end_frame: u64) -> Option<Analysis> {
        if self.filled < SIZE {
            return None;
        }
        self.power.fill(0.0);
        for channel in 0..CHANNELS {
            let mean = self.ring.iter().map(|s| s[channel]).sum::<f64>() / SIZE as f64;
            for i in 0..SIZE {
                self.scratch[i] = Complex {
                    re: (self.ring[(self.cursor + i) % SIZE][channel] - mean) * self.window[i],
                    im: 0.0,
                };
            }
            fft(&mut self.scratch);
            for (bin, power) in self.power.iter_mut().enumerate() {
                let value = self.scratch[bin];
                let factor = if bin == 0 || bin == SIZE / 2 {
                    1.0
                } else {
                    2.0
                };
                *power += factor * (value.re * value.re + value.im * value.im)
                    / (self.normalizer * CHANNELS as f64);
            }
        }
        let mut bands = [0.0; 3];
        let mut flux = 0.0;
        let mut log_flux = 0.0;
        for (bin, power) in self.power.iter().enumerate() {
            let hz = bin as f64 * RATE as f64 / SIZE as f64;
            for band in 0..3 {
                if hz >= EDGES[band] as f64 && hz < EDGES[band + 1] as f64 {
                    bands[band] += power;
                }
            }
            if hz >= EDGES[0] as f64 && hz < EDGES[3] as f64 {
                let magnitude = power.sqrt();
                let previous = self.previous[bin].sqrt();
                flux += (magnitude - previous).max(0.0);
                // Log compression reveals quieter spectral changes under louder
                // components. Divide by gamma to preserve near-zero units and
                // the detector's existing absolute noise gate. Raw RMS/bands and
                // the legacy detector are untouched for reference comparisons.
                log_flux +=
                    ((100.0 * magnitude).ln_1p() - (100.0 * previous).ln_1p()).max(0.0) / 100.0;
            }
        }
        let valid = self.invalid_count == 0;
        // The initial spectrum is a baseline, not an onset. After invalid data
        // or a source gap, prime again before permitting another event.
        if !self.primed || !valid {
            flux = 0.0;
            log_flux = 0.0;
        }
        let energy = bands.iter().sum::<f64>();
        let (onset, threshold) = self
            .onsets
            .observe(end_frame, flux, energy, self.primed && valid);
        let (log_onset, log_threshold) =
            self.log_onsets
                .observe(end_frame, log_flux, energy, self.primed && valid);
        self.primed = valid;
        self.previous.copy_from_slice(&self.power);
        Some(Analysis {
            first_frame: end_frame - SIZE as u64,
            end_frame,
            band_rms: bands.map(f64::sqrt),
            spectral_flux: flux,
            onset_threshold: threshold,
            onset,
            log_spectral_flux: log_flux,
            log_onset_threshold: log_threshold,
            log_onset,
            valid,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fft_matches_an_independent_direct_transform() {
        let values: Vec<_> = (0..16)
            .map(|i| Complex {
                re: (i as f64 * 0.7).sin(),
                im: 0.0,
            })
            .collect();
        let mut actual = values.clone();
        fft(&mut actual);
        for (k, value) in actual.iter().enumerate() {
            let (mut re, mut im) = (0.0, 0.0);
            for (n, input) in values.iter().enumerate() {
                let angle = -TAU * k as f64 * n as f64 / 16.0;
                re += input.re * angle.cos();
                im += input.re * angle.sin();
            }
            assert!((value.re - re).abs() < 1e-10);
            assert!((value.im - im).abs() < 1e-10);
        }
    }
}
