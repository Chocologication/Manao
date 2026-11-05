# Manao TypeScript Web 服务

运行环境：Node.js 24 LTS、pnpm 10。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm start
```

默认监听 3000 端口，平台通过 MANAO_PRIMARY_PORT 指定实际端口。GET / 返回示例响应，GET /health/ready 检查服务及所选 MySQL / Redis 的连接。公网端口由创建项目时配置，范围 30000–31000。

AI 支持读取和修改 src、package.json、pnpm-lock.yaml 与 tsconfig.json；构建、测试和打包在隔离副本中执行。
