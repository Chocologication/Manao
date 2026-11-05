# DependencyFaultGate 操作者工具

独立 JDK 17 工具，仅使用内置 `jdk.jdi`，不链接到产品、不修改产品 class、不引入第三方库或生产测试开关。输出为脱敏 JSONL：显式期望的 project/operation、线程 ID 和断点 class/method/line；不输出 locals、对象、请求正文、capability 或 token。

本地真实 child JVM/JDWP 自测不是集群验收。集群部署、owner pause/close、durable 对账和最终环境恢复由主会话负责。不得通过本工具创建伪造 receipt、改 DB 状态或盲目重放依赖 mutation。

## 编译与本地自测

在仓库根目录，用 JDK 17 或更高版本；产物放到仓库外临时目录。自测启动本机 JDWP 子进程并在 finally 回收，不访问集群/模型。

```powershell
$gateBuild = Join-Path $env:TEMP 'manao-dependency-gate-build'
New-Item -ItemType Directory -Force -Path $gateBuild | Out-Null
javac --add-modules jdk.jdi -g -Xlint:all -Werror -d $gateBuild `
  poc4/deploy/ai-python-environment/operators/DependencyFaultGate.java `
  poc4/deploy/ai-python-environment/operators/DependencyFaultGateSelfTest.java
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed' }
java --add-modules jdk.jdi -cp $gateBuild DependencyFaultGateSelfTest `
  poc4/deploy/ai-python-environment/operators/DependencyFaultGateSelfTest.java
if ($LASTEXITCODE -ne 0) { throw 'Self-test failed' }
```

成功输出 `SELF_TEST_PASS`。自测覆盖精确 project/operation/文件名拒绝、只停目标线程、目标暂停时外项目请求继续、resume、最大hold超时恢复且非零退出、hold内exit/interrupt、单独attach的唯一匹配线程interrupt/exit、外项目exit拒绝、未知operation从真实frame绑定，以及真实socket不返回response时中断`HttpClient.send`。fixture中的敏感locals不得出现在operator输出。

## 前置要求

- 由主会话在已核对镜像/PVC/目标身份后临时启用 `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005`。backend保留原`JAVA_TOOL_OPTIONS`所有HTTP重试保护。JDWP只经本机loopback port-forward连接，不开放公网Service。
- 用运行中jar/class的`javap -l -p`核对LineNumberTable，不能假定checkout行号等于部署class。不存在行号时工具拒绝，不猜附近位置。
- CLI必须显式`--host 127.0.0.1 --port <forwarded> --project <id>`。本工具不检查kubectl context/Pod UID/镜像digest，操作者需另行核对forward确实指向已授权目标。
- project/operation从暂停frame的白名单locals、record参数fields提取；agent从同请求栈`WorkspaceCapabilityFilter.verifier.projectId`补足project。不会调用目标getter/toString，不遍历任意对象图。无调试locals且参数也没有身份时fail-closed，选择有OperationRecord参数的安全边界。
- 同一目标JVM通常只能有一个JDWP debugger；不要在同一JVM已运行gate时再启动另一个attach。两个不同JVM可分别连接，例如agent gate与backend interrupt命令。

## 一次性门闩

示例中的305仅为源码候选位置，执行前必须核对部署class。选择没有持有backend项目gate/全局monitor的边界；不能在PENDING登记事务内长暂停。

```powershell
$gateControl = Join-Path $env:TEMP 'manao-gate-original-operation.control'
# 必须选择本轮未存在的新控制文件路径；工具拒绝预先存在的控制文件。
java --add-modules jdk.jdi -cp $gateBuild DependencyFaultGate gate `
  --host 127.0.0.1 --port 15005 `
  --project '<projectId>' --operation '<operationId>' `
  --at 'com.manao.poc4.workspace.WorkspaceOperationService:305' `
  --control $gateControl --max-hold-seconds 15 --wait-seconds 120
```

`ARMED`表示已安装断点或已注册精确ClassPrepare监听；`BOUND`表示具体class/行已绑定。只有`HIT`证明目标project/operation已命中。`--operation`可省略以捕获首次未知operation；捕获到唯一operation会写入HIT并绑定后续控制。没有可观察operation的门闩只允许resume，拒绝exit/interrupt。多个冲突project/operation时不命中。

第一文件rename场景追加 `--file pyproject.toml`，在 `PythonDependencyTransaction.applyPreparedFile` 的writeAtomic返回后的行设置断点；它从白名单name/path匹配固定受管文件，不输出任意path。只允许`pyproject.toml`或`uv.lock`。

在另一个本地终端写控制文件，UTF-8无BOM：

```powershell
[IO.File]::WriteAllText($gateControl, 'resume', [Text.UTF8Encoding]::new($false))
# 其他已授权动作：'exit' 退出当前已命中JVM；'interruptCall' 中断该已暂停请求线程后恢复。
```

每个gate只命中一次并禁用自己的门闩断点，恢复过程不会再次触发同一故障。max-hold范围1–120秒，默认20；wait范围1–600秒，默认60。hold超时安全resume、断开并非零退出。无效/过长/链接控制文件导致失败并恢复。线程暂停依赖JDI事件计数，所有事件为`SUSPEND_EVENT_THREAD`；不冻结整个VM。已排队的非目标事件会被及时resume。

## 同一连接上的只读trace

gate支持重复的`--trace-at ExactClass:line`（最多16个）和`--trace-after-seconds 0..600`（默认0）。trace与门闩共用同一个debug连接；TRACE只读取原project/operation身份并立刻resume事件线程。`--file`只筛门闩，不筛trace。第一次匹配的TRACE可从真实frame绑定尚未知的唯一operation，后续只观察该operation；操作者必须再与DB原tool row对账。

```powershell
java --add-modules jdk.jdi -cp $gateBuild DependencyFaultGate gate `
  --host 127.0.0.1 --port 15005 --project '<projectId>' `
  --at 'com.manao.poc4.workspace.PythonDependencyService:82' `
  --trace-at 'com.manao.poc4.workspace.PythonDependencyService:<verified-prepare-line>' `
  --trace-at 'com.manao.poc4.workspace.WorkspaceOperationService:<verified-commit-line>' `
  --trace-after-seconds 60 --control $gateControl --max-hold-seconds 15 --wait-seconds 120
```

