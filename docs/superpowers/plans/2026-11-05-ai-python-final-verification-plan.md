# AI Python 最后一组云端验证

用户授权补齐上一轮暂缓的第 2 类验证。工作树与分支保持 ai-python-environment / codex/ai-python-environment，起点517a258。复用专用账号/项目，保留前两轮证据、PVC、原task/tool/operation；不推送Git、不合并、不清理共享资源，不重置运行库。允许本轮真实模型、必要单组件故障注入及对应修复后发布。

## Task 1: 独立重启恢复与控制

- [x] 核对当前artifact、全局任务/operation/Run、原专用项目及资源容量；场景身份先持久化。
- [x] backend、worker各一次真实执行中意外退出，观察原task/env/工具身份、独占占用、原Job/Pod、终态receipt/ACK及恢复收尾；不重放原prompt或工具mutation。backend需owner close安全终结，worker自动AI_WORKER_RESTARTED，分别记录。
- [x] 验证暂停/接管/结束、历史持久化以及同会话新task继续，必要用户修改只在确认释放后发生。两场新任务均syntax/pytest/Run通过。

## Task 2: 真实自动压缩

- [x] 从生产阈值及真实会话序列准备可复现触发；不降低contextWindow或注入虚假usage/summary。准备32份120KiB中性文件，新任务读16份自然跨阈值。
- [x] 通过真实provider产生自动compaction，保留持久化原entry/摘要及触发证据。修复前空第二摘要失败保留；66d5968后832959→34947、SDKthreshold及durableSHA对齐。
- [x] 压缩后真实任务继续使用当前可信Python环境/工具，syntax/pytest/Run反馈与revision对齐；旧文本不覆盖环境。同task及手动compact后新task均Run10、revision88；40文件SHA不变。

## Task 3: 图片与其余兼容缺口

- [x] 用新的无秘密图片实际浏览器上传和真实模型输入，核对附件身份、服务端装配、read_image及已存在会话继续；不以本地fixture或模型口头描述代替证据。最新worker全新PNG两轮完整浏览器1/1PASS；旧harness失败保留。
- [x] 逐项核对原E1–R1矩阵尚缺范围，完成与本次改动相称的真实验证；零测试/跳过/未知均保留真实状态，不冒充PASS。B2八case及实际UI七状态、最新Java两模板通过。
- [x] 对预算/清理/会话/资源合同给出本轮实证或清楚的历史来源、限制，不合并不同源码结果。自然Job600/Failed601秒、原资源缺席，pytest/源码精确恢复；完整预算耗尽未扩大承诺。

## Task 4: 结论与收尾

- [x] 对失败先调查根因，代码修复先RED后GREEN并独立审查，必要发布后重验受影响路径。66d5968空checkpoint保护15RED/281GREEN+1既有SKIP，独立47通过；worker发布后真实自动/手动/图片/Java/Python回归。
- [x] 汇总新旧全部必要矩阵并独立审查；仅全部门禁成立才授予AI_PYTHON_CLOSED_LOOP_PASS。最终E1–R1独立审查APPROVE，公开投影无thinking/源码正文。
- [x] 恢复生产参数、清理本轮临时operator/转发与可丢弃产物，保留所有必要receipt/失败证据；更新计划/导航/验收并本地提交。集群调试/自有端口/Job清理完成；本地隔离环境删除被autoapproval拒绝，保留必要报告并明确未清除，不绕过。

集群mutation串行，子agent可只读调查和独立审查。每场只改变一个变量；预检或故障结束无占用时再开始下一场。公网端口保持用户指定30081/30082，不新分配端口。
