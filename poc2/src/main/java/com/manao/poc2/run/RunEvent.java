package com.manao.poc2.run;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record RunEvent(
    String type,
    String jobName,
    String message,
    Integer code
) {

    public static RunEvent status(String jobName, String message) {
        return new RunEvent("status", jobName, message, null);
    }

    public static RunEvent log(String jobName, String message) {
        return new RunEvent("log", jobName, message, null);
    }

    public static RunEvent exit(String jobName, int code) {
        return new RunEvent("exit", jobName, null, code);
    }

    public static RunEvent error(String jobName, String message) {
        return new RunEvent("error", jobName, message, null);
    }
}
