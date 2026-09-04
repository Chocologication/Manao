# 码瑙 PRD v4.0 图表稿

本文根据 `Manao_PRD_V4-0.md` 整理，包含产品闭环流程图、系统分层架构图和运行任务时序图。

## 1. 产品闭环流程图

MCP 渲染预览：
https://mermaid.ink/svg/pako:eNpVkstu2kAYhfd9itGs0gXKG1RKQi5AElVqpS6sLEpCValVkVKqLqpKdmnAONwSwIFyi4MI7gUTqUoKtokfBv8z41VfoWLGrdTNt5hzzvxHM_-L1-n3hy-fH2fQ0-gDhBBaW5EwrZtE_UUKNXBlclthIxVaJj54yA3rEiY_TcgV0SqiLQfmDXzAhQ0JB3KBnH4lpkG6HlF1UNvg2IExo20rNEUlDGouOCn59hn9PmFelRlFWp7AVTZ0bEoYOia1Perq7P7Mdwb0Ugm1LQnTTzPIOyIXnm5L2Hcc0Ax2kwX7mnRKoBlkIJP-MDgpBVfdhayITgtZCRodyFbC5I6EE--SqeM3qUzqLRJ10eP0EVpF8XQyNMUkDNYMWiYpjJhRFIVgdsfua5C3ycUQvIvQGpfws1TySfrwVSqDmFeHdo9qd0RWlg24cSEr7PYzsatQuqR1M8wlJLwWQ9TVSflc1GcTByq6mPUvDOfF8MGcGul1wvAuD4s2bDQI8toyoA2DegvUHOlVF7Liu00o6uDYzPr7E3sfMGlOoHpNnRF1xr5nkfrst9vHH7m8vyJh3-vCuClGMusG5g1_WvbdL2zS9aeaPz0len65FmJxUCTyCK1zbnBGOTc5tzi3OXc4Y5xxzgTnLueeaIciEYRFNeaNfWeAxW3_qTXS7ZPODza3wOoF34rCs_8Hd7tm_A

```mermaid
flowchart TD
    A(["用户打开浏览器"])
    B["注册 / 登录"]
    C["选择模板或创建项目"]
    D["分配云端运行环境"]
    E["在线编辑代码"]
    F["点击运行"]
    G["任务调度服务检查配额、模板、镜像"]
    H["Kubernetes 创建 Pod / Job"]
    I["容器执行代码并输出日志"]
    J["WebSocket 返回状态、日志、资源占用"]
    K["AI 编排服务读取代码、日志和运行结果"]
    L["AI 输出解释、报错分析、优化建议"]
    M{"是否继续修改？"}
    N(["保存运行记录与会话上下文"])

    A --> B --> C --> D --> E --> F --> G --> H --> I --> J --> K --> L --> M
    M -- "继续迭代" --> E
    M -- "结束本轮实验" --> N
```

## 2. 系统分层架构图

