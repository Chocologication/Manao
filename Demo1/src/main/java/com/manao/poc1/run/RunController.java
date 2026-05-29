package com.manao.poc1.run;

import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RunController {

    private final CodeRunner codeRunner;

    public RunController(CodeRunner codeRunner) {
        this.codeRunner = codeRunner;
    }

    @PostMapping("/run")
    public RunResult run(@Valid @RequestBody RunRequest request) {
        return codeRunner.run(request.code());
    }
}
