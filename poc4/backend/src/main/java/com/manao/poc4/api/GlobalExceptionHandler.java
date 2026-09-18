package com.manao.poc4.api;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public final class GlobalExceptionHandler {
    private static final Logger LOG = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    ResponseEntity<ApiError> api(ApiException exception, HttpServletRequest request) {
        return response(exception.status(), exception.code(), exception.getMessage());
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
        IllegalArgumentException.class})
    ResponseEntity<ApiError> validation(Exception exception) {
        return response(422, "VALIDATION_ERROR", "Request validation failed");
    }

    @ExceptionHandler(AccessDeniedException.class)
    ResponseEntity<ApiError> forbidden() {
        return response(403, "FORBIDDEN", "Access denied");
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ApiError> internal(Exception exception) {
        LOG.error("unhandled {}", exception.getClass().getName());
        return response(500, "INTERNAL_ERROR", "Request failed");
    }

    private ResponseEntity<ApiError> response(int status, String code, String message) {
        return ResponseEntity.status(HttpStatus.valueOf(status))
            .body(new ApiError(code, message, UUID.randomUUID().toString()));
    }
}
