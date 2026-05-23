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

---

## 📋 功能特性

pi-balance 是 [pi 编码代理](https://github.com/earendil-works/pi-coding-agent) 的一款**扩展**，能够自动获取并在 pi **状态栏**中实时显示你的 AI 提供商 API 额度余额。

- ✅ **自动识别**当前使用的模型提供商
- ✅ **实时显示**余额 —— 每 **5 分钟**自动刷新
- ✅ **切换即更新**—— 切换模型或提供商时立即刷新
- ✅ **多提供商支持** —— DeepSeek、Sub2Api 及兼容 API
- ✅ **零配置** —— 安装即可使用，无需额外设置
- ✅ **优雅降级** —— 无法获取余额时自动隐藏，不干扰使用

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

| 提供商 | 余额接口 | 货币单位 |
|----------|-----------------|----------|
| **DeepSeek** | `/user/balance` | ¥（人民币） |
| **Sub2Api** | `/usage` | $（美元） |
| **兼容 API** | `/usage`、`/v1/usage` | $（美元） |

> 扩展会根据你当前的模型配置自动检测所使用的提供商 —— 无需手动设置。

## 🚀 使用

安装完成后，pi-balance 会**完全自动地**工作：

1. **会话启动时** —— 立即获取余额
2. **切换模型时** —— 刷新新提供商的余额
3. **自动刷新** —— 每 **5 分钟**更新一次余额

余额显示在 pi 终端底部的**状态栏**中：

```
DeepSeek: ¥49.87
```

> 如果扩展无法获取余额（例如提供商不支持或网络问题），状态栏条目会自动隐藏。

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

发布前请检查 npm 包内容：

```bash
npm pack --dry-run
```

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
