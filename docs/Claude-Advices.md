# 码瑙项目技术探索建议（POC 路线图）

> 整理时间：2026-05-12
> 基于 PRD V4.0 与以下前置条件：
> - 比赛项目，非生产级，但 UX 要求中等及以上
> - 演示并发 < 20 人
> - 开发者后端最熟，前端为短板

---

## 一、核心判断逻辑

**风险 = 不确定性 × 失败影响**

- 后端最熟 → CRUD / Spring Cloud / MQ / DB 都是 **低风险**
- 不熟领域 → K8s 编程、前端工作台、WebSocket 实时流、Monaco
- 最高风险 = 决定项目能不能演示的核心链路

如果 POC 1-3 任何一个跑不通，整个项目就要重新设计。**先把核心闭环验证完，再做工程化的事。**

---

## 二、POC 0：环境准备（半天，前置工作）

| 内容 | 工具 |
|---|---|
| 多节点 K8s 集群 | 已部署并确认各节点可调度；NFS 已接入集群 |
| 中间件起一套 | docker compose：MySQL + Redis + MongoDB + RabbitMQ + MinIO |
| 本地能 kubectl 访问 | 配 kubeconfig，验证 `kubectl get nodes` |

说明：

- 对象存储用 **MinIO**，免费且 S3 兼容，比赛演示足够
- POC 3 依赖一个状态为 `Bound`、支持 `ReadWriteMany` 的 NFS PVC；先在至少两个工作节点验证挂载和读写

---

## 三、POC 1：K8s 动态创建 Pod 跑用户 Java 代码 ⚠️ 最高风险

**为什么最高风险**：整个码瑙的存在意义就在这一步。这条路走不通项目就废了。

### 目标

```
HTTP POST /run { "code": "public class Main { ... }" }
→ 返回 stdout
```

### 关键验证点

1. Spring Boot 集成 **Fabric8 Kubernetes Client**（比官方 API 友好）
2. 用 ConfigMap 注入代码 → 挂载到 Pod（仅用于 POC 1 的最小执行验证；通过 POC 3 后改为挂载 NFS 项目目录）
3. 创建 **Job**（不是 Pod，Job 自带成功/失败状态机）
4. 等待 Job 完成 → 读 Pod logs → 返回

### Plan B

如果 ConfigMap 注入有问题，改用 emptyDir + initContainer 从 OSS 拉代码。

### 验证完成标准

浏览器调一个接口，30 秒内能拿到 `Hello World` 输出。

### 预估时间

1-2 天

---

## 四、POC 2：实时日志流（高风险）

**为什么高风险**：用户体验的关键。如果只能等程序跑完一次性返回，UX 是"中等"以下。WebSocket + K8s logs follow 大概率没写过。

### 目标

```
前端点"运行" → WebSocket 连后端
→ Pod 一边跑，前端一边看到日志逐行出现
```

### 关键验证点

1. Fabric8 Client 的 `watchLog()` API（流式读 Pod 日志）
2. Spring 的 `@ServerEndpoint` 或 `WebSocketHandler`
3. 把 logs stream 转成 WebSocket 消息推前端
4. 进程结束 → 推一个 `{type: "exit", code: 0}` 收尾

### Plan B

降级为 SSE（Server-Sent Events），实现更简单，单向推够用。

### 预估时间

2-3 天

---

## 五、POC 3：多节点代码持久化与直接运行（中高风险，核心闭环）

**第一性原理**：源代码必须有唯一的持久化权威副本；后端 Pod 与被调度到任意节点的运行 Job 都必须读取同一份数据。POC 只运行单个 `main.py`，先用原子保存保证 Job 读取到完整文件；不为尚未需要的“多文件可复现运行”引入复制快照的工程量。

因此，代码实际落在 **NFS 服务器的机器硬盘**，Kubernetes 通过支持 `ReadWriteMany`（RWX）的 PVC 将它挂载给后端和运行 Job。`hostPath` 只代表某一个 K8s 节点的磁盘，不能满足多节点任意调度，POC 3 不使用它。

### 目标

跑通以下完整流程：

```
后端 Pod（读写挂载同一个 RWX PVC）
  → 保存到 /workspace/<userId>/<projectId>/main.py
  → 原子提交为当前修订
  ↓
运行 Job（可在任意节点调度；只读挂载该项目目录）
  → 执行 /workspace/main.py
  → 日志和退出码回传后端
```

### 存储与挂载方案（POC 阶段采用）

