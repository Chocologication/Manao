# Task 3 Report - JWT authentication, project ownership, and API errors

## Scope completed

- Added short-lived HS256 JWT issuance and strict verification with opaque `sub` and `exp` claims only.
- Added BCrypt password hashing/matching; login reads only a server-side password hash and never returns credentials.
- Added bearer authentication filter and stateless API security. Login is public; project APIs require authentication. Missing JWT secret fails bean creation when the real datasource-backed application starts.
- Added owner-scoped project listing, lookup, and creation with a transactional per-owner three-project cap. Non-owned/unknown project lookup returns the same hidden 404 contract.
- Added `ApiError` and global exception mapping. Browser-visible errors contain only finite `code`, safe `message`, and opaque `traceId`; request IDs, stack traces, JWTs, credentials, Kubernetes resource names, paths and commands are excluded.
- Kept existing actuator health security isolated to `/actuator/health/**` so API security does not alter health behavior.

## TDD evidence

### RED

Added `AuthControllerTest`, `ProjectAuthorizationTest`, and `ErrorSanitizationTest` before production classes. Focused command:

```powershell
$env:MAVEN_USER_HOME='D:\DeepLearning\MyProjects\Project_Manao\.m2'
$env:MAVEN_OPTS='-Dfile.encoding=UTF-8'
& 'D:\DeepLearning\Java\IntelliJ IDEA 2025.2.3\plugins\maven\lib\maven3\bin\mvn.cmd' '-Dtest=AuthControllerTest,ProjectAuthorizationTest,ErrorSanitizationTest' test
```

Expected RED observed: test compilation failed because `JwtService`, `PasswordService`, `AuthController`, `ProjectService`, and `ApiError` did not exist.

### GREEN

After minimal implementation, the focused suite passed:

```text
AuthControllerTest:          4 tests, 0 failures, 0 errors
ProjectAuthorizationTest:   1 test, 0 failures, 0 errors
ErrorSanitizationTest:      2 tests, 0 failures, 0 errors
BUILD SUCCESS
```

The tests cover valid login response keys, wrong-password generic failure, expired/malformed JWT rejection, strict unknown-field rejection, owner isolation, three-project cap, and sensitive error message sanitization.

## Full backend verification

```powershell
$env:MAVEN_USER_HOME='D:\DeepLearning\MyProjects\Project_Manao\.m2'
$env:MAVEN_OPTS='-Dfile.encoding=UTF-8'
Remove-Item Env:MANAO_DB_URL -ErrorAction SilentlyContinue
$env:MANAO_DB_USERNAME='root'
$env:MANAO_DB_PASSWORD='<injected from AGENTS.md; omitted from output>'
& 'D:\DeepLearning\Java\IntelliJ IDEA 2025.2.3\plugins\maven\lib\maven3\bin\mvn.cmd' -q test
```

Result: `BUILD SUCCESS`; Surefire reports show 34 tests total across the module, with 0 failures, 0 errors, and 0 skipped. Persistence tests used their existing real-MySQL schema path. An earlier run with `MANAO_DB_URL` set to the isolated persistence schema correctly exposed an existing configuration-test assumption; rerunning with that variable unset produced the green full suite.

`git diff --check` passed. Changed source/test files were checked as UTF-8 without BOM and LF-only.

## Files changed

- `poc4/backend/src/main/java/com/manao/poc4/auth/JwtAuthenticationFilter.java`
- `poc4/backend/src/main/java/com/manao/poc4/auth/JwtService.java`
- `poc4/backend/src/main/java/com/manao/poc4/auth/PasswordService.java`
- `poc4/backend/src/main/java/com/manao/poc4/auth/AuthController.java`
- `poc4/backend/src/main/java/com/manao/poc4/project/ProjectService.java`
- `poc4/backend/src/main/java/com/manao/poc4/project/ProjectController.java`
- `poc4/backend/src/main/java/com/manao/poc4/api/ApiError.java`
- `poc4/backend/src/main/java/com/manao/poc4/api/ApiException.java`
- `poc4/backend/src/main/java/com/manao/poc4/api/GlobalExceptionHandler.java`
- `poc4/backend/src/main/java/com/manao/poc4/config/SecurityConfig.java`
- `poc4/backend/src/main/java/com/manao/poc4/config/ActuatorConfig.java`
- `poc4/backend/src/test/java/com/manao/poc4/auth/AuthControllerTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/project/ProjectAuthorizationTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/api/ErrorSanitizationTest.java`

## Self-review and concerns

