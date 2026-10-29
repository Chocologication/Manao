package com.manao.poc4.auth;

import java.security.Principal;

/**
 * Authentication contracts shared by the HTTP layer and the account lifecycle tasks.
 * The identity is derived only from the verified token claims plus the current app_user row;
 * request bodies never supply the owner or the version.
 */
public final class AuthContracts {
    private AuthContracts() {
    }

    /**
     * The authenticated account for one request: the user id and the auth_version the token was
     * signed with. {@code getName()} keeps returning the user id so all existing owner checks
     * stay unchanged, while follow-up tasks can bind issued tickets/connections to the version.
     */
    public record AccountIdentity(String userId, long authVersion) implements Principal {
        public AccountIdentity {
            if (userId == null || userId.isBlank()) {
                throw new IllegalArgumentException("user identity required");
            }
            if (authVersion < 0) {
                throw new IllegalArgumentException("auth version must be non-negative");
            }
        }

        @Override
        public String getName() {
            return userId;
        }
    }
}