| 项目 | 决策 | 原因 |
|---|---|---|
| 底层存储 | NFS 服务器本地磁盘 | 数据直接持久化到已有机器硬盘，且可被多节点通过网络访问 |
| Kubernetes 卷 | 一个 `manao-workspace-rwx` PVC，`accessModes: [ReadWriteMany]`，状态必须为 `Bound` | 后端和 Job 可跨节点共享，不需要节点亲和性或固定调度 |
| 工作区组织 | `/workspace/<userId>/<projectId>/` 为在线源码 | 目录与项目一一对应，POC 不维护运行副本 |
| 后端挂载 | PVC 挂载到 `/workspace`，读写 | 后端唯一负责目录创建、权限校验和保存 |
| 运行 Job 挂载 | 同一 PVC 的 `subPath: <userId>/<projectId>` 挂到 `/workspace`，`readOnly: true` | Job 直接以项目目录为工作目录，只能读取本项目源码，不能篡改或读取其他项目 |
| 临时写入 | Job 的 `/tmp`、解释器缓存和编译产物使用 `emptyDir` | 运行副作用不污染源码，也不会在 NFS 留下垃圾文件 |

POC 先使用一个共享 PVC，避免“每项目一个 PVC”带来的 PV/PVC 生命周期和回收复杂度；目录的创建、列举、读取、写入、删除均须先由后端按项目成员权限校验，前端不得自行拼接或传入物理路径。运行前端语义明确为“运行当前已成功保存的代码”，而非“运行不可变版本快照”。

### 保存、运行与归档规则

1. **保存**：后端仅接受相对文件路径；规范化后拒绝 `..`、绝对路径和符号链接逃逸。写入同目录临时文件，完成 `fsync` 后以原子 `rename` 替换 `main.py`，并记录递增的 `revision`。
2. **运行**：后端完成本次保存并取得 `revision` 后创建 `runId` 与 Job，将项目目录直接以只读 `subPath` 挂载到 `/workspace`，设置 Job 的 `workingDir: /workspace` 后执行 `main.py`。任务记录 `runId`、`revision`、文件 SHA-256 和启动时间，用于追溯当时请求运行的内容。
3. **并发**：同一项目的“保存完成 → 创建 Job”使用项目粒度互斥锁；后端多副本部署时使用 Redis 等分布式锁，不能只依赖 JVM 进程内锁。锁仅覆盖原子保存与 Job 创建，不阻塞运行期间的后续编辑。单文件原子 `rename` 保证 Job 打开文件时读到旧文件或新文件，不会读到半写入内容；POC 不承诺运行期间多文件修改的一致性。
4. **运行期写入**：源码挂载只读。设置 `TMPDIR=/tmp`、`HOME=/tmp`；Python 设置 `PYTHONDONTWRITEBYTECODE=1`，Java 等需要编译的语言将 class/缓存写入 `/tmp`（`emptyDir`）。Job 不得向项目目录写入产物、日志或缓存。
5. **完成清理**：Job 仅把 stdout、stderr、退出码、revision、文件 SHA-256 和资源摘要写回后端；`emptyDir` 随 Job 结束自动回收，无需维护 NFS 运行目录清理任务。
6. **备份与退出登录**：退出登录不再触发“唯一保存”。NFS 中的在线代码是主副本；保存后异步上传 MinIO 作为带 revision 的版本归档与灾备，NFS 故障恢复时从最近已确认归档恢复。异步失败必须可重试并展示状态，不能影响已成功保存的编辑体验。

### 安全与权限边界

- 后端 ServiceAccount 可创建 Job；运行 Job 使用独立、最小权限的 ServiceAccount，不授予读取 PVC 以外的 Kubernetes API 权限。
- 运行 Job 使用非 root 用户、只读根文件系统、`allowPrivilegeEscalation: false`，并限制 CPU、内存、进程数与运行时长；这些限制与共享存储相互独立，二者都必须存在。
- NFS 导出目录的属主/权限须与后端 Pod 的 `runAsUser`、`runAsGroup`、`fsGroup` 对齐；在真实后端镜像和运行镜像上验证创建、覆盖、读取和只读拒写。
- `userId` 和 `projectId` 只能由后端从认证上下文和数据库解析；目录名使用受控 ID，不使用用户昵称或前端传来的路径。

### POC 验收标准

1. 在两个不同工作节点分别启动临时 Pod，均能通过同一 RWX PVC 创建、读取和删除测试文件；PVC 保持 `Bound`。
2. 后端在节点 A 所在 Pod 保存 `main.py` 后，强制将 Job 调度到节点 B，Job 能执行并返回预期输出。
3. 保存新版 `main.py` 与创建 Job 并发时，Job 输出旧完整版本或新完整版本，绝不出现截断或混合内容；任务记录中存在对应文件 SHA-256 与 revision。
4. 运行 Job 对 `/workspace/main.py` 写入失败，对 `/tmp` 写入成功；Job 不可访问其他 `userId/projectId` 的目录。
5. Job 结束后 NFS 项目目录内没有运行产物；MinIO 异步归档失败时，NFS 上最新已保存源码仍可打开和运行。

