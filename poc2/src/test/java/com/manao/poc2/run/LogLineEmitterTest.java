package com.manao.poc2.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class LogLineEmitterTest {

    private final LogLineEmitter emitter = new LogLineEmitter();

    @Test
    @DisplayName("emits ordered non-empty log lines from mixed newline chunk")
    void emitLines_whenChunkHasMixedNewlines_emitsOrderedLines() {
        List<RunEvent> events = new ArrayList<>();

        emitter.emitLines("job-123", "first\nsecond\r\nthird\n", events::add);

        assertThat(events)
            .extracting(RunEvent::message)
            .containsExactly("first", "second", "third");
    }

    @Test
    @DisplayName("ignores blank lines")
    void emitLines_whenChunkHasBlankLines_ignoresThem() {
        List<RunEvent> events = new ArrayList<>();

        emitter.emitLines("job-123", "\nfirst\n\n", events::add);

        assertThat(events).hasSize(1);
        assertThat(events.get(0).type()).isEqualTo("log");
        assertThat(events.get(0).jobName()).isEqualTo("job-123");
        assertThat(events.get(0).message()).isEqualTo("first");
    }
}
