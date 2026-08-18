# 码瑙项目技术探索建议（POC 路线图）

> 整理时间：2026-05-12
> 基于 PRD V4.0 与以下前置条件：
> - 比赛项目，非生产级，但 UX 要求中等及以上
> - 演示并发 < 20 人
> - 开发者后端最熟，前端为短板
> - 1 人全栈，时间精力充裕

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
| 服务器装单节点 K8s | **k3s**（5 分钟搞定，比 minikube 适合 Linux 服务器） |
| 中间件起一套 | docker compose：MySQL + Redis + MongoDB + RabbitMQ + MinIO |
| 本地能 kubectl 访问 | 配 kubeconfig，验证 `kubectl get nodes` |

说明：

- 对象存储用 **MinIO**，免费且 S3 兼容，比赛演示足够
- k3s 是单二进制，适合服务器；minikube 是 VM，适合本地

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
2. 用 ConfigMap 注入代码 → 挂载到 Pod
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

## 五、POC 3：代码持久化与同步策略（中高风险，PRD 设计存疑）

**为什么是风险**：PRD 写"在线时挂本地硬盘，退出登录传 OSS"——这个设计落地到 K8s 上没那么直观：

- "本地硬盘"是谁的本地？后端服务器？K8s 节点？
- Pod 怎么读到这块硬盘？hostPath？PVC？
- 多用户怎么隔离目录？
- 退出登录怎么触发上传？心跳超时？

### 目标

跑通完整流程：

```
用户登录 → 后端从 MinIO 拉代码到 /workspace/{userId}/{projectId}/
用户在 Monaco 改文件 → 实时同步到这个目录
用户点运行 → Pod 用 hostPath/PVC 挂这个目录
用户退出/超时 → 后端打包 /workspace/{userId}/ → 上传 MinIO
```

### 两种方案对比（POC 阶段建议选 A）

| 方案 | 说明 | 适合 |
|---|---|---|
| **A. hostPath** | 后端服务器和 K8s Node 是同一台机器，代码放服务器本地目录，Pod 用 hostPath 挂 | 单机演示场景（< 20 用户完全够） |
| B. PVC + ReadWriteMany | 每个用户一个 PVC，跨 Pod 共享。需要 NFS 或类似存储 | 多节点集群（演示用不上） |

### 关键验证

单机 k3s 上，hostPath 能不能让"后端容器"和"用户 Pod"共享同一个目录。

### 预估时间

1-2 天

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
- **单机集群**：k3s（不用 minikube）
- **对象存储**：MinIO（不用云 OSS，省钱且本地可控）
- **AI 模型**：DeepSeek（便宜效果好）
- **代码持久化**：hostPath 方案（单机演示场景够用）

### Pod 运行模式选择

| 模式 | 适用场景 | 本项目选择 |
|---|---|---|
| Job 一次性运行 | leetcode 风格的"提交代码看结果" | **POC 阶段用这个** |
| Deployment + PVC 长驻 | Codespaces 风格的持久工作区 | 后期可升级 |
| exec 注入 | 已有 Pod 直接塞代码执行 | 不推荐，隔离性差 |

---

## 十二、下一步

POC 0 环境准备 + POC 1 核心闭环代码骨架可以即刻开始，先把"提交代码到容器执行并返回输出"这条最小链路跑通，即可确认整个项目的技术可行性。