MCP 渲染预览：
https://mermaid.ink/svg/pako:eNqFVV1T2lgYvs-vOJMrd5wOs5_j1c7o6nRRWVF0vQi9CHAqrJI4Ieh45xeuUuRjrVZFtsZqcccqOq2WAi5_JuckXO1f2DnnBEwkbbkgyfs-583zfj15PicvhqOiooLJAQ4AAKYE3nh5jjc_Ag9AxZPW_mvgAcaVZuQ3UGGff8ZRVCIZmlHE-SgY_VbgjXfv9Ooyuln9r3HIzuLsGUqdoZtV_hmFk9-AIi8moCLw0zAE8G3OLG-ig3MboD-pRockVVkSePz-HG1kjIM6ut8lgXJvLByUIo8JfMcI1DKMANraNi4q6GbXOK05CUzLymwISuGowKPGMsoV0Mcz_f4I5a6Dkk-WxLAMhiIxVVZAL8B7f-r1O3xcsPPz-kUJzgl8vxeg9D9460WrdIJLTRtkIilZGLOZN7UMzpbR5h3wAPzqDDVfAQ8wb9dxLY9yFbO8gTJ79vCReEya8go8qzorOWlCPoty1-yxpd1-vhDfW53YsjpxX0Cp93o129r6gEtrzlo8FVW4KC4JfL_f236wuYenJwV-eHoSsLP2DEUVjsbiMVXgWwd5fLtCGF5p5pVGbhqrqFpFp-tGfuPzPH-gPFGxyHjq1UOU1vDRNkprTpJTCagEFsLtgdSrWVxaI2-lWBvQr8h_wLBKsS3tk1G8IljWwsfYfi-F9XuB0djD2b-6AJNiYpZC9HodpTXzeg3V3nahhhbEOYoyK-v49kWXf1SeoW7WeL2aNYoFnC134XwzccbbWjHabAfKpYI_WiP_klUQ717jbZKy0dhBl_vOIvqWAuOjQg9Pr0Gps9uslMADWMGI5VzDpSaxpLZbJyX-G1sQWZqRSRByHRwISmQFKp_MSol0vXlhpMqdIceFffMtGYvhwNhvJJZxf2WPNQEjsYTQw9NrUNIbhyxMa_812iQr0pkr1gAjfYeXVxxsxslxMRSKqb7xoIQaq_jyjC1chwUbQuABhGk-a82kLchYICD08CSJG40UbfU8KOn1N8bxCsqkyKLSeEZ9B_99RLhU03rjmGzv3kE7jEtnfmKznbq0ZrtWMC4qeKtsahlnWybgTCxBta61e4TWcnp9B9V2bICRvoDAjyRDUJGgChOgVdww_j21D70cEXi_HCGVlkPAAwbh_Jy8FIeSCnqB__dfeEf_iLAJvA-qSiycAAGoLEAidH5FjkM1CpMJ0AueKuJzURIdYzwbE3jyb9XVXDlE-U0bYhAujM0nBP5XOBcHvWAYSrMxKUHpEIc9o2QIBuajUIEsMXYPOlpoNvNG_cPjqZ8CT5783P540PvOd4I-dVSdc2g8QzLFdvG0hdrtENNhF4-lk5ztY9BlbwfuPsDCdtmte2onikvZtUWWc0gu9Vmi6OJ5UEEXJ5U9F7uldi4eS-FcPEzbXByWmFmNY0SZg4gP55TqrziI0rg5xgIBrqPjj6APNiounE3Ov2D1jXM2RX8UkuVqpT0b42yabUugK-ZIH2M50hew3szW3WH0yxHO2mRHau3nzgvbB6w15h72zvmyh6Wym61T3XNP1_qhof8DCH_T3w

```mermaid
flowchart TB
    U["用户 / 团队 / 管理员"]

    subgraph L1["第一层：用户接入层"]
        Browser["Web 浏览器"]
        AuthEntry["注册登录入口"]
    end

    subgraph L2["第二层：前端展示层"]
        Workbench["开发工作台\nMonaco Editor + 文件树"]
        AIPanel["AI 助手面板"]
        RunPanel["运行控制 / 日志 / 资源可视化"]
        AdminUI["团队管理 / 后台管理页"]
    end

    subgraph L3["第三层：网关与鉴权层"]
        Gateway["API Gateway"]
        JWT["JWT 鉴权"]
        RateLimit["限流 / 审计 / 异常处理"]
    end

    subgraph L4["第四层：业务服务层"]
        UserSvc["用户与权限服务"]
        ProjectSvc["项目与文件服务"]
        AISvc["AI 编排服务"]
        TaskSvc["任务调度服务"]
        EvalSvc["评测服务"]
        LogSvc["日志与监控服务"]
        MgmtSvc["管理后台服务"]
    end

    subgraph L5["第五层：数据与缓存层"]
        MySQL[("MySQL\n用户 / 权限 / 项目 / 模板 / 配额")]
        Mongo[("MongoDB\nAI 对话 / 快照 / 日志摘要 / JSON 配置")]
        Redis[("Redis\n会话 / 队列 / 限流 / 任务状态")]
        MQ[("RabbitMQ\n异步运行 / 日志处理 / AI 后处理")]
        OSS[("对象存储\n代码包 / 运行结果 / 上传资料")]
    end

    subgraph L6["第六层：云端执行层"]
        Registry["镜像仓库"]
        K8S["Kubernetes 集群"]
        Pod["Pod / Job / Deployment + PVC"]
        Monitor["Metrics Server + Prometheus + Grafana"]
        Loki["Loki 日志聚合"]
        DevOps["Helm + Jenkins / DevOps"]
        KubeSphere["KubeSphere 可视化运维"]
    end

    U --> Browser --> AuthEntry --> Workbench
    Workbench --> AIPanel
    Workbench --> RunPanel
    Workbench --> AdminUI
    Workbench --> Gateway
    AIPanel --> Gateway
    RunPanel --> Gateway
    AdminUI --> Gateway
    Gateway --> JWT --> RateLimit
    RateLimit --> UserSvc
    RateLimit --> ProjectSvc
    RateLimit --> AISvc
    RateLimit --> TaskSvc
    RateLimit --> EvalSvc
    RateLimit --> LogSvc
    RateLimit --> MgmtSvc

    UserSvc --> MySQL
    ProjectSvc --> MySQL
    ProjectSvc --> Mongo
    ProjectSvc --> OSS
    AISvc --> Mongo
    AISvc --> Redis
    TaskSvc --> Redis
    TaskSvc --> MQ
    EvalSvc --> Mongo
    LogSvc --> Loki
    MgmtSvc --> MySQL

    TaskSvc --> K8S
    K8S --> Registry
    K8S --> Pod
    Pod --> OSS
    Pod --> Loki
    K8S --> Monitor
    DevOps --> K8S
    KubeSphere --> K8S
    Monitor --> RunPanel
    Loki --> LogSvc
```