### 预估时间

2-3 天（含 NFS 多节点挂载、权限、跨节点执行和并发快照验证）

---

## 六、POC 4：Monaco Editor 工作台前端（高风险，前端短板）

**为什么高风险**：前端是短板，而 Monaco 是项目门面，评委一眼看到的就是这个。做得糙整个项目卖相就差。

### 目标

最小可用的工作台：

```
左侧文件树 → 点击文件 → 中间 Monaco 显示内容 → 改完 Ctrl+S 调后端保存
右下角"运行"按钮 → 触发 POC 1 + POC 2 的流程 → 日志显示在底部
```

### 关键验证点

1. Monaco 多 tab、语法高亮（Java/Python/Go）
2. 文件树组件（用 Element Plus 的 `el-tree`，别自己造）
3. Monaco 自动保存策略（防抖 1s 保存一次）
4. WebSocket 日志显示组件（用 xterm.js 渲染日志，效果好还能复用到容器终端）

### Plan B

用 code-server（VSCode 浏览器版）iframe 嵌入。**但比赛展示用别人的产品会扣印象分，不推荐。**

### 预估时间

4-7 天

---

## 七、POC 5：AI 集成 + 上下文构建（中风险）

**为什么中风险**：API 调用本身简单，但把上下文组装成 AI 真能帮上忙的 prompt 是个工程活。

### 目标

```
用户代码报错 → 后端把 {代码 + 报错 + 文件名 + 语言} 组成 prompt
→ 调 DeepSeek / 通义 / Kimi API（推荐 DeepSeek，便宜效果好）
→ 流式返回 AI 建议 → WebSocket 推前端
```

### 关键验证点

1. AI 厂商 SDK 流式输出（SSE 模式）→ 前端 typing 效果
2. Prompt 模板设计：解释代码 / 分析报错 / 优化建议 三类
3. 多轮对话上下文压缩（超长对话怎么裁剪）

### Plan B

失败可以降级为非流式、单轮问答，依然能演示。

### 预估时间

2-3 天

---

## 八、POC 6：容器 Shell（低风险，可砍）

### 目标

xterm + WebSocket 桥接 K8s exec，让用户能进容器跑命令。

### 评估

实现不难（Fabric8 有 `exec()` API），但对核心功能演示不是必须。时间紧可以放到最后甚至砍掉。

### 预估时间

1-2 天

---

## 九、推荐执行顺序与里程碑

```
Day 1     POC 0 环境准备
Day 2-3   POC 1 K8s 跑代码           ✅ 跑通 = 项目可行
Day 4-6   POC 2 实时日志              ✅ 跑通 = UX 有保障
Day 7-8   POC 3 文件挂载              ✅ 跑通 = PRD 设计落地
Day 9-15  POC 4 Monaco 工作台         ✅ 跑通 = 前端不卡脖子
Day 16-18 POC 5 AI 集成               ✅ 跑通 = 卖点齐全
Day 19+   开始正式开发完整系统
```

**关键里程碑**：POC 1 + 2 + 3 跑通（约 1 周），就证明这个比赛项目技术可行，可以放心动工写正式代码。后面 4 / 5 是"打磨"和"卖点"。

---

## 十、工程取舍建议（针对比赛阶段）

| PRD 里写的 | 比赛阶段建议 | 原因 |
|---|---|---|
| 8 个微服务 | **先单体 Spring Boot**，最多拆 2-3 个（业务 + AI + 容器调度） | 8 个微服务一个人撑不住，部署、调试都慢 |
| Nacos + Gateway + Spring Cloud Alibaba | **延后**，正式动工时再决定 | 单体 + Spring Security 够用 |
| Helm + Jenkins + DevOps | **延后** | 比赛演示手动 `kubectl apply` 完全 OK |
| Prometheus + Grafana + Loki | **延后**，先用 KubeSphere 自带的 | KubeSphere 演示用够了 |
| 多语言镜像（7 种） | **先做 Java 一种**，最后补 Python 一种 | 演示时 2 种切换够亮 |

---

## 十一、技术栈备注

### 选型确定项

- **K8s Client**：Fabric8（不用官方那套）
- **集群存储**：NFS + `ReadWriteMany` PVC（多节点共享工作区）
- **对象存储**：MinIO（不用云 OSS，省钱且本地可控）
- **AI 模型**：DeepSeek（便宜效果好）
- **代码持久化**：NFS RWX PVC 为在线主副本；Job 只读直接运行项目目录；MinIO 仅作异步版本归档与灾备

### Pod 运行模式选择

