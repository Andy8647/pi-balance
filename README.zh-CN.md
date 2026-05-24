<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/pi--balance-⚖️-6C5CE7?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cGF0aCBkPSJNMjAgM0wxIDM3aDM4eiIgZmlsbD0iIzZDQ0NFNyIvPjx0ZXh0IHg9IjIwIiB5PSIyNSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1zaXplPSIxNCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiMxRTFDMkIiPuKZrzwvdGV4dD48L3N2Zz4=">
    <img src="https://img.shields.io/badge/pi--balance-⚖️-6C5CE7?style=for-the-badge" alt="pi-balance" height="48">
  </picture>
</p>

<p align="center">
  <strong>pi 编码助手的 AI 提供商余额实时显示扩展</strong>
  <br>
  <sub>在 pi 状态栏中一键查看你的 API 额度余额</sub>
</p>

<p align="center">
  <a href="#-功能特性"><img src="https://img.shields.io/badge/功能特性-📋-6C5CE7?style=flat-square"></a>
  <a href="#-安装"><img src="https://img.shields.io/badge/安装-📦-00B894?style=flat-square"></a>
  <a href="#-支持的提供商"><img src="https://img.shields.io/badge/支持的提供商-🔌-FD79A8?style=flat-square"></a>
  <a href="#-使用"><img src="https://img.shields.io/badge/使用-🚀-0984E3?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pi-balance"><img src="https://img.shields.io/npm/v/pi-balance?style=flat-square&color=CB3837"></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/🇬🇧_English-6C5CE7?style=flat-square"></a>
</p>

<p align="center">
  <img src="https://img.dog/file/1779542581467_mzRI9XShNB2pFCVDlx1f8.webp" alt="pi-balance 预览" width="600">
</p>

---

## 📋 功能特性

