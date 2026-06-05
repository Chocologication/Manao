package com.manao.poc2.run;

@FunctionalInterface
public interface RunEventSink {

    void send(RunEvent event);
}
