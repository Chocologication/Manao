package com.manao.poc1.run;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record RunRequest(
    @NotBlank(message = "code must not be blank")
    @Size(max = 65535, message = "code must be at most 65535 characters")
    String code
) {
}
