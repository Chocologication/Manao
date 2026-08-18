package com.manao.poc1.run;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

@ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
public class RunFailedException extends RuntimeException {

    public RunFailedException(String message) {
        super(message);
    }

    public RunFailedException(String message, Throwable cause) {
        super(message, cause);
    }
}
