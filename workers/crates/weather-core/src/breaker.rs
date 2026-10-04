//! A per-provider circuit breaker (closed, open, half-open), ported from
//! `api/py/_circuit_breaker.py`. State lives in the Worker isolate, as it
//! lived in a warm Vercel function: it protects a provider from a burst of
//! calls while it is failing, without any storage round trip.
//!
//! Time is passed in (milliseconds since the epoch) so this stays pure.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// Failures inside `window_ms` that open the circuit.
    pub failure_threshold: u32,
    /// How long the circuit stays open before one trial call.
    pub cooldown_ms: u64,
    /// Failures older than this are forgotten.
    pub window_ms: u64,
}

/// Tomorrow.io: 3 failures in 5 min open it for 2 min.
pub const TOMORROW: Config = Config {
    failure_threshold: 3,
    cooldown_ms: 2 * 60_000,
    window_ms: 5 * 60_000,
};

/// Open-Meteo: 5 failures in 5 min open it for 5 min.
pub const OPEN_METEO: Config = Config {
    failure_threshold: 5,
    cooldown_ms: 5 * 60_000,
    window_ms: 5 * 60_000,
};

#[derive(Debug, Clone)]
pub struct Breaker {
    config: Config,
    state: State,
    failures: Vec<u64>,
    opened_at: u64,
}

impl Breaker {
    pub const fn new(config: Config) -> Self {
        Breaker {
            config,
            state: State::Closed,
            failures: Vec::new(),
            opened_at: 0,
        }
    }

    pub fn state(&self, now_ms: u64) -> State {
        if self.state == State::Open
            && now_ms.saturating_sub(self.opened_at) >= self.config.cooldown_ms
        {
            State::HalfOpen
        } else {
            self.state
        }
    }

    /// Whether a call may go out now. An expired open circuit lets one trial
    /// call through (half-open).
    pub fn allow(&mut self, now_ms: u64) -> bool {
        match self.state(now_ms) {
            State::Closed => true,
            State::HalfOpen => {
                self.state = State::HalfOpen;
                true
            }
            State::Open => false,
        }
    }

    pub fn record_success(&mut self) {
        self.state = State::Closed;
        self.failures.clear();
    }

    pub fn record_failure(&mut self, now_ms: u64) {
        if self.state == State::HalfOpen {
            self.state = State::Open;
            self.opened_at = now_ms;
            return;
        }
        let window = self.config.window_ms;
        self.failures.retain(|t| now_ms.saturating_sub(*t) < window);
        self.failures.push(now_ms);
        if self.failures.len() as u32 >= self.config.failure_threshold {
            self.state = State::Open;
            self.opened_at = now_ms;
            self.failures.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_after_the_threshold_and_recovers_after_cooldown() {
        let mut b = Breaker::new(TOMORROW);
        assert!(b.allow(0));
        b.record_failure(0);
        b.record_failure(1_000);
        assert!(b.allow(2_000));
        b.record_failure(2_000);
        assert_eq!(b.state(2_001), State::Open);
        assert!(!b.allow(60_000));
        // After the 2-minute cooldown one trial call goes through.
        assert!(b.allow(2_000 + 120_000));
        b.record_success();
        assert_eq!(b.state(130_000), State::Closed);
    }

    #[test]
    fn a_failed_trial_reopens() {
        let mut b = Breaker::new(TOMORROW);
        for t in 0..3 {
            b.record_failure(t);
        }
        assert!(b.allow(200_000));
        b.record_failure(200_000);
        assert!(!b.allow(200_001));
    }

    #[test]
    fn old_failures_fall_out_of_the_window() {
        let mut b = Breaker::new(OPEN_METEO);
        for t in 0..4 {
            b.record_failure(t);
        }
        b.record_failure(10 * 60_000);
        assert_eq!(b.state(10 * 60_000), State::Closed);
    }
}
