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
