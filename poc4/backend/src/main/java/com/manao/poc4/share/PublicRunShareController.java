package com.manao.poc4.share;

import com.manao.poc4.config.SecurityConfig;
import org.springframework.context.annotation.Conditional;
import org.springframework.web.bind.annotation.*;

@RestController
@Conditional(SecurityConfig.BackendAuthCondition.class)
@RequestMapping("/api/v1/public/run-shares")
public final class PublicRunShareController {
    private final RunShareService service;
    public PublicRunShareController(RunShareService service) { this.service = service; }
    @GetMapping("/{token}")
    public RunShareContracts.PublicShare read(@PathVariable String token) { return service.readPublic(token); }
}
