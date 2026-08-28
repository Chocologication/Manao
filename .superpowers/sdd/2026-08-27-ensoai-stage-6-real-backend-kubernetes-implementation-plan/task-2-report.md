# Task 2 Report - Flyway schema, repositories, and transactional primitives

## Scope completed

- Added Flyway migrations `V1__initial_schema.sql` and `V2__indexes_and_constraints.sql` for all nine required tables.
- Added UTC-injectable `DatabaseClock`, persisted state enums, JDBC repositories for owner-scoped projects, Run CAS state transitions, workspace operation reconciliation, ticket consumption, terminal/audit settlement, and a single fenced instance lease.
- Enabled Spring Flyway and added the Maven Flyway plugin, configured exclusively from `MANAO_DB_*` environment variables.
- Added real-MySQL integration tests. They reject any non-MySQL JDBC URL and explicitly surface unavailable credentials as `REAL_MYSQL_BLOCKED`; no H2 or in-memory fallback was added.

## TDD evidence

### RED

Command (from `poc4/backend`):

```powershell
$env:MAVEN_OPTS='-Dfile.encoding=UTF-8'
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.11-bin\6mqf5t809d9geo83kj4ttckcbc\apache-maven-3.9.11\bin\mvn.cmd' -q '-Dtest=FlywaySchemaTest,AtomicTransitionTest' test
```

Observed expected RED before production implementation: test compilation failed because `Repositories`, `DatabaseClock`, `RunState`, and `InstanceLeaseRepository` did not exist.

### GREEN / verification status

Command above after implementation and the full-module command below both reached the real JDBC boundary but cannot authenticate with the available environment:

```text
REAL_MYSQL_BLOCKED: cannot connect to test schema
Caused by: java.sql.SQLException: Access denied for user 'manao'@'localhost' (using password: NO)
```

`MANAO_DB_URL`, `MANAO_DB_USERNAME`, and `MANAO_DB_PASSWORD` are absent. An attempted Maven `flyway:info` using the MCP schema and `root` without a password was likewise blocked with MySQL error 1045. This is an explicit integration dependency blocker, not a pass.

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
- The required full real-MySQL Maven suite remains BLOCKED until isolated test-schema credentials are injected. Re-run the focused command with those three environment variables, then `mvn -q flyway:info` with the same credentials.
