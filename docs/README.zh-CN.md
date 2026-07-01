# pi-client 一键安装和启动

本目录提供从 `git clone` 到全局安装并启动 `pi-client` 的脚本。

## 一键启动

```bash
chmod +x docs/pi-client-one-click.sh
PI_SERVER_AUTH_TOKEN="你的 token" ./docs/pi-client-one-click.sh
```

默认配置：

- 仓库：`https://github.com/Averyyy/pi-client.git`
- 安装目录：`~/pi-client`
- Node：`22.19.0`
- pi-server：`https://pi.yreva.asia`
- 单次 client 到 server 请求上限：`PI_CLIENT_MAX_REQUEST_KB=512`

脚本不会保存 auth token。每次运行时通过环境变量传入：

```bash
PI_SERVER_AUTH_TOKEN="你的 token" ./docs/pi-client-one-click.sh -p "Say exactly: ok"
```

## 可选环境变量

```bash
PI_CLIENT_REPO_URL="https://github.com/Averyyy/pi-client.git"
PI_CLIENT_REPO_DIR="$HOME/pi-client"
PI_CLIENT_NODE_VERSION="22.19.0"
PI_SERVER_URL="https://pi.yreva.asia"
PI_SERVER_AUTH_TOKEN="你的 token"
PI_CLIENT_MAX_REQUEST_KB=512
```

## 脚本实际执行的步骤

1. 加载 `~/.nvm/nvm.sh`。
2. 安装并切换到 Node `22.19.0`。
3. 如果目标目录不存在，执行 `git clone`。
4. 如果目标目录已存在，执行 `git pull --ff-only`。
5. 执行 `npm install --ignore-scripts`。
6. 执行 `npm run build`。
7. 执行 `npm run install:pi-client`，全局安装 `pi-client`。
8. 设置 `PI_SERVER_URL`、`PI_SERVER_AUTH_TOKEN`、`PI_CLIENT_MAX_REQUEST_KB`。
9. 执行 `pi-client "$@"`。

需要先完整构建 workspace，再安装 `pi-client`。只运行 `npm run install:pi-client` 会缺少本地 workspace 依赖的 `dist` 产物，例如 `@earendil-works/pi-ai/dist/index.js`。

## 本次验证记录

验证目录：`./document/pi-client-smoke`

验证命令：

```bash
source "$HOME/.nvm/nvm.sh"
nvm install 22.19.0
nvm use 22.19.0
mkdir -p document
cd document
git clone https://github.com/Averyyy/pi-client.git pi-client-smoke
cd pi-client-smoke
npm install --ignore-scripts
npm run build
npm run install:pi-client
PI_SERVER_URL="https://pi.yreva.asia" PI_SERVER_AUTH_TOKEN="***" PI_CLIENT_MAX_REQUEST_KB=512 pi-client -p "Reply exactly: pi-client-smoke-ok"
```

结果：

- `git clone` 成功。
- `npm install --ignore-scripts` 成功。
- `npm run build` 成功。
- `npm run install:pi-client` 成功。
- `pi-client` 成功启动并连接到远端 `pi-server`。
- 远端请求进入上游 provider 后返回 `401 Insufficient balance`，说明 client 到 server 的 URL/token 链路可达；当前阻塞点是 provider 账户余额或模型侧配置，不是 `pi-client` 全局安装失败。

## 常见问题

### 找不到 `nvm`

脚本要求本机存在：

```bash
~/.nvm/nvm.sh
```

如果没有安装 `nvm`，先安装 `nvm` 后再运行脚本。

### `PI_SERVER_AUTH_TOKEN is required`

脚本不会硬编码 token。运行时显式传入：

```bash
PI_SERVER_AUTH_TOKEN="你的 token" ./docs/pi-client-one-click.sh
```

### 上游 provider 返回 `401 Insufficient balance`

这说明 `pi-client -> pi-server` 已经连通，但真正转发到 LLM provider 时被 provider 拒绝。需要检查 client 侧 `~/.pi/agent/models.json`、auth 配置、模型选择和 provider 账户余额。
