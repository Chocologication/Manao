#!/usr/bin/env node
/**
 * AI stage one: INDEPENDENT acceptance-build re-verification (pi-stage1 plan
 * Task 6; run by the acceptance OPERATOR, never the browser and never the model).
 *
 * It re-verifies the model-modified REAL project through the SAME read-only-copy
 * executor semantics the backend's DevelopmentBuildExecutor uses in the cluster:
 * the fixed root-owned `manao-dev-build` launcher of the Maven runner image, with
 *   - an init-equivalent container that mounts the project source READ-ONLY at
 *     /source and copies it into a scratch workspace (`manao-dev-build copy`),
 *   - an execution-equivalent container that mounts ONLY the scratch, the project
 *     maven cache and /tmp — never the source — and runs the fixed
 *     `manao-dev-build run test` (same UID 10001, read-only rootfs, dropped
 *     capabilities, TMPDIR/HOME=/tmp as JobResourceFactory.containerSecurity()).
 *
 * Between copy and run, the script overlays the ACCEPTANCE-CONTROLLED pom
 * (tests/fixtures/ai-stage1/acceptance-pom.xml) as the scratch copy's pom.xml:
 * the operator's pom replaces the scratch pom only — the saved project source is
 * never modified, the overlay is never visible to the model, and no user pom
 * skip/exclude can influence the verdict (the pom forces skipTests/skip false and
 * pins surefire to the acceptance test).
 *
 * The verdict requires ALL of:
 *   - `manao-dev-build copy` exit 0 (the source really copied);
 *   - `manao-dev-build run test` exit 0 (the REAL zero exit — exit 1 or a missing
 *     exit fails);
 *   - the Surefire XML for com.example.app.DemoControllerAcceptanceTest, read
 *     from the fixed log-tail markers (MANAO-SUREFIRE-REPORT-BEGIN/END — exactly
 *     what the backend parses), with tests>=1, failures=0, errors=0, skipped=0;
 *     missing markers or a missing report FAIL;
 *   - the staged source fingerprint unchanged after the run (the read-only mount
 *     held; nothing wrote back);
 *   - cleanup evidence: both containers ran with --rm and a name-based docker
 *     listing shows nothing left; the temp tree is deleted on success.
 *
 * Source modes:
 *   --source <dir>            isolated local drill: the directory IS the project
 *                             source (this machine's verification path).
 *   --api                     real round: export the SAVED project source through
 *                             the owner file API (exportProjectTree: tree walk +
 *                             content download with parent-directory creation),
 *                             so the build runs against what the model actually
 *                             left behind.
 *   --image <ref>             runner image reference; the local default is the
 *                             test tag, the release round passes the released
 *                             digest (recorded in the acceptance record).
 *
 * Exit 0 = the independent re-verification passed. Exit 1 = any rule failed
 * (reasons listed). Exit 2 = configuration/transport error. Imported as a module
 * (the unit test) nothing runs — only exportProjectTree is exported.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ACCEPTANCE_POM = fileURLToPath(new URL('../tests/fixtures/ai-stage1/acceptance-pom.xml', import.meta.url));
const ACCEPTANCE_TEST_CLASS = 'com.example.app.DemoControllerAcceptanceTest';
const REPORT_BEGIN = 'MANAO-SUREFIRE-REPORT-BEGIN';
const REPORT_END = 'MANAO-SUREFIRE-REPORT-END';

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function hostPath(path) {
  // Docker Desktop accepts forward-slash Windows paths; normalize separators.
  return path.split(sep).join('/');
}

function fingerprint(stagingDir) {
  const entries = {};
  const visit = (dir, relative) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      if (statSync(full).isDirectory()) {
        visit(full, rel);
      } else {
        entries[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    }
  };
  visit(stagingDir, '');
  return entries;
}

function runDocker(argsOut, options = {}) {
  // Node spawns docker directly (no shell, no MSYS conversion); bind paths are
  // already native Windows/POSIX paths produced by Node itself.
  const result = spawnSync('docker', argsOut, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout?.toString('utf8') ?? '';
  const stderr = result.stderr?.toString('utf8') ?? '';
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw Object.assign(new Error(`docker ${argsOut.slice(0, 3).join(' ')}… failed (rc=${result.status}): ${stderr.trim().slice(0, 400)}`), {
      code: result.status, stdout, stderr,
    });
  }
  return { code: result.status, stdout, stderr };
}

/**
 * Exports the SAVED, model-modified project through the owner file API into
 * `stagingDir`: a depth-first walk of the workspace tree — directories recurse,
 * files download. Nested paths create their parent directories (mkdirSync
 * recursive) because a real Java project is deep
 * (src/main/java/com/example/app/...). Exported for the unit test, which runs
 * the SAME function against a stubbed fetch and a temp directory — no
 * deployment required.
 */
