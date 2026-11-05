# Python 依赖双文件本地组合验证

2026-11-04：**PASS，1 个测试，0 failures / errors / skipped**。本记录补齐 Task 4 Step 5 中此前未执行的真实双文件部分写入组合证据；其它身份、竞争、取消、原子结果记录与新任务继续的既有矩阵属于 Task 4 已审查修复的历史验证，不由这一条测试替代。

## 实际边界

入口为真实 `AgentProjectTools.invoke`，经 `AgentPythonDependencyTools`、`PythonDependencyService`、`WorkspaceOperationService`、真实 JDBC stores 和独立 disposable MySQL schema，连接真实 workspace-agent `PythonDependencyEditor` / `PythonDependencyTransaction` / `WorkspaceFileService`。测试通过 URLClassLoader 加载该模块刚编译的类；transport bridge 只转换两侧 record，不伪造文件、journal 或 receipt。

Resolver 执行镜像内 root-owned `/opt/manao-python/dependency_helper.py`，使用真实 uv 生成 `pytest==9.0.2` test 组的 TOML 和锁文件。镜像固定为 `sha256:89fce304654dd4a2cb1988c0ea89b9b4d29cfc51542e582661bf289d9f160810`，实际工具版本为 Python 3.13.15 / uv 0.11.6。fixture 为 [AgentPythonDependencyRealJournalIT.java](../../../backend/src/test/java/com/manao/poc4/ai/AgentPythonDependencyRealJournalIT.java)。

这次组合经过真实类和文件系统、Docker uv 与 MySQL；没有经过 HTTP/capability 层。Task 3 的签名 HTTP 协议验证为独立历史证据。本记录不证明真实 provider/model、worker、浏览器闭环或云部署。

## 观察到的故障与恢复

1. 真实 prepare 生成 journal，第一次 `pyproject.toml` rename 后由现有 package-private 测试构造器注入中断。断言实际 pyproject 已新、lock 仍旧、receipt 不存在、operation 为 PENDING、revision 仍为 7、task changedPaths 为空；live claim 已释放，task 因 pending receipt 保持占用。
2. 重建 workspace-agent transaction/editor/file service 与 `AgentTaskStore`，只提交原 journal；pyproject 不再 rename，旧 lock 恢复成新内容。真实 receipt 落盘后 bridge 丢失 commit 回包，断言数据库仍 PENDING / revision 7、工具成功结果未发布、task 继续占用。
3. 再重建双方；原 receipt 重放执行 0 次 rename。三次 commit 的 operation ID、request digest 均与原登记一致；manifest 字节未变。prepare 为 1 次，uv resolution 为 1 次，文件 rename 总计 `1 + 1 + 0`。project 和 task revision 恰好变为 8，两条 changedPaths 与完整成功结果持久化，pending/claims 归零。
4. 将最终源码只读挂载到同一固定镜像，真实执行 `uv sync --locked --no-dev --group test`，venv 和 cache 仅在容器 `/tmp`，实际安装 pytest 9.0.2 并执行 `python -m pytest --version`。两个源文件字节保持不变。whole-task settlement 结束为 FAILED（显式 `AI_CLOSED` 收尾），释放占用，保留成功工具结果，不再 commit、不增加 revision，无活动 Run。

本次安全标识与 hash：

| 字段 | 实测值 |
| --- | --- |
| operationId | `42310a2d-69c5-4e42-8e04-d452f9f1b590` |
| request SHA-256 | `af61956dd3791d3ab7372c67a0ea7310abc64f66a02b51181915d3aa6e5cd911` |
| 部分写入时 pyproject（新）SHA-256 | `6567c642e092672ba36a8394a45defe0ce93523997c24bf3f9fa0d9afc95f804` |
| 部分写入时 lock（旧）SHA-256 | `a96bbf8e0350626470f1f8e55b7cf8c2cf00166f25225b917954552675c399c8` |
| 最终 counters | `revision=8 prepares=1 uvResolutions=1 commits=3 renames=1+1+0 pending=0 claims=0` |

## 命令与清理

仓库根目录执行；Maven 需在 PATH，测试显式 opt-in，不属于默认 Surefire `*Test` 集合：

```powershell
mvn -q -f poc4/workspace-agent/pom.xml -DskipTests compile
mvn -f poc4/backend/pom.xml '-Dtest=AgentPythonDependencyRealJournalIT' test
```

实测 workspace-agent compile exit 0；backend `BUILD SUCCESS`，测试耗时 16.468 秒，Maven 总计 20.524 秒。测试与 Surefire XML 均为 1/0/0/0。受控中断和丢回包各有一次预期 fail-closed WARN；并非无故障运行。该 fixture 验证现有已审查生产行为，没有生产实现变更，不声称新增生产代码的 red-green 周期。

每次 Docker 调用使用 `manao-real-dependency-it-<uuid>`、专属 label 与 `--rm`，只 bind-mount 私有 scratch，不创建 Docker volume。执行后独立 inventory：该 label 容器 **0**；实际 disposable schema `manao_stage6_b442c2172f644414be6c0abf3c22ee5c` 经 `information_schema.SCHEMATA` 精确查询为 **0**。JUnit 私有目录与临时输出日志自动清理。没有清理共享 schema、平台 PVC 或其他任务资源。

本地原始日志保存在 `.superpowers/sdd/2026-11-04-ai-python-environment-implementation-plan/dependency-integration-first.log` 与 `dependency-integration-agent-compile.log`；日志不是部署或完整模型验收证据。
