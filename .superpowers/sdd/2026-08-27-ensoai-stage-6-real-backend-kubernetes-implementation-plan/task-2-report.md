# Task 2 Report - Flyway schema, repositories, and transactional primitives

## Scope completed

- Added Flyway migrations `V1__initial_schema.sql`, `V2__indexes_and_constraints.sql`, and forward-only `V3__workspace_digest_integrity.sql` for all nine required tables and digest integrity.
- Added UTC-injectable `DatabaseClock`, persisted state enums, JDBC repositories for owner-scoped projects, Run CAS state transitions, workspace operation reconciliation, ticket consumption, terminal/audit settlement, and a single fenced instance lease.
- Enabled Spring Flyway and added the Maven Flyway plugin, configured exclusively from `MANAO_DB_*` environment variables.
- Added real-MySQL integration tests. They reject any non-MySQL JDBC URL and do not fall back to H2 or in-memory storage.

## TDD evidence

### RED

Command (from `poc4/backend`):

```powershell
$env:MAVEN_OPTS='-Dfile.encoding=UTF-8'
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' -q '-Dtest=FlywaySchemaTest,AtomicTransitionTest' test
```

Observed expected RED before production implementation: test compilation failed because `Repositories`, `DatabaseClock`, `RunState`, and `InstanceLeaseRepository` did not exist.

### Historical credential note

The initial execution predated injection of the root `AGENTS.md` credentials, so it could not authenticate. That environmental condition was resolved in review repair round 1; the current real JDBC and Flyway results are recorded below.

Successful non-integration checks:

```powershell
$env:MAVEN_OPTS='-Dfile.encoding=UTF-8'
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' -q test-compile
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' -q -DskipTests package
git diff --check
```

All three exited 0. New task files were checked as UTF-8 without BOM and LF-only.

## Real MySQL MCP evidence

- MySQL MCP reported `VERSION() = 8.0.43`, authenticated as `root@localhost`.
- Created the isolated schema `manao_poc4_task2_test`; it contained all nine expected tables after executing the migration-equivalent statements.
- `information_schema` confirmed `uq_run_project_active(project_id, active_run_marker)`, `uq_terminal_run_active(run_id, active_terminal_marker)`, and `uq_workspace_project_pending(project_id, pending_marker)`.
- Actual duplicate insert checks were rejected by MySQL: duplicate username (`app_user.uq_app_user_username`) and a second active Run (`run.uq_run_project_active`).

The MCP executor cannot select the new schema with a multi-statement `USE`; therefore each validation statement was schema-qualified. It validates MySQL 8.0 DDL/constraints, but it does not replace the blocked JDBC/Flyway test run.

## Files changed

- `poc4/backend/pom.xml`
- `poc4/backend/src/main/resources/application.yml`
- `poc4/backend/src/main/resources/db/migration/V1__initial_schema.sql`
- `poc4/backend/src/main/resources/db/migration/V2__indexes_and_constraints.sql`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/DatabaseClock.java`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/RunState.java`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/TerminalSessionState.java`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/WorkspaceOperationState.java`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/Repositories.java`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/InstanceLeaseRepository.java`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/WorkspaceOperationRepository.java`
- `poc4/backend/src/test/java/com/manao/poc4/persistence/FlywaySchemaTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/persistence/AtomicTransitionTest.java`

## Self-review / remaining concern

- Every compare-and-set operation returns false on zero affected rows; callers must refetch authority before performing Kubernetes side effects (enforced by the repository boundary, with full coordination deferred to later Tasks).
- Project creation serializes the per-owner count by locking the owner row. The owner-scoped `existsForOwner` lookup prevents accidental unscoped use by later services.
- The required full real-MySQL Maven suite is now verified in repair round 1 with injected root credentials and the isolated test schema.

## Review repair round 1

Root `AGENTS.md` supplied the local MySQL endpoint (`127.0.0.1:3306`), user `root`, and an external password. The password is intentionally omitted from this report and command output. Using those credentials against the isolated `manao_poc4_test` schema:

### RED before repair

Review baseline with the root `AGENTS.md` credentials was 6/7 passing. The failing lease assertion was caused by `acquire("b", expiresAt == clock.now())`: it issued token 2 with an already-expired row, then the fenced `renew` condition `expires_at > now()` correctly affected zero rows. The repair rejects non-future expiry at acquire/renew boundaries and uses a strictly future lease duration in the successful renew assertion.

The newly added regression tests failed on the two reviewed defects:

- `leaseFencesExpiredHolderAndRejectsNonFutureExpiry`: expected `IllegalArgumentException` for `expiresAt == clock.now()`, but acquire returned a new token.
- `nonDuplicateWorkspaceSqlErrorsAreNotReportedAsDuplicate`: a missing-project foreign-key error was incorrectly returned as `false` because every SQLState `23000` was treated as a duplicate.

The run was `12 tests, 2 failures`; the other 10 tests passed on real MySQL.

### GREEN after repair

```powershell
$env:MANAO_DB_URL='jdbc:mysql://127.0.0.1:3306/manao_poc4_task2_test'
$env:MANAO_DB_USERNAME='root'
$env:MANAO_DB_PASSWORD='<root password from AGENTS.md>'
$env:MAVEN_OPTS='-Dfile.encoding=UTF-8'
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' -q '-Dtest=FlywaySchemaTest,AtomicTransitionTest' test
```

Result: `Tests run: 12, Failures: 0, Errors: 0, Skipped: 0`, `BUILD SUCCESS`.

The repair adds strict future-expiry validation to lease acquire/renew, preserves old-holder fencing, validates all three digest inputs as lowercase 64-character hex, adds immutable `receipt_sha256`, returns receipt digest in pending reconciliation records, maps only MySQL error 1062 to duplicate `false`, and propagates other SQL failures. User/project inserts now explicitly use the injected `DatabaseClock`; all fixtures use fixed instants rather than `Instant.now()`.

### Flyway evidence

```powershell
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' flyway:info
```

Against `jdbc:mysql://127.0.0.1:3306/manao_poc4_test` with the same injected credentials, Flyway reported MySQL 8.0, schema version `3`, and all three versioned migrations in `Success` state (`1 initial schema`, `2 indexes and constraints`, `3 workspace digest integrity`).

### Repair files

- `poc4/backend/src/main/resources/db/migration/V1__initial_schema.sql`
- `poc4/backend/src/main/resources/db/migration/V2__indexes_and_constraints.sql`
- `poc4/backend/src/main/resources/db/migration/V3__workspace_digest_integrity.sql`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/InstanceLeaseRepository.java`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/WorkspaceOperationRepository.java`
- `poc4/backend/src/main/java/com/manao/poc4/persistence/Repositories.java`
- `poc4/backend/src/test/java/com/manao/poc4/persistence/FlywaySchemaTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/persistence/AtomicTransitionTest.java`

The initial report's pre-credential condition is superseded by the real 12/12 green run above.