| 模式 | 适用场景 | 本项目选择 |
|---|---|---|
| Job 一次性运行 | leetcode 风格的"提交代码看结果" | **POC 阶段用这个** |
| Deployment + PVC 长驻 | Codespaces 风格的持久工作区 | 后期可升级 |
| exec 注入 | 已有 Pod 直接塞代码执行 | 不推荐，隔离性差 |

---

## 十二、下一步

POC 0 环境准备 + POC 1 核心闭环代码骨架可以即刻开始，先把"提交代码到容器执行并返回输出"这条最小链路跑通，即可确认整个项目的技术可行性。

---

## 十三、POC 4 工作台对抗性评审后的已确认决策（2026-08-18）

本节覆盖前文 POC 4 的实现边界；若与 POC 3 的“共享 PVC + 后端直挂”假设冲突，POC 4 以“每项目 PVC + 工作区 Pod”方案为准。

### 目标与范围

- 真实连接 Kubernetes：用户可在桌面浏览器中创建项目、查看目录树、编辑并显式保存文件、启动 `mvn clean test`、查看日志和进入活动 Job 容器的交互式 Shell。
- 前端采用 React + TypeScript + Vite；现有静态 HTML 仅作视觉参考。POC 不考虑移动端、Git 状态、上传、拖拽、批量文件操作、项目删除、多人协作和 AI CRUD。
- Java 17 + Maven 3.9 为唯一运行基线。项目创建后自动生成最小 Maven 模板。

### 身份、项目与存储

- 使用环境变量中的固定测试账号登录；后端签发短期 JWT。项目为单一所有者私有，所有请求都必须由 JWT 推导用户与项目权限。
- 每个用户最多创建 3 个项目。每个项目创建一个 10 GiB RWX PVC、一个常驻工作区 Pod，以及对应的 MySQL 元数据。
- 工作区 Pod 读写挂载本项目 PVC，仅供主后端通过集群内网络调用；不暴露 Service/Ingress，不授予 Kubernetes API 权限。浏览器不得直接访问工作区 Pod。
- MySQL 持久化项目、所有权、PVC/Pod 映射、运行状态、日志索引和终端审计；PVC 是项目文件的权威来源。

### 文件规则

- 保存仅由显式保存或 `Ctrl+S` 触发；有未保存编辑器缓冲时禁止启动运行。
- 支持文件/目录创建、重命名和二次确认删除；后端仅接受相对路径，并拒绝绝对路径、`..` 与符号链接逃逸。
- 代码文本文件最大 20 MiB；Markdown 最大 50 MiB，超过 20 MiB 时降级为纯文本并关闭 Markdown 增强；二进制或超限文件不加载 Monaco。
- POC 默认展示隐藏文件。项目 PVC 不得保存平台密钥；后端仍必须强制路径规范化和所有权校验。

### 运行、日志与终端

- 同一项目同一时刻最多一个活动 Job；活动期间禁止前端编辑和 AI 操作。用户可主动终止；最大运行时长为 30 分钟，后端确认 Job 终止后才解除锁。
- Job 使用 `mvn clean test`，资源硬上限为 8 CPU、16 GiB 内存和 10 GiB 临时磁盘。用户可填写较小资源值，后端必须校验上限。
- Maven Job 容器读写挂载项目 PVC，交互式 Shell 进入同一活动容器，因此也可读写工作区。这是已接受的 POC 取舍；Job 结束后前端必须丢弃文件树与编辑器缓存并从 PVC 强制重载。
- Job 使用专用无 RBAC 的 ServiceAccount，并设置 `automountServiceAccountToken: false`；允许任意出网，仅适用于受控测试集群。
- 日志实时推送并持久化。单次运行只保留最近 5 MiB，淘汰最早内容并标记截断；界面在下次运行时切换到新运行，MySQL 中日志和运行元数据保留 7 天。
- Shell 采用交互式 PTY。断线或刷新立即关闭旧会话；Job 仍存活时可重新建立新 Shell。持久化执行者、命令、开始/结束时间和退出码，不将 Shell 输出混入 Pod 日志。

### 恢复与验收

- 后端运行中重启后，必须依据 MySQL 与带 `ownerUserId`、`projectId` 标签的 Kubernetes 资源恢复运行状态、编辑锁和日志订阅；状态恢复中保持锁定。
- POC 同时需要真实集群端到端演示与自动化测试，至少覆盖跨用户拒绝访问、路径逃逸拒绝、保存、单 Job 锁、超时/终止、日志滚动、重连、后端重启恢复和终端断线关闭。
- AI 对指定文件/日志的读取、工作区 CRUD、补丁预览与用户确认写入将在后续独立评审，不属于 POC 4 交付范围。