## 3. 运行任务时序图

MCP 渲染预览：
https://mermaid.ink/svg/pako:eNp1k9tOGlEUhu_7FPsFJt6auZiERiUUTWmw4XrACSVGxsKQpnczUuXgcBRRyqFQRegJbVIRQcrDMGsP8xbN3ptTSryaTPa31r_2_68dlt5HpKBP2giI_pB48AIhhMSIIgcjB14pxH59ihxCb8NSCIlhZBbaOP5ADw7FkBLwBQ7FoIK2NskhJFLmj1t4aBrDCmTuVii7h1A2lwPZRUX6IH5cIWwR5R1hrMQfXI0avbRVyuJ7bYXbFcP7hDMGA0g2JndR6N_gSgqSjRX0TURWRNrzOGV9rRq9NG43cHX0DO5cdxPYGfFKoaCkSHTeFcol7xGKfNbQK9m7AmzLfgLgiyaMLoxe2izncLr1jKZbkUMSwXfkoF_eeInW0E4g6Hi9ao-DGuhA5lMRp_PTdhQjAXGCsLXJI_PoEWKDySg7aej0bGuTEwS7h0c4kzX611bj0Sx3HBtjVcPFmDHomok4rvwcqxqrYf7QSruHEwQSCo9wvWF919Erzy6pq0atUhby-lI-BONmQhS21M-TUWzRiKTGI4iXYdBnUiw_SpBDThBoXDzCVyr-0mTbxoIjqnSwsapZ5xWIZiCvQ_YWkm3IDY3BNe1Cy7m51mRUgHINMrdMzjpOmcPOspxz3T2biKaJ48V5ns51NycILnmPR_g0AZniVPaxi_WjyXBoDK7MukaWdNHWJe8R9W3ZzyPo1PBFd_L3DGJ9NqiZ7GJVg7w-NZpuB63blv3cND6P5HXLvn1JQTjdtlSNUWNVY9UkpvtPuJ-FVN0stOeqgkDXiEdwUoLjJlMwB2e4VhnPmuDc5eSGdDD6LTPxjaW_PDe1g5lmqSrE-madjIsTLdKM6s-tWQRarhlP9cVjQEvg1ObpaMaoCr8up4-2cwfD82XI5uARZHKWqjFnx0t3X55m-WpGL2n0TnGRbZnNMTOR3QEnm1ahBPETXMsS31pXViwJed14ugS9SLaw05m9EE4QyBviEfw-N6_7_zkHeZ28O1byD29MhqA

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant FE as 前端工作台
    participant GW as API Gateway
    participant Auth as 鉴权与限流
    participant Task as 任务调度服务
    participant Quota as 配额与模板服务
    participant K8S as Kubernetes API
    participant Pod as Pod / Job
    participant Log as 日志与监控服务
    participant Store as MongoDB / MinIO
    participant AI as AI 编排服务

    User->>FE: 点击运行
    FE->>GW: 提交项目ID、文件版本、运行模板
    GW->>Auth: 校验 JWT、权限和限流
    Auth-->>GW: 校验通过
    GW->>Task: 创建运行任务
    Task->>Quota: 检查用户配额、模板、镜像和启动命令
    Quota-->>Task: 返回可运行配置
    Task->>K8S: 创建 Pod 或 Job
    K8S->>Pod: 拉取镜像并挂载代码与配置
    Pod-->>Log: 实时输出启动状态和运行日志
    Log-->>FE: WebSocket 推送日志、状态、资源占用
    Pod->>Store: 写入运行结果、日志摘要、产物文件
    Pod-->>K8S: 返回退出码和执行状态
    K8S-->>Task: 回传 Pod / Job 状态
    Task->>Store: 保存任务记录
    Task->>AI: 发送代码、日志、退出码和运行结果上下文
    AI-->>FE: 返回报错分析、解释和优化建议
    FE-->>User: 展示结果、日志和 AI 建议
```
