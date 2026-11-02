package com.manao.poc4.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Authenticates every HTTP request from two authorities: the strict JWT claims and the current
 * app_user row. A valid signature alone is not enough — the account must still exist, be
 * enabled and still carry the token's auth_version. Any claim error, version mismatch or
 * database failure clears the security context so the request is rejected by the chain.
 * The single production constructor takes both collaborators; there is no token-only path.
 */
public final class JwtAuthenticationFilter extends OncePerRequestFilter {
    private final JwtService jwt;
    private final UserStore users;

    public JwtAuthenticationFilter(JwtService jwt, UserStore users) {
        if (jwt == null || users == null) throw new IllegalArgumentException("jwt service and user store required");
        this.jwt = jwt;
        this.users = users;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            try {
                JwtService.Claims claims = jwt.parse(header.substring("Bearer ".length()));
                AuthContracts.AccountIdentity identity =
                    new AuthContracts.AccountIdentity(claims.subject(), claims.authVersion());
                if (users.isCurrent(identity)) {
                    SecurityContextHolder.getContext().setAuthentication(
                        UsernamePasswordAuthenticationToken.authenticated(identity, null, List.of()));
                } else {
                    SecurityContextHolder.clearContext();
                }
            } catch (RuntimeException ex) {
                // Invalid token, invalid identity or a failed current-account check: never
                // authenticate from the token alone.
                SecurityContextHolder.clearContext();
            }
        }
        chain.doFilter(request, response);
    }
}
