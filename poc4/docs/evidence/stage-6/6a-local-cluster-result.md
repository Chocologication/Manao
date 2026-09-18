> **历史来源 / 2026-09-17 已被现行记录取代：** 当前 6A 范围、验收决定和证据以[唯一现行事实现状](../../../../docs/Stage6A-Current-Facts.md)为准。下文保留原时点的设计、计划和结果；其中“当前”、待实施、FAILED/不允许 6B 等只描述旧时点，不覆盖本次用户验收决定，也不自动授权重新执行。原始结果不改写。此链接指向主检出的单份文档，不复制第二份现状。

# 阶段六 6A 本机集成验证记录（真实集群前置条件轮）

> 2026-09-10 状态更新：本文其余内容为历史基础设施/修复记录，不是当前验收结果。用户报告重启集群后基础五项 E2E 全通过，最新末次状态文件佐证 passed；完整 6A 仍未通过，6B 未开始。当前节点、残留资源、身份检查及证据限制见 [最新状态](2026-09-10-status-and-next-steps.md) 与 [只读快照](2026-09-10-readonly-snapshot.json)。历史管理员身份和 namespace 配额不能沿用为当前事实。

- 日期：2026-08-29（2026-09-04 更新 SHA 引用至第二轮代码 SHA）
- 后端 Git SHA：`26331be5b57f9683401b26edbb2ec5f825293d5f`（后端代码 SHA；最终 HEAD 见 git log。原记录 SHA `ce550660e90fe2f432aae9bc8509b232afd2e792` 已被第二轮代码 SHA 取代）
- 执行环境：Windows 11 开发机；kubectl 经 SSH 隧道访问真实集群；本机 MySQL（root，Flyway 从空库迁移已在 `FlywaySchemaTest` 等测试中验证）
- 所有集群探针资源均带 `stage6-test=true` 标签，位于一次性 namespace `manao-stage6-test`

## 1. 集群与存储

```text
kubectl get nodes
NAME     STATUS   ROLES           AGE   VERSION
master   Ready    control-plane   35d   v1.31.13
node1    Ready    worker          35d   v1.31.13
node2    Ready    worker          35d   v1.31.13

kubectl get sc
nfs-storage (default)        k8s-sigs.io/nfs-subdir-external-provisioner   Delete   Immediate
openebs-hostpath (default)   openebs.io/local                              Delete   WaitForFirstConsumer
```

选定 `nfs-storage` 作为项目 PVC 的 RWX StorageClass。

## 2. RWX 10Gi PVC + 跨节点 UID/GID/fsGroup 探针

```yaml
# /tmp/rwx-pvc.yaml（节选）
metadata: {name: rwx-verify, namespace: manao-stage6-test, labels: {stage6-test: "true"}}
spec: {accessModes: [ReadWriteMany], storageClassName: nfs-storage, resources: {requests: {storage: 10Gi}}}
```

结果：`Bound pvc-af89f007... 10Gi RWX nfs-storage`

写入（node1，root）：

```text
pod/rwx-writer（nodeSelector node1）命令：echo stage6-rwx-ok > /data/probe.txt && sync && stat -c %u:%g /data/probe.txt
状态：Completed；输出：0:0
```

读取+写入（node2，`runAsUser/runAsGroup/fsGroup = 10001`）：

```text
pod/rwx-reader（nodeSelector node2）命令：cat /data/probe.txt && touch /data/probe2.txt && ls -la /data/
状态：Completed；输出：
stage6-rwx-ok
-rw-r--r--  1 root   root      14 ... probe.txt
-rw-r--r--  1 10001  10001     0 ... probe2.txt
```

结论：同一 NFS PVC 在两个节点上挂载；node2 以 10001 身份可读 root 写入的文件（目录 0777）并可创建新文件
（属主 10001:10001）。initializer 的 chown/chmod 探针前提成立。**PASS**

## 3. 镜像拉取

```text
pod rwx-writer:  Pulling busybox:1.36 → Pulled (217ms)
pod maven-egress: eclipse-temurin:17-jre → Completed
pod maven-dep-egress: maven:3.9-eclipse-temurin-17 → Completed
```

