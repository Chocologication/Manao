> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# POC4 MVP: User-driven project deletion

Date: 2026-09-16
Base revision: c6ece43; changes remain uncommitted in the Stage 6 worktree.

## Result and evidence boundary

Implementation and focused local validation are complete. Real-cluster lifecycle acceptance is **BLOCKED / NOT RUN**, not PASS. This is neither full Stage 6A acceptance nor Stage 6B work.

Completion invariant: do not remove the durable project row until project runtime handles and owned cluster resources are cleared; do not report deletion in the browser until an authenticated server list confirms absence. Unknown, Forbidden, timeout, remaining PV, and unverified storage policy are not successful cleanup.

## Minimal behavior

- A project-list card offers Delete project, with one permanent-delete confirmation for files, run history and logs.
- CREATING is disabled; backend conflicts for an active Run or a pending workspace operation retain the project and explain why deletion cannot start.
- No optimistic removal and no automatic DELETE replay. Lost responses trigger a read, not another mutation.
- A DELETING card remains visible, blocks Open, and offers Continue deletion. Reload and backend restart do not imply an active background worker; continuation is explicit.
- Success clears only the deleted project's query caches (project/files/runs/terminal audit) and editor buffers. Other projects remain untouched.
- Mock mode has the same user deletion entry point. Browser mock/API-interception evidence is explicitly not Kubernetes evidence.
- No queue, reaper, startup sweep, recycle bin, bulk deletion, force-stop-and-delete, or new deletion task subsystem.

## Backend changes

The existing owner-scoped deletion service, lifecycle gate, DELETING state and dependent-row transaction were reused.

Two old test doubles implemented begin() but not inspect(). The baseline reproduced six failures and one error; fixing the test doubles made their original assertions pass without weakening the production contract.

Storage cleanup now checks the project's bound PV, not only PVC absence:

1. Close runtime handles and remove Jobs/Pods/Services using the existing chain.
2. Confirm workload absence.
3. Verify storage can really reclaim data before deleting the claim. Retain and unsupported/unverified policies preserve the claim and return incomplete.
4. For the observed nfs-subdir-external-provisioner, require onDelete=delete, or archiveOnDelete=false unless onDelete=retain overrides it. Its default archive behavior is not deletion.
5. Delete the PVC and wait for the PV to disappear through normal controller reclamation. The application never deletes a PV or strips finalizers.
6. On retry after PVC disappearance, locate remaining PVs by the exact namespace and deterministic claim name. A noncanonical labeled PVC is preserved as incomplete rather than deleted and losing its identity across restart.
7. Only then allow the existing database transaction to delete dependent records and the project.

Preflight adds cluster-scoped, read-only list persistentvolumes and get storageclasses checks. It uses --all-namespaces for these two authorization checks; namespace resources retain -n. No cluster RBAC was changed in this session.

## Verification

- Original backend deletion baseline: 27 tests, six failures and one error, reproduced before correcting the test doubles.
- Final focused backend suite: 56 passed, zero failures/errors/skips. Includes HTTP conflicts, ownership, lifecycle concurrency, restart continuation, PV remaining after PVC deletion, NFS retention/archive policy, forbidden inventory, noncanonical claim preservation and cluster-scoped authorization checks.
- Real MySQL repository/migration suite: 9 passed using unique disposable manao_stage6_<uuid> schemas. Tests include all dependent tables, rollback after an injected database failure, another owner's project preservation and DELETING migration.
- Frontend full Vitest suite: 66 files / 1175 tests passed. A subsequent narrow cache fix adds terminal-audit cache removal, with all 35 affected project tests passing on the final code.
- Chromium UI contract suite: 4 passed, covering confirmation/Escape cancellation, successful deletion, reload plus explicit continuation, lost response and active-Run rejection. APIs are intercepted, not a live backend.
- Production frontend build and TypeScript checks passed. Existing large-chunk advisory remains; no new bundle-splitting work is included.
- Browser boundary check: 36 tests passed; production mock-boundary verification passed.
- The 16 exact disposable schema names from the two database verification runs were independently checked in information_schema.SCHEMATA: zero remain. Twelve session-only intermediate logs were removed; latest useful verification outputs and UI screenshots were retained.
- Independent read-only review found two concrete issues (noncanonical claim identity loss and namespace-scoped storage authorization checks). Both were reproduced with failing regressions, fixed, and re-reviewed; no outstanding P1/P2 findings remain within that review scope.
- No runtime database tables, diagnostic projects, cluster resources, shared StorageClasses or credentials were changed.

