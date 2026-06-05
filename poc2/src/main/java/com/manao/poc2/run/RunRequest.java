package com.manao.poc2.run;

import jakarta.validation.constraints.NotBlank;

public record RunRequest(
    @NotBlank String code
) {
}
