<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/pi--balance-⚖️-6C5CE7?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cGF0aCBkPSJNMjAgM0wxIDM3aDM8eiIgZmlsbD0iIzZDQ0NFNyIvPjx0ZXh0IHg9IjIwIiB5PSIyNSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1zaXplPSIxNCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiMxRTFDMkIiPuKZrzwvdGV4dD48L3N2Zz4=">
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

pi-balance 是 [pi 编码代理](https://github.com/earendil-works/pi-coding-agent) 的一款**扩展**，能够自动获取并在 pi **状态栏**中实时显示你的 AI 提供商 API 额度余额。

- ✅ **自动识别**当前使用的模型提供商
- ✅ **任务中自动刷新** —— 每次模型回复完成后更新，任务运行期间每分钟补充刷新（并显示增减 ▲▼）
- ✅ **切换即更新**—— 切换模型或提供商时立即刷新
- ✅ **多提供商支持** —— DeepSeek、Moonshot/Kimi、OpenRouter、Sub2Api、OpenAI Codex 及兼容 API
- ✅ **余额接口零配置** —— 支持的余额接口可复用模型 headers
- ✅ **优雅降级** —— 无法获取余额时自动隐藏，不干扰使用
- ✅ **国际化支持** —— 简体中文与英文，支持 `/balance lang <zh-CN|en>` 切换

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

| 提供商 | 余额接口 | 显示内容 |
|----------|-----------------|----------|
| **DeepSeek** | `/user/balance` | 所选币种的余额（人民币或美元） |
| **Moonshot** | `/v1/users/me/balance` | ¥（人民币）可用余额 |
| **Kimi Code** | `/v1/usages`、`/usages` | 5 小时与每周剩余额度、重置倒计时及已启用的加量钱包余额 |
| **Sub2Api** | `/usage` | $（美元）剩余额度 |
| **兼容 API** | `/usage`、`/v1/usage` | $（美元）剩余额度 |
| **OpenAI Codex** | ChatGPT Codex usage API / `codex app-server` | 5 小时与每周用量剩余额度 |
| **OpenRouter** | `/v1/credits` | $（美元）剩余额度 |

> 扩展会根据你当前的模型配置自动检测所使用的提供商 —— 无需手动设置。


## 🚀 使用

安装完成后，pi-balance 会**完全自动地**工作：

1. **会话启动时** —— 立即获取余额
2. **切换模型时** —— 刷新新提供商的余额
3. **任务运行期间** —— 每次模型回复完成后立即刷新；模型仍在生成或工具执行耗时较长时，每分钟补充查询一次
4. **任务结束后**（`agent_end`）—— 再次刷新，获取最终余额；运行期间及结束后的刷新会显示余额变化（▲▼）

自动刷新不会阻塞模型回复或工具执行；查询期间保留已显示的余额，重叠的刷新事件会合并处理。任务结束后停止定时查询。

余额会显示在 pi 终端底部的**状态栏**中：

```
DeepSeek: ¥49.87
```

> 如果扩展无法确定你的余额（例如不支持的提供商或网络问题），状态栏条目会优雅隐藏。

### `/balance` 命令

使用 `/balance` 打开交互式配置菜单，可以：

- 查看当前已配置 provider 的支持状态
- 展开/折叠 provider，切换显示开关和额外选项
- 在主菜单中直接开关 **Sub2Api** 子 provider（内联展开，带自动探测）
- 开启或关闭 **Codex CLI 回退**模式
- 立即刷新当前状态栏

也可以直接使用命令参数：

```bash
/balance status
/balance refresh
/balance enable deepseek
/balance disable moonshot
/balance toggle codex
/balance toggle openrouter
/balance toggle sub2api
/balance sub2api               # 打开 Sub2Api 子 provider 菜单
/balance sub2api rescan         # 重新扫描 Sub2Api provider
/balance lang zh-CN             # 切换至简体中文
/balance lang en                # 切换至英文
```

### 配置说明

- **DeepSeek 多币种余额** 会按币种分别汇总，显示数值最大的非零余额；数值相同时按币种代码稳定选择，零余额和负余额也会显示。将 `PI_BALANCE_CNY_RATE` 设置为有限正数的美元兑人民币汇率（例如 `7.2`），可将选中的美元余额换算成人民币显示。不同币种的金额不会直接相加。
- **Kimi Code 额度** 按可用时间窗口显示剩余百分比，例如 `Kimi: 5h·56%↺2h30m 7d·80%↺6d`。已启用的加量钱包以人民币显示，保留两位小数。支持识别 `kimi` / `kimi-*` provider 和 `kimi.com` 接口，与 Moonshot 共用 `moonshot` 显示开关。额度接口不可用时，会尝试标准 Moonshot 余额接口。
- **Provider 显示开关** 会由 `/balance` 菜单保存，并在下一次刷新时生效。
- **自定义 Sub2Api provider** 会从 pi 模型配置中自动探测，并可在主菜单或 `/balance sub2api` 中逐个开启或关闭。修改模型配置后，可使用 `/balance sub2api rescan` 重新扫描。
- **OpenAI Codex 用量** 仅在当前模型 provider 为 `openai-codex` 时显示。扩展会优先复用 pi 的 Codex 订阅认证 headers，并可在可用时回退到 `codex app-server --listen stdio://`；CLI 回退可在 `/balance` 菜单中开关。
- 菜单使用智能缓存：展开/折叠 provider 时不会触发任何异步计算，体验即时流畅。
- 优先请求提供商的专用余额接口，获取不到余额时再尝试通用 Sub2Api `/usage` 接口。
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
│  │  agent_start   ────►  开始每 60 秒定时刷新            │  │
│  │  message_end   ────►  模型回复后刷新余额              │  │
│  │  agent_end     ────►  停止定时查询并刷新最终余额      │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 事件处理

- **`session_start`** —— 会话开始时获取余额
- **`model_select`** —— 切换模型/提供商时重新获取
- **`agent_start`** —— 立即刷新并开始每分钟定时查询
- **`message_end`** —— 每次模型回复完成后刷新，工具结果和用户消息不会触发查询
- **`agent_end`** —— 停止定时查询并刷新最终余额
- **`session_shutdown`** —— 停止定时查询，取消请求并清除状态

## 🏗️ 项目结构

```
pi-balance/
├── src/
│   ├── index.ts                  # 组装入口，命令注册，生命周期
│   ├── types.ts                   # 类型定义和常量
│   ├── config.ts                  # 配置加载/持久化/开关
│   ├── utils.ts                   # 工具函数（fetch、JSON 解析等）
│   ├── menu.ts                    # 动态菜单构建与缓存
│   └── providers/
│       ├── types.ts               # BalanceProvider 接口定义
│       ├── registry.ts            # Provider 单例注册表
│       ├── deepseek.ts            # DeepSeek provider
│       ├── moonshot.ts            # Moonshot/Kimi provider
│       ├── openrouter.ts          # OpenRouter provider
│       ├── sub2api.ts             # Sub2Api + 自动探测
│       └── codex.ts               # OpenAI Codex + CLI 回退
│   └── i18n/
│       ├── index.ts              # t() 翻译函数与语言检测
│       ├── zh-CN.ts              # 中文翻译
│       └── en.ts                 # 英文翻译
├── tests/
│   ├── deepseek.test.ts          # 币种选择与汇率换算回归测试
│   ├── index.test.ts
│   ├── moonshot.test.ts          # Kimi 额度解析、识别与接口回退测试
│   └── refresh.test.ts           # 刷新时机、请求合并与生命周期回归测试
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

### 测试

```bash
npm test
```

### 发布前检查清单

本项目通过 GitHub Actions 在推送版本 tag 时发布。

发布前请检查 npm 包内容：

```bash
npm pack --dry-run
```

然后创建并推送与 `package.json` 版本一致的 tag：

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

推送 tag 前，请在 npm 为该包配置 Trusted Publishing：

- Publisher：GitHub Actions
- Owner：`DragonYH`
- Repository：`pi-balance`
- Workflow：`release.yml`
- Environment：如果 workflow 没有配置 environment，则留空。

### 添加新的提供商

扩展采用可插拔的 provider 架构。要为新提供商添加支持，请在 `src/providers/` 中创建一个实现 `BalanceProvider` 接口的模块，然后在 `src/index.ts` 中导入它即可触发自动注册：

```typescript
// src/providers/yourprovider.ts
import type { BalanceProvider } from "./types.js";
import { registry } from "./registry.js";
import type {
  BalanceResult,
  BalanceConfig,
  FetchContext,
  ProviderSupport,
} from "../types.js";
import { getJson } from "../utils.js";

export const yourProvider: BalanceProvider = {
  key: "yourprovider",
  definition: {
    key: "yourprovider",
    label: "YourProvider",
    color: "#FFD700",
  },

  shouldTry(model, baseUrl) {
    return baseUrl.includes("yourprovider.com");
  },

  async fetchBalance(
    ctx: FetchContext,
    signal?: AbortSignal,
  ): Promise<BalanceResult | undefined> {
    const data = await getJson(`${ctx.baseUrl}/your/endpoint`, ctx.headers, signal);
    const amount = data?.credits_remaining;
    return typeof amount === "number" ? { amount, unit: "¥" } : undefined;
  },

  async getSupport(
    ctx: ExtensionContext,
    config: BalanceConfig,
  ): Promise<ProviderSupport> {
    return {
      provider: this.definition,
      configured: true,
      details: ["已配置"],
    };
  },
};

registry.register(yourProvider);
```

然后在 `src/index.ts` 中添加一行导入：

```typescript
import "./providers/yourprovider.js";
```

完成！provider 会自动注册、出现在 `/balance` 菜单中并参与余额获取。无需其他代码修改。

## 📄 许可证

[MIT](./LICENSE)

---

<p align="center">
  <sub>为 <a href="https://github.com/earendil-works/pi-coding-agent">pi 编码代理</a> 生态构建</sub>
  <br>
  <a href="./README.md"><img src="https://img.shields.io/badge/🇬🇧_Read_in_English-6C5CE7?style=for-the-badge"></a>
</p>
