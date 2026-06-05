package com.manao.poc2.run;

import org.springframework.stereotype.Component;

@Component
public class LogLineEmitter {

    public void emitLines(String jobName, String chunk, RunEventSink sink) {
        if (chunk == null || chunk.isBlank()) {
            return;
        }

        for (String line : chunk.split("\\R")) {
            if (!line.isBlank()) {
                sink.send(RunEvent.log(jobName, line));
            }
        }
    }
}
