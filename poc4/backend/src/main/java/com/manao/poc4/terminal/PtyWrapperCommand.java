package com.manao.poc4.terminal;

import java.util.List;

/** Fixed, root-owned PTY wrapper command baked into the immutable Maven runner image. */
public final class PtyWrapperCommand {
    public static final String WRAPPER_PATH = "/usr/local/bin/manao-pty-wrapper";

    private PtyWrapperCommand() { }

    /** PID-1-safe argument array; never user-controllable. */
    public static List<String> command() {
        return List.of(WRAPPER_PATH);
    }
}
