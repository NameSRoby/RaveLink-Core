//! Strict CLI grammar: one explicit source, timed or parent-owned capture.
use crate::Failure;

#[derive(Debug, PartialEq)]
pub enum Source {
    Process { pid: u32, created: u64 },
    Output(String),
    DefaultOutput,
    FullscreenApp,
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Sources,
    Apps,
    Identify(u32),
    Capture {
        source: Source,
        seconds: u32,
        generation: String,
    },
}

pub fn parse_source(value: &str) -> Result<Source, Failure> {
    if value == "fullscreen-app" {
        return Ok(Source::FullscreenApp);
    }
    if value == "default-output" {
        return Ok(Source::DefaultOutput);
    }
    if let Some(id) = value.strip_prefix("output:") {
        if !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control) {
            return Ok(Source::Output(id.to_owned()));
        }
    }
    if let Some(identity) = value.strip_prefix("process:") {
        let parts: Vec<_> = identity.split(':').collect();
        if parts.len() == 2 {
            if let (Ok(pid), Ok(created)) = (parts[0].parse::<u32>(), parts[1].parse::<u64>()) {
                if pid > 0 && created > 0 {
                    return Ok(Source::Process { pid, created });
                }
            }
        }
    }
    Err(Failure::new("invalid_source"))
}

pub fn parse(args: Vec<String>) -> Result<Command, Failure> {
    if args == ["apps"] {
        return Ok(Command::Apps);
    }
    if args == ["sources"] {
        return Ok(Command::Sources);
    }
    if args.len() == 2 && args[0] == "identify" {
        return args[1]
            .parse::<u32>()
            .ok()
            .filter(|pid| *pid > 0)
            .map(Command::Identify)
            .ok_or_else(|| Failure::new("invalid_pid"));
    }
    if args.len() != 7
        || args[0] != "capture"
        || args[1] != "--source"
        || args[3] != "--seconds"
        || args[5] != "--generation"
    {
        return Err(Failure::new("invalid_arguments"));
    }
    let source = parse_source(&args[2])?;
    let seconds = args[4]
        .parse::<u32>()
        .ok()
        .filter(|v| *v <= 3600)
        .ok_or_else(|| Failure::new("invalid_duration"))?;
    let generation = &args[6];
    if !(16..=64).contains(&generation.len()) || !generation.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(Failure::new("invalid_generation"));
    }
    Ok(Command::Capture {
        source,
        seconds,
        generation: generation.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }
    #[test]
    fn capture_requires_explicit_identity_duration_and_generation() {
        let valid = args(&[
            "capture",
            "--source",
            "process:123:456",
            "--seconds",
            "2",
            "--generation",
            "1234567890abcdef",
        ]);
        assert!(parse(valid.clone()).is_ok());
        for index in [2, 4, 6] {
            let mut bad = valid.clone();
            bad[index] = "".into();
            assert!(parse(bad).is_err());
        }
        let mut continuous = valid.clone();
        continuous[4] = "0".into();
        assert!(parse(continuous).is_ok());
        for value in ["3601", "-1", "NaN"] {
            let mut bad = valid.clone();
            bad[4] = value.into();
            assert!(parse(bad).is_err());
        }
        let mut extra = valid;
        extra.push("--fallback-desktop".into());
        assert!(parse(extra).is_err());
    }
    #[test]
    fn source_scope_never_defaults_or_accepts_ambiguous_processes() {
        for value in [
            "",
            "auto",
            "tidal",
            "process:0:5",
            "process:3:0",
            "process:3:4:5",
            "output:",
            "output:bad\nvalue",
        ] {
            assert!(parse_source(value).is_err(), "{value}");
        }
        assert_eq!(
            parse_source("default-output").unwrap(),
            Source::DefaultOutput
        );
    }
}
