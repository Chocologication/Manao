# 最后一组 AI Python 云端验证

用户在517a258交付后授权补齐此前暂缓的独立重启、自动压缩、图片与其余兼容验证。原设计E1–R1的实现、分层测试与实际部署行为证据现已闭合，独立gate审查APPROVE，授予范围限定的 **AI_PYTHON_CLOSED_LOOP_PASS**。下文和[结构化证据](final-verification-20261105.json)保留所有失败尝试、分组件release tuple及证据限制；不将旧脚本改写成一次全绿，不授予完整平台压力/故障或全预算耗尽保证。

## 独立重启和接管

在真实Python pytest写入临时marker并sleep时，精确终止单个平台Pod，由Deployment按同镜像重建，记录旧/新Pod UID、containerID及原build Job/Pod UID。未提交第二build或重放原prompt。首个容器内kill信号未终止PID1，记FAILED_INJECTION；其task4e3ed611正常完成，未冒充重启通过。

backend实际原task b9214e6e-39d4-4e8b-b2b6-c22790f11c9c在服务恢复后保持原占用/环境/期限，观察240秒未自然退出，随后owner close按原身份安全终结；同会话新task c0c0f25d-888c-4d26-9a55-2cb2240e596e读到接管后保存的新note，完成syntax/pytest及console Run/日志。该结果证明显式恢复收尾，不承诺backend重启后原任务自动完成。

worker原task d0124a5a-78ea-474e-a16a-3cba0d7cdb37在真实实例替换后自动FAILED/AI_WORKER_RESTARTED，确认原Job/Pod不存在且占用释放；接管保存后，同会话新task51d17937-b574-4487-8d85-908062b3de6b完成同样闭环。两场各一个原build Job，原任务env摘要/worker绑定/期限不变；新任务获取当前环境和新预算，数据库秒级期限差1799符合1800秒减微秒截断。

## 真实自动压缩及发现的修复

首轮真实task2ec3193c-3ca8-4ec5-8cec-98a3d474232d读取合成hex文件，原生SDK threshold事件831538→34838，首摘要SHA与durable seq31一致。但第二checkpoint(summary长度0，output933全部reasoning933)仍被SDK接受，原目标被投影排除。任务虽COMPLETED，实际只有23份数据读取、0build并要求用户重述目标，本轮将其记为目标验收FAILED。新明确请求1b805541完成验证/Run10不抹去原失败。

根因：Pi SDK1.2对正常stop但无可见text的summary不拒绝，平台亦缺语义防线。修复66d5968仅在既有summary stream.result后、SDK appendCompaction前检查trim后的可见文本，拒绝空、空白、thinking-only；error/length/abort保留原合同，普通请求不变。不更改阈值/usage/summary，不加自动model重试，不改数据库或SDK依赖。

新增15个真实SDK scripted-provider回归有效RED→GREEN，涵盖首次、已有good checkpoint后再次为空、任务前/SDK自动/任务后/空闲手动及恢复；worker全量281PASS、1既有opt-in SKIPPED，build通过。独立复审另跑47项及build通过，批准发布。

实际只更新worker：source66d5968bb2de6ba463268b0fae8b1be2b62d6cd8，OCI index sha256:9c95045718578469cc0852515aa1a57be58af130bdb22585edbc911cc49e2b2b，linux/amd64与Pod imageID均sha256:3da11752e6d70f64737fe27bb8057230eeb01259531b1ceb9f1b353ad4da8cf3；backend/agent/runner保持55f2067、UI保持f58581a，按配套release tuple记录，不声称五项同一source SHA重建。

新会话task6efe020e-e72f-4cb1-a580-c85ef2103af5复用未变中性文件，读取16份以自然跨一次生产阈值；没有降低786432阈值或伪造usage。Inspector只读观察reason=threshold，tokensBefore832959→estimated34947，摘要SHA03eff436…与durable seq33相同；未调用手动compact API。随后同一task完成当前Python compile/test与真实console Run/exit0/独立输出10，revision88对齐。观察器的project/task参数仅标签，身份另由唯一活动task、backend source_task_id/writer_id及摘要SHA核对；不把标签冒充已证明权限。

## 新图片真实模型回归

第一次新PNG真实上传、两个模型任务都完成识别；原harness误要求显式目录tool调用而FAILED。真实模型已由自动catalog获得ID，只调用read_image(attachmentId)；修正纯合同测试后只读续验原任务，保留原FAILED，未重新PUT或提交模型。只读初稿又误拦正常日志票据POST，修正为仅允许原project/run的空body log-ticket元数据写后1/1PASS；这些不是源码/任务/附件重放。

在最新66d5968 worker上再生成全新900×600/11152bytes PNG（sha189f926d29dcf56cb4bcb5da7c1aa52fcb24f31737f45e0939517f46e833274a，文件名/prompt不含随机答案），真实浏览器1PUT+两task完整流程1/1PASS，26.5秒。核对随机首问字符/颜色形状、刷新后的原图900×600预览、原SHA/字节/24h期限/绑定不变、同会话read_image真ledger和第二问回答；目录显式调用为可选，reference必需。首task thinking可能包含第二问答案，因此不声称第二回答排他来自再次读取；新随机首问识图及真实附件重读行为分别成立。没有抓取原provider正文/base64/密钥；实际附件DB/PVC与native metadata另行核对。

## B2部署负面验证

