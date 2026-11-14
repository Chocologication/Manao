# Node.js 项目运行环境

本次增加 JavaScript / TypeScript 的控制台和 Web 服务模板。保留 Java、Python 环境；新模板只影响新建项目，不转换已有项目。实际验证结果见[本地验收记录](evidence/node-runtime/2026-11-04.md)；2026-11-12 四模板已在真实集群完成控制台运行、Web 就绪及停止验证，范围和限制见[合并后发布记录](evidence/assistant-studio/cloud-20261112.md)。

## 使用入口

项目列表 → 新建项目 → 运行模板：

| 模板 | ID | 执行方式 |
| --- | --- | --- |
| JavaScript 控制台 | `node-javascript-console` | 编译检查后运行，保留实际退出码 |
| JavaScript Web 服务 | `node-javascript-web` | 启动服务，检查 `/health/ready` |
| TypeScript 控制台 | `node-typescript-console` | `tsc` 编译到 `dist/` 后运行 |
| TypeScript Web 服务 | `node-typescript-web` | `tsc` 编译后启动服务，检查 `/health/ready` |

工具链为 Node.js 24 LTS、pnpm 10.33.0；TypeScript 模板固定 TypeScript 5.9.3、`@types/node` 24.10.0。运行面板展示 `pnpm start`，实际启动器先安装依赖并执行 `pnpm run build`。

Web 模板使用原生 `node:http`，默认容器端口为 3000；配置公网映射时，第一条映射决定应用主端口。公网端口仍由用户指定，范围为 30000–31000，冲突不会自动换号。Web 可选 MySQL、Redis；模板根据平台注入的环境变量检查连接，健康检查失败返回 503，响应不包含连接凭据。控制台模板不提供数据库和公网端口选项。

Web 沿用现有单次运行生命周期：启动预算 1800 秒，首次就绪后最多运行 7200 秒，支持手动停止。普通控制台执行预算为 1800 秒。浏览器 mock 只演示状态与交互，不启动真实容器或公网服务。

## 项目文件与依赖

模板包含 `package.json`、真实生成的 `pnpm-lock.yaml`、`.npmrc`、`.gitignore`、README 和 `src/` 下的示例与测试；TypeScript 额外包含 `tsconfig.json`。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm start
```

平台安装依赖使用 `--frozen-lockfile --ignore-scripts`；修改依赖必须同步锁文件。首版没有独立的 Node 包管理面板；依赖声明和锁文件属于项目文件。需要原生安装脚本的包不属于默认模板验证范围。

应用运行会复制源码到临时目录，跳过 `.git`、`node_modules`、`dist`、`coverage`、`target` 和 `.manao*`，拒绝源码符号链接，并限制 1000 个文件 / 20 MiB。依赖与编译产物留在副本，运行结束后清理副本。项目私有 pnpm store 位于已有 workspace PVC 的 `.manao-cache/node`，不增加缓存 PVC，不跨项目共享可写缓存。

## AI 构建

AI 可读取、修改 `src/`、`package.json`、`pnpm-lock.yaml`、`tsconfig.json` 以及原有允许的文本文件。`node_modules`、`dist`、`coverage`、平台内部文件及凭据文件不可由 AI 工具访问。

Node 项目的 AI 构建根据服务端保存的模板选择 Node 镜像，使用只读源目录、独立 emptyDir 和项目私有缓存；审阅变更只叠加到构建副本。保持现有 Job 身份核验、deadline 和清理回执流程。

| BuildGoal | 固定操作 |
| --- | --- |
| `compile` | 安装锁定依赖 → `pnpm run build` |
| `test` | 安装锁定依赖 → build → `pnpm run test` |
| `package` | 安装锁定依赖 → build → `pnpm pack` |

默认测试命令输出 TAP 日志与 JUnit XML。后端同时解析 Maven Surefire 和 Node `node:test` 的 JUnit 报告；报告缺失、损坏或超过限制时保持缺失状态，不推断测试通过。真实进程退出码独立保留。

## 运行器配置

运行器文件位于 `poc4/node-runner/`，从仓库根目录构建：

```sh
docker build -f poc4/node-runner/Dockerfile -t manao-node-runner:local .
```

镜像包含 Node 24.15.0、pnpm 10.33.0、预置依赖 store 和共享 Java Web supervisor。运行用户为 UID 1001，沿用现有 Job 的只读根文件系统、无 ServiceAccount token 和资源限制。

发布环境由管理员配置 `MANAO_NODE_RUNNER_IMAGE`，值必须为带 `@sha256:` 的不可变镜像引用。未配置时旧环境可继续启动，Node 运行明确返回 `NODE_RUNTIME_NOT_CONFIGURED`。初始本地交付未发布镜像；2026-11-12 已配置真实 runner digest 并完成四模板集群验证，实际发布身份见[云端记录](evidence/assistant-studio/cloud-20261112.md)。

## 验证入口

前端模板 mock 数据由实际后端资源生成：

```sh
cd poc4/frontend
node scripts/sync-node-template-fixtures.mjs --check
pnpm exec playwright test --config playwright.node-runtime.config.ts
```

运行器原生测试从仓库根目录执行，`MANAO_TEST_PNPM` 指向 pnpm 10.33.0 的 `pnpm.cjs`；可用 `MANAO_TEST_OUTPUT` 指定产物目录：

```sh
node --test poc4/node-runner/runner.test.mjs
```

原生测试会真实安装、编译、执行四种模板，并验证 HTTP、停止、非零退出、锁文件不一致和打包。它不替代 Linux 镜像与 Kubernetes 的部署验收。