export async function exportProjectTree({ baseUrl, token, projectId, stagingDir, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, '');
  const authed = { Authorization: `Bearer ${token}` };
  mkdirSync(stagingDir, { recursive: true });

  async function walk(directory, relative) {
    const childPath = (name) => (directory === '' ? name : `${directory}/${name}`);
    const url = directory === ''
      ? `${base}/api/v1/projects/${projectId}/files/tree`
      : `${base}/api/v1/projects/${projectId}/files/tree?path=${encodeURIComponent(directory)}`;
    // Fail closed (review fix I10): a legal-JSON 401/403/500 tree error used to parse
    // and read as an empty directory (`tree.entries ?? []`), letting the re-verification
    // continue on an incomplete export. The status AND the response structure are both
    // checked; any directory export failure rejects the whole export.
    const treeResponse = await fetchImpl(url, { headers: authed });
    if (!treeResponse.ok) {
      throw new Error(`tree export failed for "${directory || '<root>'}": HTTP ${treeResponse.status}`);
    }
    const tree = await treeResponse.json();
    if (tree === null || typeof tree !== 'object' || !Array.isArray(tree.entries)) {
      throw new Error(`malformed tree response for "${directory || '<root>'}"`);
    }
    for (const entry of tree.entries) {
      const entryPath = entry.path ?? childPath(entry.name);
      const target = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.kind === 'directory') {
        await walk(entryPath, target);
      } else {
        const contentResponse = await fetchImpl(
          `${base}/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(entryPath)}`,
          { headers: authed },
        );
        if (!contentResponse.ok) {
          throw new Error(`content export failed for "${entryPath}": HTTP ${contentResponse.status}`);
        }
        const content = await contentResponse.json();
        if (content === null || typeof content !== 'object' || typeof content.content !== 'string') {
          throw new Error(`malformed content response for "${entryPath}"`);
        }
        const file = join(stagingDir, target.split('/').join(sep));
        mkdirSync(file.slice(0, file.lastIndexOf(sep)), { recursive: true });
        writeFileSync(file, content.content, 'utf8');
      }
    }
  }
  await walk('', '');
}

