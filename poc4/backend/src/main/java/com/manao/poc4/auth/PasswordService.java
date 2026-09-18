package com.manao.poc4.auth;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class PasswordService {
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder(12);
    public String hash(String rawPassword) {
        if (rawPassword == null || rawPassword.isBlank()) throw new IllegalArgumentException("password required");
        return encoder.encode(rawPassword);
    }
    public boolean matches(String rawPassword, String encodedPassword) {
        return rawPassword != null && encodedPassword != null && encoder.matches(rawPassword, encodedPassword);
    }
}
