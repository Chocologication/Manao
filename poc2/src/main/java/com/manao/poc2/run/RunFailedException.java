package com.manao.poc2.run;

public class RunFailedException extends RuntimeException {

    public RunFailedException(String message) {
        super(message);
    }

    public RunFailedException(String message, Throwable cause) {
        super(message, cause);
    }
}