以上trace行必须替换为部署class验证过的数字，不能原样执行占位符。`BOUND.kind=trace`和`TRACE`按class/method/line聚合；同一行若映射多个字节码位置/方法可能不等于一次逻辑调用，必须核对`javap`和BOUND输出，选无循环且入口唯一的行。完全重复的trace定义会去重。

HIT后trace保持启用，resume或interruptCall成功后继续指定tail时间，结束打印`TRACE_COMPLETE`。**HIT时自动绑定该线程ID，tail控制命令只重新核对这一个原线程的project/operation，不扫描其余请求线程。** tail期间可以把同一控制文件由resume改为`interruptCall`，在既有连接内中断原请求，无需第二个debugger；`exit`同理。原线程已经退出或身份不再匹配时拒绝，不能自动切换到另一个相同身份线程。只执行变化后的控制动作一次，失败即非零退出。原来的控制内容不会被tail重复执行。VM退出/重启会断开trace，不能把重启前后的计数自动当作完整区间，需重连并合并外部证据。

自测还覆盖同连接多个trace边界、外project不输出TRACE、gate恢复后相同operation再次执行仍持续TRACE且不再hold；64条相同身份阻塞peer并存时，tail只中断原HIT线程且其他peer保持运行。该回归实测本机中断约93ms，是本地样本，不是跨port-forward延迟保证。

真实回包丢失建议同时保持backend和agent各一个debug连接：backend在prepare前或返回后gate，配置至少一个trace和充足tail；backend HIT后resume，等agent receipt落盘前返回处HIT，独立对账后把backend控制文件改为interruptCall；确认原HTTP失败/live claim释放，再resume agent。两个连接属于不同JVM。不要在backend gate连接仍存在时启动standalone attach。

## 单独attach中断或退出

用于agent已经在receipt落盘后hold，而backend原请求仍阻塞于真实HTTP。backend上没有其他debugger时执行：

```powershell
java --add-modules jdk.jdi -cp $gateBuild DependencyFaultGate interruptCall `
  --host 127.0.0.1 --port 15005 --project '<projectId>' --operation '<operationId>'
```

命令短暂停各候选线程读取stack，只在唯一线程同时匹配原project和operation时中断；原有其他suspend计数不被消除。可追加`--thread-id <previouslyVerifiedJdiId>`进一步限定，但**JDI uniqueID只应在原调试连接内使用，不能假定断开重连仍稳定**；重新attach使用旧ID只会作为待验证提示，仍须真实scope复核。无匹配或多个匹配时`SCOPE_NOT_UNIQUE`、退出码5，所有自己暂停的线程恢复。不凭线程名猜测。native frame会跳过，读取上层Java业务参数。

未指定threadId的standalone命令会对全部线程的frames/locals/record fields执行串行JDWP查询；跨port-forward往返数可远大于实际业务请求数，不适合短hold内临时启动后全扫描。外部进程超时且stdout为空不能判断是否已发送中断；应保存spawnSync.error/退出状态、先对账原任务并停止重放。推荐已绑定HIT线程的同连接tail控制。

`exit`命令语法相同，只在唯一原请求匹配时退出整个目标JVM（非零97）。**project筛选保证命中正确请求，不使backend JVM退出变成只影响一个project的操作**；backend退出必须在已授权全局维护窗口。空闲VM没有身份可验证时单独exit会拒绝；不要绕过此限制。

真实丢回包步骤：agent在receipt落盘后、HTTP返回前HIT；独立核对文件after/receipt且DB仍PENDING；中断backend唯一原HTTP线程，观察实际IO_ERROR/INTERRUPTED与原live claim释放；然后resume agent；用原owner close/pause收尾原operation。这个传输类别是`INTERRUPTED`，不能记作TCP RESET。单独interrupt只证明发出中断，必须另证原请求失败和durable状态，不能将`INTERRUPTED`日志本身当作依赖恢复PASS。

## 已知限制与收尾

本工具提供一次性门闩与有界TRACE事件，不自动证明观察区间完整、不调用owner API、不自动登记任务、不自动核对DB/PVC，也不证明集群部署成功。不要从单次HIT或未覆盖完整区间的TRACE推出“恢复没有第二次解析”；该结论仍需完整入口观察、跨重启计数合并和原journal/digest对账。最大hold控制工具正常连接下的等待，调试连接/VM故障仍要由外层controller监控。

每场保存脱敏JSONL和真实durable结果；结束后恢复临时JDWP参数/单项目Pod spec，断开port-forward，精确清除本轮控制文件和编译产物。保留原journal/receipt/PVC及失败诊断。此目录的源码和自测应保留。
