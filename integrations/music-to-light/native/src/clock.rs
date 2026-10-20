//! WASAPI process loopback can return device position zero for every packet.
//! Count captured frames explicitly; use valid QPC timestamps to detect gaps,
//! never callback wall time or an unsupported endpoint position counter.
pub struct SampleClock {
    next_qpc: Option<u64>,
}
impl SampleClock {
    pub fn new() -> Self {
        Self { next_qpc: None }
    }
    pub fn observe(&mut self, frames: u32, qpc: Option<u64>) -> bool {
        let gap = self
            .next_qpc
            .zip(qpc)
            .is_some_and(|(expected, actual)| expected.abs_diff(actual) > 20_000);
        self.next_qpc = qpc.map(|at| at + frames as u64 * 10_000_000 / crate::levels::RATE as u64);
        gap
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consecutive_packets_do_not_require_a_device_position() {
        let mut clock = SampleClock::new();
        for i in 0..100 {
            assert!(!clock.observe(480, Some(1_000_000 + i * 100_000)));
        }
    }
    #[test]
    fn genuine_timestamp_gap_is_reported_and_unknown_time_is_not_invented() {
        let mut clock = SampleClock::new();
        assert!(!clock.observe(480, Some(1_000_000)));
        assert!(clock.observe(480, Some(1_500_000)));
        assert!(!clock.observe(480, None));
        assert!(!clock.observe(480, Some(9_000_000)));
    }
}
