use std::env;

use status_orbit_lib::benchmark_monitor_sampling;

fn main() -> Result<(), String> {
    let iterations = match env::args().nth(1) {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| "Iterations must be a positive integer.".to_owned())?,
        None => 20,
    };
    let spacing_milliseconds = match env::args().nth(2) {
        Some(value) => value
            .parse::<u64>()
            .map_err(|_| "Spacing must be an integer number of milliseconds.".to_owned())?,
        None => 250,
    };
    let result = benchmark_monitor_sampling(iterations, spacing_milliseconds)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result)
            .map_err(|error| format!("Could not serialize benchmark result: {error}"))?
    );
    Ok(())
}