- JWT implementation intentionally supports only the fixed HS256 header and exact compact payload shape; key rotation/refresh/revocation are outside Task 3 and must be added before production rollout.
- Project creation currently records the service clock (`Instant.now`) rather than the repository's injectable `DatabaseClock`; the existing persistence layer remains authoritative for database writes and later tasks should unify this clock if deterministic service-level timestamps are required.
- The Spring bean is deliberately conditional on a datasource so profile-only health/configuration tests can boot without credentials; real datasource-backed startup still fails when `MANAO_JWT_SECRET` is absent or shorter than 32 characters.
- No Kubernetes Deployment, Secret, Role, or 6B resource was created or modified.

## Review repair round 1

### RED

Added regression coverage before repair for path/token/requestId message leakage, opaque unique trace IDs, public `failureReason` filtering, JWT user IDs containing JSON delimiters, missing-secret startup, forbidden error handling, and HTTP serialization. The first repair-focused run failed exactly on the five missing behaviors (message/path leak, `unknown` trace ID, raw failure reason, special user ID acceptance, and startup condition coverage). A subsequent MockMvc fixture run first failed because the nested probe controller was not registered; switching to standalone MockMvc corrected the fixture and preserved the HTTP contract assertion.

### GREEN

`ApiError` now accepts only UUID-shaped trace IDs and generates a fresh UUID for null, blank, or arbitrary values. Error messages reject sensitive identifiers, path-shaped values, control characters, and internal resource vocabulary. `ProjectController` exposes only the finite `WORKSPACE_RECONCILIATION_REQUIRED` failure reason. `SecurityConfig` emits the same three-field `ApiError` for both 401 and 403 via authentication and access-denied handlers. `JwtService.issue` validates opaque IDs against `[A-Za-z0-9_-]{1,64}` before constructing JSON. A narrowly scoped backend-auth condition validates the JWT secret in contexts without a DataSource while allowing explicit DataSource-excluded profile-only health/configuration tests to boot.

Repair focused suite:

```text
AuthControllerTest:          5 tests, 0 failures, 0 errors
ProjectAuthorizationTest:   2 tests, 0 failures, 0 errors
ErrorSanitizationTest:      5 tests, 0 failures, 0 errors
SecurityConfigTest:          1 test,  0 failures, 0 errors
HttpErrorContractTest:       1 test,  0 failures, 0 errors
```

`HttpErrorContractTest` uses standalone MockMvc and parses the actual JSON response, asserting exactly `code`, `message`, and `traceId` plus UUID-shaped correlation. The full module suite then passed with `41` tests, `0` failures, `0` errors, and `0` skipped against the existing real-MySQL persistence setup. `git diff --check` remained clean; changed files are UTF-8 without BOM and LF-only.

### Repair concerns

- The access-denied path is covered by the handler contract test and explicit Spring Security configuration; a full authenticated integration request remains deferred to the later end-to-end security stage.
- The startup condition treats an explicit `spring.autoconfigure.exclude` of `DataSourceAutoConfiguration` as a profile-only test mode. Production profiles must not exclude datasource auto-configuration and therefore fail closed when `MANAO_JWT_SECRET` is absent.

## Review repair round 2

### RED

Added three HTTP/MockMvc regression cases that throw `ApiException` messages containing a raw JWT-like compact token, an unlabelled password value, and a Java stack-frame string. Before the production change, all three tests failed because the caller-supplied message was serialized into the browser response.

### GREEN

Replaced the blacklist sanitizer with an error-code allowlist: `ApiError` now ignores arbitrary input messages and selects a fixed safe message only from the finite error code (`UNAUTHENTICATED`, `FORBIDDEN`, `PROJECT_LIMIT_REACHED`, `VALIDATION_ERROR`, `ENTRY_NOT_FOUND`, or generic `Request failed`). This makes arbitrary JWT/password/stack/path/resource text non-observable by construction rather than by keyword coverage. Existing UUID trace ID generation, 401/403 handlers, failure-reason allowlist, strict JWT subject validation, and startup secret condition remain intact.

Repair focused command and result:

```powershell
$env:MAVEN_USER_HOME='D:\DeepLearning\MyProjects\Project_Manao\.m2'
$env:MAVEN_OPTS='-Dfile.encoding=UTF-8'
& 'D:\DeepLearning\Java\IntelliJ IDEA 2025.2.3\plugins\maven\lib\maven3\bin\mvn.cmd' '-q' '-Dtest=AuthControllerTest,ProjectAuthorizationTest,ErrorSanitizationTest,SecurityConfigTest,HttpErrorContractTest' test
```

`HttpErrorContractTest`: 4 tests, 0 failures, 0 errors; all repair-focused classes: 17 tests, 0 failures, 0 errors. The full backend suite passed with 41 tests, 0 failures, 0 errors, and 0 skipped. `-DskipTests package` and `git diff --check` passed; changed files remain UTF-8 without BOM and LF-only. Commit: `fix(poc4): harden task3 error message allowlist`.

### Repair concerns

- Messages are intentionally fixed per error code, so future user-facing detail must be introduced as a reviewed finite code/message mapping rather than passing runtime exception text through.