pi-balance 是 [pi 编码代理](https://github.com/earendil-works/pi-coding-agent) 的一款**扩展**，能够自动获取并在 pi **状态栏**中实时显示你的 AI 提供商 API 额度余额或 usage 限额。

- ✅ **自动识别**当前使用的模型提供商
- ✅ **实时显示**余额或 usage 限额 —— 每 **5 分钟**自动刷新
- ✅ **切换即更新**—— 切换模型或提供商时立即刷新
- ✅ **多提供商支持** —— DeepSeek、Sub2Api、OpenCode Go 及兼容 API
- ✅ **余额接口零配置** —— OpenCode Go 可通过 `/balance`、环境变量或模型 headers 配置
- ✅ **优雅降级** —— 无法获取余额或 usage 限额时自动隐藏，不干扰使用

## 📦 安装

### 方式一：从 npm 安装（推荐）

```bash
pi install npm:pi-balance
```

### 方式二：从 GitHub 安装

```bash
pi install git:github.com/DragonYH/pi-balance
```

### 方式三：本地开发安装

```bash
git clone https://github.com/DragonYH/pi-balance.git
cd pi-balance
npm install
npm run build
pi install ./
```

### 验证安装

重启 pi。连接到一个支持的提供商后，你将在状态栏中看到余额指示器。

## 🔌 支持的提供商

| 提供商 | 余额 / Usage 接口 | 显示内容 |
|----------|-----------------|----------|
| **DeepSeek** | `/user/balance` | ¥（人民币）余额 |
| **Sub2Api** | `/usage` | $（美元）剩余额度 |
| **OpenCode Go** | `https://opencode.ai/workspace/{workspaceId}/go` | Rolling / Weekly / Monthly usage 限额 |
| **兼容 API** | `/usage`、`/v1/usage` | $（美元）剩余额度 |

> 扩展会根据你当前的模型配置自动检测所使用的提供商 —— 无需手动设置。

> OpenCode Go dashboard usage 需要提供 dashboard workspace ID 和 auth cookie。可使用 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`（或 `OPENCODE_GO_AUTH_TOKEN`），也可通过模型 headers 提供 `x-opencode-workspace-id` 和 `x-opencode-auth`。

## 🚀 使用

安装完成后，pi-balance 会**完全自动地**工作：

1. **会话启动时** —— 立即获取余额
2. **切换模型时** —— 刷新新提供商的余额
3. **自动刷新** —— 每 **5 分钟**更新一次余额

余额或 usage 限额显示在 pi 终端底部的**状态栏**中：

```
DeepSeek: ¥49.87
OpenCode: Rolling 42% (3h) · Weekly 18% (2d)
```

> 如果扩展无法确定你的余额或 usage 限额（例如不支持的提供商、OpenCode workspace/auth 信息缺失或网络问题），状态栏条目会优雅隐藏。

### `/balance` 命令

使用 `/balance` 打开更清晰的分组配置菜单，可以：

- 查看当前已配置 provider 的支持情况
- 进入 **OpenCode Go** 二级菜单，直接配置 Workspace ID
- 进入 **Sub2Api** 二级菜单，开关用户自定义的 Sub2Api provider
- 开启或关闭某个 provider 的状态栏显示
- 立即刷新当前状态栏

也可以直接使用命令参数：

```bash
/balance status
/balance opencode-go
/balance sub2api
/balance enable opencode-go
/balance disable deepseek
/balance toggle sub2api
```

### 配置说明

- **Provider 显示开关** 会由 `/balance` 菜单保存，并在下一次刷新时生效。
- **OpenCode Go** 需要 dashboard workspace ID 和 auth 信息。可以设置 `OPENCODE_GO_WORKSPACE_ID` 与 `OPENCODE_GO_AUTH_COOKIE` / `OPENCODE_GO_AUTH_TOKEN`，在 `/balance` 中配置 workspace ID，或通过模型 headers 提供 `x-opencode-workspace-id` 和 `x-opencode-auth`。
- **自定义 Sub2Api provider** 会从 pi 模型配置中自动探测，并可在 `/balance sub2api` 中逐个开启或关闭。
- 网络请求会快速超时；获取失败时状态栏会自动隐藏，不会打断当前会话。

## 🧠 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│  pi 编码代理                                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │  [聊天界面]                                            │  │
│  │                                                       │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  状态栏:  DeepSeek: ¥49.87     ◉ 已连接                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ 扩展: pi-balance ────────────────────────────────────┐  │
│  │  session_start  ──►  fetchBalance()  ──►  setStatus() │  │
│  │  model_select   ──►  fetchBalance()  ──►  setStatus() │  │
│  │  5 分钟定时器  ────►  refreshBalance()                 │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 事件处理

- **`session_start`** —— 会话开始时获取余额
- **`model_select`** —— 切换模型/提供商时重新获取
- **`session_shutdown`** —— 清理定时器并清除状态

## 🏗️ 项目结构

```
pi-balance/
├── src/
│   └── index.ts                  # 扩展主源码
├── LICENSE                       # MIT 许可证
├── README.md                     # 英文文档
├── README.zh-CN.md               # 中文文档
├── package.json                  # Node.js 与 pi 包清单
├── tsconfig.build.json           # 构建配置
└── tsconfig.json                 # TypeScript 配置
```

## 🛠️ 开发者指南

### 类型检查

```bash
npm run typecheck
```

### 构建

```bash
npm run build
```

### 发布前检查清单

本项目通过 GitHub Actions 在推送版本 tag 时发布。

发布前请检查 npm 包内容：

```bash
npm pack --dry-run
```

然后创建并推送与 `package.json` 版本一致的 tag：

```bash
git tag v0.2.0
git push origin v0.2.0
```

推送 tag 前，请在 npm 为该包配置 Trusted Publishing：

- Publisher：GitHub Actions
- Owner：`DragonYH`
- Repository：`pi-balance`
- Workflow：`release.yml`
- Environment：如果 workflow 没有配置 environment，则留空。

### 添加新的提供商

该扩展设计为易于扩展。要为新的提供商添加支持，请参照 `tryDeepSeekBalance` 或 `trySub2ApiBalance` 的模式实现余额获取函数，然后在 `fetchProviderBalance` 中添加调用即可。

```typescript
async function tryYourProviderBalance(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<BalanceResult | undefined> {
  const data = await getJson(`${baseUrl}/your/endpoint`, headers);
  const amount = extractSomeField(data);
  return amount !== undefined ? { amount, unit: "$" } : undefined;
}
```

## 📄 许可证

[MIT](./LICENSE)

---

<p align="center">
  <sub>为 <a href="https://github.com/earendil-works/pi-coding-agent">pi 编码代理</a> 生态构建</sub>
  <br>
  <a href="./README.md"><img src="https://img.shields.io/badge/🇬🇧_Read_in_English-6C5CE7?style=for-the-badge"></a>
</p>
