//! Packet-independent measurement, not artistic smoothing. Fixed stereo f32le
//! format; channel energies are combined, never opposite-phase waveforms.
use crate::spectrum::{Analysis, Spectrum};
use serde::Serialize;

pub const RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
pub const FRAME_BYTES: usize = CHANNELS * 4;
const WINDOW: u64 = 960; // 20 ms, regardless of WASAPI/pipe packet boundaries.

#[derive(Debug, Serialize, PartialEq)]
pub struct Level {
    pub first_frame: u64,
    pub end_frame: u64,
    pub rms: f64,
    pub peak: f64,
    pub dbfs: Option<f64>, // None means digital zero, never an invented floor.
    pub channel_rms: [f64; CHANNELS],
    pub invalid_samples: u32,
    pub clipped_samples: u32,
    pub signal: &'static str,
    pub analysis: Option<Analysis>,
}

pub struct Levels {
    pending: [u8; FRAME_BYTES],
    pending_len: usize,
    position: u64,
    count: u64,
    sums: [f64; CHANNELS],
    peak: f64,
    invalid: u32,
    clipped: u32,
    spectrum: Spectrum,
}

impl Levels {
    pub fn new() -> Self {
        Self {
            pending: [0; FRAME_BYTES],
            pending_len: 0,
            position: 0,
            count: 0,
            sums: [0.0; CHANNELS],
            peak: 0.0,
            invalid: 0,
            clipped: 0,
            spectrum: Spectrum::new(),
        }
    }

    /// Discontinuities invalidate a partially measured window and byte carry.
    /// Preserve the device's frame position; do not pretend a missing interval
    /// contained measured silence or keep the previous nonzero level alive.
    pub fn reset(&mut self, position: u64) {
        self.pending_len = 0;
        self.count = 0;
        self.sums = [0.0; CHANNELS];
        self.peak = 0.0;
        self.invalid = 0;
        self.clipped = 0;
        self.spectrum.reset();
        self.position = position;
    }

    pub fn push(&mut self, mut bytes: &[u8]) -> Vec<Level> {
        let mut output = Vec::new();
        while !bytes.is_empty() {
            let take = (FRAME_BYTES - self.pending_len).min(bytes.len());
            self.pending[self.pending_len..self.pending_len + take].copy_from_slice(&bytes[..take]);
            self.pending_len += take;
            bytes = &bytes[take..];
            if self.pending_len != FRAME_BYTES {
                continue;
            }
            self.pending_len = 0;
            let mut samples = [0.0; CHANNELS];
            let mut frame_invalid = false;
            for (channel, output) in samples.iter_mut().enumerate() {
                let offset = channel * 4;
                let raw =
                    f32::from_le_bytes(self.pending[offset..offset + 4].try_into().unwrap()) as f64;
                // An impossible amplitude is a format/data fault, not an
                // invitation to guess that floats secretly contain int16.
                let sample = if !raw.is_finite() || raw.abs() > 8.0 {
                    self.invalid += 1;
                    frame_invalid = true;
                    0.0
                } else {
                    raw
                };
                if sample.abs() >= 1.0 {
                    self.clipped += 1;
                }
                self.sums[channel] += sample * sample;
                *output = sample;
                self.peak = self.peak.max(sample.abs());
            }
            self.spectrum.push(samples, frame_invalid);
            self.position += 1;
            self.count += 1;
            if self.count == WINDOW {
                output.push(self.finish());
            }
        }
        output
    }

    pub fn silence(&mut self, frames: usize) -> Vec<Level> {
        let mut output = Vec::new();
        for _ in 0..frames {
            output.extend(self.push(&[0; FRAME_BYTES]));
        }
        output
    }

    fn finish(&mut self) -> Level {
        let channel_rms = self.sums.map(|sum| (sum / WINDOW as f64).sqrt());
        let rms = (self.sums.iter().sum::<f64>() / (WINDOW as f64 * CHANNELS as f64)).sqrt();
        let value = Level {
            first_frame: self.position - WINDOW,
            end_frame: self.position,
            rms,
            peak: self.peak,
            dbfs: if rms > 0.0 {
                Some(20.0 * rms.log10())
            } else {
                None
            },
            channel_rms,
            invalid_samples: self.invalid,
            clipped_samples: self.clipped,
            signal: if self.invalid > 0 {
                "invalid"
            } else if self.peak == 0.0 {
                "silent"
            } else {
                "signal"
            },
            analysis: self.spectrum.analyze(self.position),
        };
        self.count = 0;
        self.sums = [0.0; CHANNELS];
        self.peak = 0.0;
        self.invalid = 0;
        self.clipped = 0;
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tone(invert: bool) -> Vec<u8> {
        (0..RATE)
            .flat_map(|i| {
                let sample = (0.5
                    * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / RATE as f64).sin())
                    as f32;
                [sample, if invert { -sample } else { sample }]
                    .into_iter()
                    .flat_map(f32::to_le_bytes)
            })
            .collect()
    }
    #[test]
    fn arbitrary_packet_splits_preserve_every_sample_and_window() {
        let bytes = tone(false);
        let expected = Levels::new().push(&bytes);
        for size in [1, 3, 7, 8, 4096, 4097, 16381] {
            let mut analyzer = Levels::new();
            let actual: Vec<_> = bytes.chunks(size).flat_map(|b| analyzer.push(b)).collect();
            assert_eq!(actual, expected, "packet size {size}");
        }
        assert_eq!(expected.len(), 50);
        assert_eq!(expected.last().unwrap().end_frame, 48_000);
    }
    #[test]
    fn stereo_energy_does_not_cancel_and_tone_has_known_rms() {
        let normal = Levels::new().push(&tone(false));
        let inverted = Levels::new().push(&tone(true));
        assert_eq!(normal, inverted);
        for level in normal {
            assert!((level.rms - 0.5 / 2.0_f64.sqrt()).abs() < 0.00001);
            assert!((level.dbfs.unwrap() + 9.0309).abs() < 0.001);
        }
    }
    #[test]
    fn silence_is_zero_and_invalid_floats_cannot_create_fake_energy() {
        let mut analyzer = Levels::new();
        analyzer.push(&tone(false));
        let quiet = analyzer.silence(960);
        assert_eq!(quiet[0].rms, 0.0);
        assert_eq!(quiet[0].dbfs, None);
        assert_eq!(quiet[0].signal, "silent");
        let invalid: Vec<_> = [f32::NAN, f32::INFINITY]
            .into_iter()
            .cycle()
            .take(1920)
            .flat_map(f32::to_le_bytes)
            .collect();
        let frame = analyzer.push(&invalid).remove(0);
        assert_eq!(frame.invalid_samples, 1920);
        assert_eq!(frame.signal, "invalid");
        assert_eq!(frame.rms, 0.0);
    }
    #[test]
    fn discontinuity_discards_partial_sample_and_resets_position() {
        let mut analyzer = Levels::new();
        analyzer.push(&[9, 8, 7]);
        analyzer.reset(90_000);
        let quiet = analyzer.silence(960);
        assert_eq!(quiet[0].first_frame, 90_000);
        assert_eq!(quiet[0].end_frame, 90_960);
        assert_eq!(quiet[0].rms, 0.0);
    }
}