集群节点可从公网 registry 拉取镜像。**部分 PASS**；受控 registry + 本项目镜像（digest 固定）
部分为 SKIPPED（本机 Docker daemon 未运行，无法构建/推送 workspace-agent 与 maven-runner）。

## 4. Maven 依赖出网

```text
pod maven-dep-egress（maven:3.9-eclipse-temurin-17）：
  mvn -q dependency:get -Dartifact=junit:junit:4.13.2
  EXIT=0
```

Maven Central 出网可用，未配置内部镜像的前提下依赖解析成功。**PASS**

## 5. API Server TLS

```text
kubeconfig：server https://127.0.0.1:6443 + certificate-authority-data（无 insecure-skip-tls-verify）
证书 SAN：DNS:kubernetes, ..., DNS:localhost, DNS:master, ..., IP:10.233.0.1, IP:172.16.0.5,
          IP:127.0.0.1, IP:::1, IP:172.16.0.4, IP:172.16.0.13
```

`tls-server-name: localhost` 为证书实际提供的 SAN；kubectl 全程保持 CA 与主机名校验。
注意：当前 kubeconfig 身份为集群管理员，超出设计要求的 namespace Role —— 受限 kubeconfig
（tls-server-name + CA + namespace Role）是 6A 决策门剩余阻断项之一。**结构 PASS / 身份 SKIPPED**

## 6. namespace 配额

```text
kubectl create quota -n manao-stage6-test stage6-quota \
  --hard=requests.storage=60Gi,persistentvolumeclaims=6,pods=12
resourcequota/stage6-quota created（requests.storage: 10Gi/60Gi 已计入探针 PVC）
```

**PASS**

## 7. 测试资源清单（保留至证据采集完成）

```text
ns/manao-stage6-test（stage6-test=true）
pvc/rwx-verify; pod/rwx-writer; pod/rwx-reader; pod/maven-egress; pod/maven-dep-egress
quota/stage6-quota
```

全部带 `stage6-test=true` 标签，可整体清理。

## 8. 后端测试基线（同 SHA）

```text
poc4/backend: mvn test → 176 tests, 0 failures（含 Stage6aPreflightTest）
poc4/workspace-agent: mvn test → 23 tests, 0 failures
poc4/frontend: pnpm typecheck → PASS
```

## 9. 尚未执行（依赖操作者前置条件）

- 本机后端以 `local-cluster` profile 启动 + Fabric8 `/version` 双预检
- 受限 namespace Role kubeconfig 与 `auth can-i` 全量校验
- 真实项目创建 → PVC → initializer → workspace Pod → 模板写入 → READY 全链路
- 真实 Job（maven-runner 镜像）/ 日志 / PTY / audit 浏览器 E2E（`pnpm test:e2e:stage6`）
- `stage6-operator` 故障测试身份


## 修复轮记录（2026-08-30）

审查报告确认 17+3 项源码阻断；全部修复，backend `190 tests, 0 failures`、agent `23 tests, 0 failures`。
要点：V5 迁移（terminal ticket FK 解耦、run.fencing_token、terminal cols/rows）、
RunObservationService + RuntimeMaintenanceLoop（@Scheduled/@PreDestroy）、RunLogIngestor
（Fabric8 watchLog → persistence-first）、initializer 改 init 容器并在成功后删除、recovery 增加
label 核验与模板 receipt、镜像 digest fail-closed、SshApiTunnelHealth 26 项 can-i 矩阵 +
Fabric8 /version + tls-server-name 校验、WebSocket 同源白名单、E2E 门模式不再静默跳过。
详见 `6a-gate.md` 修复轮复审版。构建产物 SHA-256（前 16 位）`227d416ddca8b110`。


## 2026-09-03 第二轮：证据已被 6a-gate.md 第二轮小节取代

第二轮（探针冷启动 / bridge 监听 / E2E 覆盖）修复已提交（代码 SHA `26331be5b57f9683401b26edbb2ec5f825293d5f`；最终 HEAD 见 git log），
其证据见 `poc4/docs/evidence/stage-6/6a-gate.md`「第二轮修复」小节。本文档其余历史段落（§1–§9 及
「修复轮记录」）保持原样，仅头部 SHA 引用已刷新至新 HEAD；旧记录不再作为当前 6A 状态依据，
以 6a-gate.md 为准。
