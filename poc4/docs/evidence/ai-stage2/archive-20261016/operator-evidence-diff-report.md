# Safe operator failure differences and independent re-collection

Status: diagnostic-only code frozen for root review; no commit, model task or resource mutation.

The original round7 COLLECTION_RUN_CHANGED remains a recorded failure with unknown cause. A preceding read-only diagnostic re-collection had18Run rows before/after with identical nine field values and identical object-key order, and the unmodified strict comparison passed. Thus no evidence established JSON-key ordering as the original cause; no semantic comparison or blind retry was introduced.

## Diagnostic change

Only existing verifier/test changed. COLLECTION_RUN_CHANGED retains exact sorted JSON.stringify inequality, FAIL, stagePassGranted=false, original failures code and exit1; it now adds evidenceDiff before returning. INDEPENDENT_ACTIVE_CHANGED retains the original field authority predicate and failure code, and adds safe active-before/after differences plus expected Run projection.

The helper emits only nine fixed Run fields: id,projectId,state,requestedRevision,createdAt,firstReadyAt,finishedAt,executionPodUid,activeRunMarker. Rows are joined by exact ID, missing before/after rows are null, and strictSerializedChanged separately records whether the original sorted serialization differs. Only primitive string/number/null values are projected; malformed composite values become [invalid]. Unchanged semantic rows are omitted from rows, so key-only differences can be identified as strictSerializedChanged=true with no projected value difference. Task prompts/tool args/model output/HTTP bodies/secrets/credentials/URLs are not collected.

## Local behavior checks

Tests first for fixed-field sensitive-data exclusion/missing-row projection and a real active-Pod-identity change that must stay FAIL. `node --test scripts/ai-stage2-verify-ledger.test.mjs` RED **96pass/2fail (98)**, `operator-evidence-diff-red.log`.

After minimal diagnostics: `node --test scripts/ai-stage2-verify-ledger.test.mjs scripts/ai-stage2-tool-results.test.mjs` **106/106PASS**,0skipped, `operator-evidence-diff-green.log`. `node --check scripts/ai-stage2-verify-ledger.mjs`, `git diff --check`, strict UTF-8/noBOM PASS. No production/browser/worker/backend suite rerun.

## Three independent read-only operator samples

On the same completed task3d9d9bdb-0995-45a5-9bab-113a2d821fc8 and existing R2, executed the operator separately three times, sequentially. Each independently SELECTs its own ledger/Run samples, reads the current Service and performs the existing bounded public GET; no automatic retry or model invocation. Separate files preserve every result:

| Sample | File | Result |
| --- | --- | --- |
| 1 | operator-run7-independent-1.json | PASS,exit0 |
| 2 | operator-run7-independent-2.json | PASS,exit0 |
| 3 | operator-run7-independent-3.json | PASS,exit0 |

No sample reproduced COLLECTION_RUN_CHANGED or INDEPENDENT_ACTIVE_CHANGED; no failed result was converted into PASS. Each JSON retains stagePassGranted=false. These are additional later observations, not a replacement for the original browser-run7 failure or proof of its root cause, and not browser-lifecycle acceptance. Root decides whether a same-task browser continuation meets the remaining stage gates.

All logs/results are under absolute `D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration/.superpowers/sdd/2026-10-16-pi-stage2-implementation-plan/release-20261016/`. Prior temporary instrumentation was deleted exactly after snapshot transfer. No change to task/model/runtime/source content, Run lifecycle or cluster resources.

## Review correction: absent active snapshot

Independent review found that evidenceDiff could throw while diagnosing INDEPENDENT_ACTIVE_CHANGED if activeBefore was null/undefined, escaping the pure verifier's FAIL contract. Added both real-input variants first: verifier test RED98pass/2fail (100), `operator-evidence-null-red.log`. Minimal diagnostic-only fix excludes null rows from the ID map and sorts optional IDs safely; absent before values remain null in the row diff. The strict CLI collection comparison and active authority predicate remain unchanged.

Same verifier test command GREEN100/100,0skipped, `operator-evidence-null-green.log`; node syntax/diff checks PASS. No broad suite/cloud/model/extra operator sample or resource mutation in this correction. Code frozen again for root re-review.