async function main() {
  const args = process.argv.slice(2);
  const MODE_API = args.includes('--api');
  const SOURCE_DIR = argValue(args, '--source') ? resolve(argValue(args, '--source')) : undefined;
  const IMAGE = argValue(args, '--image') ?? 'manao-pi-stage1-runner:test';
  const RUNNER_IMAGE_LOCAL = !IMAGE.includes('@sha256:');

  if (!MODE_API && !SOURCE_DIR) {
    console.error('independent-reverify: pass --source <dir> (local drill) or --api (saved project via the owner file API)');
    process.exit(2);
  }
  if (MODE_API && SOURCE_DIR) {
    console.error('independent-reverify: --source and --api are mutually exclusive');
    process.exit(2);
  }
  if (MODE_API && !(process.env.MANAO_AI_ACCEPTANCE_BASE_URL && process.env.MANAO_AI_ACCEPTANCE_USERNAME
      && process.env.MANAO_AI_ACCEPTANCE_PASSWORD && process.env.MANAO_AI_ACCEPTANCE_PROJECT_ID)) {
    console.error('independent-reverify: --api requires MANAO_AI_ACCEPTANCE_BASE_URL/USERNAME/PASSWORD/PROJECT_ID');
    process.exit(2);
  }
  if (!existsSync(ACCEPTANCE_POM)) {
    console.error(`independent-reverify: acceptance pom not found at ${ACCEPTANCE_POM}`);
    process.exit(2);
  }

  const PREFIX = `ai-stage1-reverify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const WORK = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
  const STAGING = join(WORK, 'source'); // the read-only copy's host side
  const SCRATCH = join(WORK, 'scratch');
  const CACHE = join(WORK, 'maven-cache');
  const failures = [];
  const notes = [];

  function stageFromLocal() {
    cpSync(SOURCE_DIR, STAGING, { recursive: true });
    notes.push(`source staged from the local directory ${SOURCE_DIR}`);
  }

  async function stageFromApi() {
    const base = process.env.MANAO_AI_ACCEPTANCE_BASE_URL.replace(/\/+$/, '');
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.MANAO_AI_ACCEPTANCE_USERNAME,
        password: process.env.MANAO_AI_ACCEPTANCE_PASSWORD,
      }),
    });
    if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
    const token = (await login.json()).accessToken;
    cpSync(ACCEPTANCE_POM, join(WORK, 'acceptance-pom.xml')); // provenance copy
    await exportProjectTree({
      baseUrl: process.env.MANAO_AI_ACCEPTANCE_BASE_URL,
      token,
      projectId: process.env.MANAO_AI_ACCEPTANCE_PROJECT_ID,
      stagingDir: STAGING,
    });
    notes.push('source exported through the owner file API of the acceptance deployment (the saved, model-modified project)');
  }

  try {
    if (MODE_API) {
      await stageFromApi();
    } else {
      stageFromLocal();
    }
  } catch (error) {
    console.error(`independent-reverify: source staging failed: ${error.message}`);
    rmSync(WORK, { recursive: true, force: true });
    process.exit(2);
  }

  const before = fingerprint(STAGING);

  // --- Init-equivalent: read-only copy ---------------------------------------
  const copyResult = runDocker(['run', '--rm', '--name', `${PREFIX}-copy`,
    '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp', '--network', 'none',
    '-v', `${hostPath(STAGING)}:/source:ro`, '-v', `${hostPath(SCRATCH)}:/workspace`,
    IMAGE, '/usr/local/bin/manao-dev-build', 'copy'], { allowFailure: true });
  const copyOk = copyResult.code === 0;
  if (copyOk) {
    notes.push('copy container exit 0 (read-only /source mount, scratch-only /workspace)');
  } else {
    failures.push(`manao-dev-build copy did not succeed (exit ${copyResult.code}: ${copyResult.stderr.trim().slice(0, 300)}); the read-only copy is the executor's first gate`);
  }

  // --- Operator-controlled pom overlay (after copy, before run) --------------
  let overlayOk = false;
  if (copyOk) {
    cpSync(ACCEPTANCE_POM, join(SCRATCH, 'pom.xml'));
    overlayOk = true;
    notes.push('acceptance pom overlaid as the SCRATCH copy\'s pom.xml only; the saved source is untouched and the overlay is never visible to the model');
  }

  // --- Execution-equivalent: fixed test goal on the scratch only -------------
  let runLog = '';
  let runCode = null;
  if (overlayOk) {
    const run = runDocker(['run', '--rm', '--name', `${PREFIX}-run`,
      '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp',
      '-e', 'TMPDIR=/tmp', '-e', 'HOME=/tmp', '-w', '/workspace',
      '-v', `${hostPath(SCRATCH)}:/workspace`, '-v', `${hostPath(CACHE)}:/maven-cache`,
      IMAGE, '/usr/local/bin/manao-dev-build', 'run', 'test'], { allowFailure: true });
    runCode = run.code;
    runLog = run.stdout + run.stderr;
    notes.push(`run container exit ${runCode} (mounts: scratch /workspace, cache /maven-cache, tmp /tmp; NO /source)`);
  }

  // --- Surefire report from the fixed log-tail markers -----------------------
  let report = null;
  if (runCode !== null) {
    const begin = runLog.indexOf(REPORT_BEGIN);
    const end = runLog.lastIndexOf(REPORT_END);
    if (begin < 0 || end <= begin) {
      failures.push(`the run log carries no complete ${REPORT_BEGIN}/${REPORT_END} section; a missing report can never count as a pass`);
    } else {
      const section = runLog.slice(begin + REPORT_BEGIN.length, end);
      const suites = [...section.matchAll(/<testsuite\b[^>]*>/g)].map((match) => match[0]);
      const suite = suites.find((tag) => tag.includes(`name="${ACCEPTANCE_TEST_CLASS}"`));
      if (!suite) {
        const found = suites.map((tag) => /name="([^"]+)"/.exec(tag)?.[1] ?? '?').join(', ');
        failures.push(`no Surefire suite for ${ACCEPTANCE_TEST_CLASS} in the report section (found: ${found || 'none'})`);
      } else {
        const count = (attribute) => Number((new RegExp(`${attribute}="(\\d+)"`).exec(suite) ?? [])[1] ?? '-1');
        report = {
          tests: count('tests'),
          failures: count('failures'),
          errors: count('errors'),
          skipped: count('skipped'),
        };
        if (report.tests >= 1 && report.failures === 0 && report.errors === 0 && report.skipped === 0) {
          notes.push(`Surefire report: tests=${report.tests} failures=${report.failures} errors=${report.errors} skipped=${report.skipped}`);
        } else {
          failures.push(`Surefire report for ${ACCEPTANCE_TEST_CLASS}: tests=${report.tests}, failures=${report.failures}, errors=${report.errors}, skipped=${report.skipped}; tests>=1 with zero failures/errors/skipped required`);
        }
      }
    }
  }

  // --- Verdict inputs --------------------------------------------------------
  if (runCode === null) {
    failures.push('the run container never executed (the copy or overlay step failed first)');
  } else if (runCode !== 0) {
    failures.push(`manao-dev-build run test exited ${runCode}; the independent re-verification requires the real exit 0`);
  } else {
    notes.push('the independent acceptance build really exited 0');
  }

  const after = fingerprint(STAGING);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    notes.push('staged source fingerprint unchanged after the run (the read-only copy semantics held)');
  } else {
    failures.push('the staged source changed during the re-verification; the read-only-copy executor semantics were violated');
  }

  // --- Cleanup evidence ------------------------------------------------------
  const listing = runDocker(['ps', '-a', '--format', '{{.Names}}', '--filter', `name=${PREFIX}`], { allowFailure: true });
  const leftovers = listing.stdout.split('\n').filter((line) => line.trim().length > 0);
  if (leftovers.length === 0) {
    notes.push('no containers left behind (--rm cleanup confirmed by name filter)');
  } else {
    failures.push(`containers survived the run: ${leftovers.join(', ')}`);
  }
  let workDeleted = false;
  try {
    rmSync(WORK, { recursive: true, force: true });
    workDeleted = !existsSync(WORK);
  } catch { workDeleted = false; }
  if (workDeleted) {
    notes.push('temp tree deleted (staged source copy, scratch with the overlaid pom, maven cache)');
  } else {
    failures.push(`the temp tree ${WORK} could not be fully deleted; remove it manually and record why`);
  }

  const verdict = {
    script: 'ai-stage1-independent-reverify',
    mode: MODE_API ? 'api-export' : 'local-source',
    image: IMAGE,
    imageKind: RUNNER_IMAGE_LOCAL ? 'local-test-tag (NOT a release digest)' : 'digest-pinned',
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    report,
    failures,
    notes,
    checkedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