八项实际输入均按合同返回真实非PASS状态。仅使用原专用console-first-attempt项目57bf9834-3c2b-407f-be1e-d6e5409d0145，私有归档原四文件再隔离测试。每case持久化新task/call身份，只调用一次build，禁止模型修复负面输入。报告损坏只通过该Job测试进程atexit修改自己的/tmp/manao-python-tests.xml，不改产品runner或数据库结果。

| 输入 | Task | 实际工具结果 |
| --- | --- | --- |
| 语法错误 | 471b0330-0ff9-4b84-af2b-86179d24ecce | syntax FAILED、真实错误路径 |
| 零测试 | c3326a6e-f9fc-42b5-bddd-7d8b821f606b | NO_TESTS、exit5、testSummary=null |
| 全部跳过 | 47ccbbe9-c940-41b5-b54b-e5400f798182 | SKIPPED，实际tests/skipped相同 |
| 无效XML | d79e0fb5-8c51-4e49-a6a6-db0918704717 | pytest进程exit0但UNKNOWN，不伪称PASS |
| 报告缺失 | 1c1d5a77-c9b2-43ae-8634-85b477c7fccf | UNKNOWN、missing marker |
| 报告截断 | 45a8a0ce-2e63-44bf-9ace-7397219a0f1a | UNKNOWN、truncated/65536 bytes |
| 缺pytest | 9688798d-67d0-4d0c-8081-4f12a86c28b8 | UNKNOWN、exit1及PYTEST_DEPENDENCY_MISSING |
| 自然构建超时 | c92b0ad3-6844-4eaf-9fd6-dc60752c79fb | UNKNOWN/null exit/BUILD_CLOSED，原Job独立证据DeadlineExceeded601秒 |

timeout原Job UID9c3a7977-8ddd-449a-b371-e29afc17d7f5，activeDeadlineSeconds600；watch捕获Failed/DeadlineExceeded，08:45:50→08:55:51共601秒。未提前pause/close、未缩短task1800秒预算；原Job/Pod消失，cleanupConfirmed=true。工具返回保守UNKNOWN，单靠该结果的原harness assessment=false继续保留；最终自然timeout由相同UID/spec/condition和资源联合oracle证明，不能把UNKNOWN单独当通过。

pytest以原受控工具remove/add往返，原声明和9.2.0锁版本一致，只有托管两文件changedPaths。操作者TOML比较器全局尾逗号误拒曾停在已COMMITTED原操作，换stdlib tomllib深比较并只读observe核对后通过，没有第二次remove。四个归档源/依赖文件最终全部原SHA恢复，临时case文件通过正常owner API删除。七种快速负面结果另经真实浏览器逐项点击结果，1/1PASS（6.2秒）：未发现测试/全部跳过/证据不完整/语法FAILED，均不显示为测试PASS。

操作者合同经独立审查关闭未决INTENT、managed恢复语义和历史分页问题；最终8项本地行为回归通过，不冒充云端结果。公网登录或GET有过连接reset：只在确认领域请求未发/原ID未登记后继续，领域mutation没有自动重放。手动compact准备曾因漏requestId/head返回422，查询确认未登记后补齐新原身份，非已执行请求重试。

## 当前版本兼容与最终收尾

最新worker手动compact请求48d795c8-ff77-40a1-812d-0baa874e58e1 COMPLETED，同会话新task769fca9b-e37a-419b-8f8f-5807661ca96b继续syntax/pytest/Run10。40个source/fixture前后SHA一致、revision88不变：8个原文件的before来自上一轮rollback snapshot，32份中性数据的before来自本轮prepare GET；不声称它们是同一时刻采样。

最新worker还实际执行Java console0d647d05-e4c7-491b-ac4e-e0cb7af4ebc2及Spring Boot149f620a-13c9-4797-89a6-820736b5c5ee：compile/test/package均exit0/cleanup，console真实输出、Spring READY/日志/业务GET及公网30082均通过，Spring辅助Run已正式stop。

撤除Inspector时操作者Runtime.evaluate中的dynamic import缺少VM callback，引发未处理错误使空闲worker exit1。该操作失误单列，非OOM、无活动task；原自动/图片/负面任务RECORDED回执日志已确认。新container同镜像就绪后Java两模板、缺pytest/恢复、自然timeout及手动compact继续均通过。不是产品自动重启样本的替代。Inspector端口已关闭、自有19229转发已停止；未动共享6443连接。

最终快照三平台均1/1 Ready，占用task/PENDING operation/RUNNING compact/development Job及Pod均0，V20仍唯一成功且checksum1710106007，12个PVC保留，项目/PVC删除数0。FastAPI验证Run3227317f-9dff-47bf-8a53-820968e2b5f4以revision38重新就绪并保留，公网30081/api/demo返回200/total=2,000；首次公网GET reset后只重读，没有再start。原日志/receipt/失败任务均保留。

公开JSON已去除26条thinking正文、源码全文与长模型叙述，使用SHA/字节/计数及必要业务结果投影；原始凭据/备份/完整数据仅留仓库外。预算合同由既有本地真实SDK/后端回归与本轮期限不变/资源收尾支撑；没有耗尽180tools/20build/1800秒全预算，不新增这些承诺。原空checkpoint历史任务仍为失败样本，没有迁移修复其历史。独立审查E1–R1、公开投影、timeout联合oracle、恢复和最终tuple/inventory均APPROVE。

本地操作者隔离环境negative-local-env的删除被自动审批拒绝（仅返回blocked by policy），未绕过，保留并记录；必要SDD报告按SHA归档到仓库外。集群临时observer/调试入口/自有转发及build资源已清理，不能把本地残留描述为已删除。Git保持当前工作树分支，不push、不合并master，主目录无关修改保留。
