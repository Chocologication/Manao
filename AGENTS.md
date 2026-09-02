# SSH Access

- Master node:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\root.pem' root@1.12.245.235
  ```

- Node 1:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\root.pem' root@193.112.179.183
  ```

- Node 2:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\root.pem' root@139.199.194.55
  ```

An SSH tunnel has already been established locally through Xshell, so `kubectl` commands can be used directly.

# Database Access

## Please prefer to use the MySQL mcp tool to access the database.

## The following information is for necessary use only.

- MYSQL_HOST: `127.0.0.1`
- MYSQL_PORT: `3306`
- Username: `root`
- Password: `HAOhao2006.`

# Stage 6 (6A) 基础设施状态 (2026-09-02 实测)

## 集群拓扑与访问

- 3 节点 K8s v1.31.13，运行时 **containerd 1.7.13**（非 docker），OS CentOS 8，内网互连 172.16.0.x。
- 本机经 Xshell SSH 隧道访问 API（127.0.0.1:6443），kubectl 直接用。
- SSH 到节点用 root.pem（learn.pem 已失效）；节点上 /usr/local/bin 有 docker/ctr/crictl。
- master 上 docker daemon 25.0.5；其 /etc/docker/daemon.json 曾损坏（非法 JSON）已修复，备份为 daemon.json.bak.*；已配腾讯云 registry-mirror。

## 私有镜像仓库（master，registry:2.8.3）

- 容器名 manao-registry，监听 0.0.0.0:5000，--restart=unless-stopped。
- 访问方式：
  - master 本机：127.0.0.1:5000（docker pull 直接可用）
  - 本机（Windows）push：先起 ssh 隧道
    ```powershell
    ssh -i (Join-Path $env:USERPROFILE '.ssh\root.pem') -N -L 0.0.0.0:5000:127.0.0.1:5000 root@1.12.245.235
    ```
    然后 docker tag/push 用 **172.26.160.1:5000**（WSL 网关；已加入本机 docker insecure-registries）
- ⚠️ 无数据卷：docker rm manao-registry 会丢失全部镜像，需重新推送。
- 无认证：云安全组勿放行 5000，仅经隧道访问。
- 已实测链路：hello-world digest sha256:d1a8d0a4eeb63aff09f5f34d4d80505e0ba81905f36158cc3970d8e07179e59e（本机 push → master pull+run 通过）。

## 本机 Docker Desktop（Windows）

- 安装路径：D:\Docker\DockerDesktop\frontend\Docker Desktop.exe（非默认 Program Files）。
- dockerd 运行在 WSL2 VM 内：VM 的 127.0.0.1 是 VM 自身，访问宿主用 172.26.160.1（WSL 网关）或 host.docker.internal。
- Desktop 内置 HTTP 代理 http.docker.internal:3128 会拦 localhost 流量；docker push localhost 直连不可用。
- daemon 自定义配置：C:\Users\shili\.docker\daemon.json（insecure-registries: 172.26.160.1:5000、host.docker.internal:5000）。
- 本机 docker 未登录 Docker Hub（匿名拉取可用）；集群节点可出网拉 Docker Hub（已实测 registry:2）。

## 6A 受限 kubeconfig

- 文件：D:\DeepLearning\MyProjects\Project_Manao_kubeconfig\stage6-6a-kubeconfig（仓库外，勿提交）。
- 身份 manao-6a-local（SA，token 24h 过期）；namespace manao-stage6-test；Role manao-stage6-backend（26 项 can-i 全 yes，含 pods/portforward；无 secrets/nodes/pv）。
- token 过期重签：
  ```powershell
  kubectl -n manao-stage6-test create token manao-6a-local --duration=24h
  ```
  然后替换文件 users[0].user.token 字段。
- 结构要点：server https://127.0.0.1:6443 + tls-server-name: localhost + 真实 CA（无 insecure-skip-tls-verify）。

## 脚本经验与坑

- 在脚本模板字符串里写 Windows 路径，反斜杠会被转义吞掉（\l → l、\D → D）：用 Join-Path 分段拼接或写双反斜杠。
- ssh 批量改远程文件：本地 base64 编码后 `echo <b64> | base64 -d > /path`，避免引号/heredoc 转义地狱。
- 隧道连通性验证：Test-NetConnection 127.0.0.1 -Port <port>；registry 探活用 curl http://127.0.0.1:5000/v2/（返回 200）。

## Docker Hub 方案（2026-09-02 实测结论）

- Docker Hub 账号：chocologic；测试仓库：chocologic/manao_images_repository（公开，匿名可读）。
- 本机 docker 凭据存 wincred（docker-credential-wincred），docker login 后 config.json 无明文 auths。
- 链路验证：本机 push → Docker Hub ✓（hello-world digest sha256:d1a8d0a4...，与自建 registry 中同 digest，内容寻址一致）；master 节点 crictl pull + 运行 ✓。
- ⚠️ 节点直连 registry-1.docker.io **时通时断**（ctr 拉取 29.9s i/o timeout，crictl 同镜像成功）——中国服务器直连 Docker Hub 不稳定。
- 本机 docker push 到 Docker Hub 时 Desktop 代理可能报若干 "Unavailable" 后重试成功（层级幂等，无需处理）。

## CRI 腾讯云加速配置检查（2026-09-02，三台节点）

- 三台（master/node1/node2）containerd 1.7.13 均配置 docker.io mirror：config.toml 的 [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"] endpoint = ["https://mirror.ccs.tencentyun.com"]（旧式 config.toml 配置，无 certs.d/hosts.toml）——配置存在且一致，**正常**。
- mirror 端点探活：https://mirror.ccs.tencentyun.com/v2/ 返回 200，延迟 25-40ms。
- kubelet/crictl（CRI 路径）拉 docker.io 走腾讯 mirror 可用：registry:2.8 探针 5.2s 拉取成功；chocologic 个人仓库镜像 crictl 可拉。
- ⚠️ **ctr CLI 直连 registry-1.docker.io 持续超时**（0 B/s，29.9s+）——ctr 不读 CRI 插件的 mirror 配置，只走直连。测试/排查镜像拉取必须用 crictl（或 kubectl Pod），不要用 ctr images pull docker.io。
- ⚠️ 节点 containerd 缓存了大量常见镜像（busybox/nginx/hello-world/alpine 等，KubeKey/POC 遗留）：crictl pull 常见镜像会显示 "Image is up to date" 测不出网络；测真实拉取需用内容全新镜像（digest 唯一）。
- master config.toml 有 KubeKey 占位残留：registry.configs."dockerhub.kubekey.local".auth（username=xxx / password=REPLACE_WITH_REGISTRY_PASSWORD，只指向不存在的 host，不影响 docker.io）；node1/node2 无此段。


