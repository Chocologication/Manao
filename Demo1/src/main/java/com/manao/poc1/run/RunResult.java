package com.manao.poc1.run;

public record RunResult(
    String stdout,
    String stderr,
    int exitCode,
    String jobName
) {
}