The existing real MVP loop test now ends with a user clicking Delete, authenticated absence checks, independent Job/Pod/Service/PVC/PV inventory, and an attached exact project/run ID record. This extended test is typechecked but has NOT run against the real cluster in this session. Physical NFS absence and runtime DB absence must be verified for that same ID before accepting the lifecycle end to end.

## Why real acceptance is pending

An initial read-only cluster probe succeeded: the three nodes reported Ready; existing project claims used nfs-storage with provisioner k8s-sigs.io/nfs-subdir-external-provisioner and Delete reclaim policy. The backend default manao-workspace-rwx StorageClass was absent. These were point-in-time observations, not an acceptance result.

Subsequently the configured API endpoint 127.0.0.1:6443 refused connections and no backend listened on 18080. A read-only SSH connectivity attempt was closed by the remote host. The existing frontend on 4173 was left untouched. No usable populated backend environment file was found in the project config directory or the previously used temporary secrets directory.

Remaining runtime work:

1. Restore the existing API tunnel and supply the existing private local-cluster environment file (do not commit it).
2. Verify the backend identity has the two additional read-only cluster permissions. A namespaced Role alone is insufficient. The preflight now intentionally fails closed without them.
3. Inspect the actual NFS StorageClass parameters. Delete reclaim policy alone does not prove directory deletion. Do not silently alter a shared StorageClass that also serves unrelated workloads; select an appropriate POC-specific deleting class if necessary.
4. Start the real backend with the current code and run only the extended MVP loop on a newly registered disposable project. Preserve existing diagnostics.
5. Before fixture cleanup can hide problems, correlate browser absence, API 404, zero associated database rows, no project workloads/PVC/PV, and the original NFS project directory (including an archived variant) no longer occupying storage. Check another project remains unaffected.

## Reproduction

Frontend, from poc4/frontend:

~~~powershell
pnpm test -- src/features/projects/ProjectDeletion.test.tsx src/features/projects/ProjectsPage.test.tsx src/features/projects/ProjectCard.test.tsx
pnpm test:e2e:project-deletion
pnpm typecheck:stage6
pnpm build
pnpm test:boundary
~~~

Backend, from poc4/backend with Maven available:

~~~powershell
mvn '-Dtest=ProjectStorageReclamationTest,ProjectResourceCleanerTest,SshApiTunnelHealthTest,ProjectCleanupServiceTest,ProjectDeleteHttpContractTest,ProjectProvisioningServiceTest,ProjectMutationDeletionConcurrencyTest,ProjectLifecycleGateTest' test
# Supply test DB credentials in the environment; these two suites create and drop unique test schemas.
mvn '-Dtest=ProjectDeletionRepositoryTest,ProjectDeletionStateMigrationTest' test
~~~

Runtime acceptance, only after the prerequisites above are satisfied:

~~~powershell
$env:STAGE6_GATE = '1'
pnpm exec playwright test tests/e2e/stage6-real-backend.spec.ts --project=stage6 --grep 'MVP core loop'
~~~

The runtime command alone is not proof of database/physical-storage absence; retain the exact IDs and independent checks described above.

## Runtime follow-up: 2026-09-17

The tunnel/configuration blockers above were resolved. New-project normal deletion and real incomplete-deletion/reload/explicit-continuation were verified against the real backend, MySQL and Kubernetes, with physical NFS absence checked. See [the runtime verification record](2026-09-17-project-deletion-runtime.md) for exact IDs, evidence, existing-project storage-policy limits and the separate Windows test-runner issue. Historical results above are preserved.
