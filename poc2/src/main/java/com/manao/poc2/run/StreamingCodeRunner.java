package com.manao.poc2.run;

public interface StreamingCodeRunner {

    void stream(String code, RunEventSink sink);
}
