<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/pi--balance-⚖️-6C5CE7?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cGF0aCBkPSJNMjAgM0wxIDM3aDM4eiIgZmlsbD0iIzZDQ0NFNyIvPjx0ZXh0IHg9IjIwIiB5PSIyNSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1zaXplPSIxNCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiMxRTFDMkIiPuKZrzwvdGV4dD48L3N2Zz4=">
    <img src="https://img.shields.io/badge/pi--balance-⚖️-6C5CE7?style=for-the-badge" alt="pi-balance" height="48">
  </picture>
</p>

<p align="center">
  <strong>Real-time AI Provider Balance for <a href="https://github.com/earendil-works/pi-coding-agent">pi</a> Coding Agent</strong>
  <br>
  <sub>Display your API provider credit balance right in the pi status bar</sub>
</p>

<p align="center">
  <a href="#-features"><img src="https://img.shields.io/badge/Features-📋-6C5CE7?style=flat-square"></a>
  <a href="#-installation"><img src="https://img.shields.io/badge/Installation-📦-00B894?style=flat-square"></a>
  <a href="#-supported-providers"><img src="https://img.shields.io/badge/Providers-🔌-FD79A8?style=flat-square"></a>
  <a href="#-usage"><img src="https://img.shields.io/badge/Usage-🚀-0984E3?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pi-balance"><img src="https://img.shields.io/npm/v/pi-balance?style=flat-square&color=CB3837"></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/🇨🇳_中文-FADB4A?style=flat-square"></a>
</p>

<p align="center">
  <img src="https://img.dog/file/1779542581467_mzRI9XShNB2pFCVDlx1f8.webp" alt="pi-balance preview" width="600">
</p>

---

## 📋 Features

pi-balance is an **extension** for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) that automatically fetches and displays your AI provider's API credit balance in the pi **status bar**.

- ✅ **Auto-detects** your currently active model provider
- ✅ **Real-time** balance display — refreshes every **5 minutes**
- ✅ **Live updates** on provider/model switch
- ✅ **Multi-provider support** — DeepSeek, Sub2Api, OpenAI Codex (and compatible APIs)
- ✅ **Zero configuration for balance APIs** — supported balance APIs work from existing model headers
- ✅ **Graceful fallback** — quietly hides when balance info is unavailable

## 📦 Installation

### Option 1: Install from npm (Recommended)

```bash
pi install npm:pi-balance
```

### Option 2: Install from GitHub

```bash
pi install git:github.com/DragonYH/pi-balance
```

### Option 3: Local Development

```bash
git clone https://github.com/DragonYH/pi-balance.git
cd pi-balance
npm install
npm run build
pi install ./
```

### Verify Installation

Restart pi. You should see the balance indicator appear in the status bar once you connect to a supported provider.

## 🔌 Supported Providers

| Provider | Balance Endpoint | Display |
|----------|--------------------------|---------|
| **DeepSeek** | `/user/balance` | ¥ (CNY) balance |
| **Sub2Api** | `/usage` | $ (USD) remaining balance |
| **Compatible APIs** | `/usage`, `/v1/usage` | $ (USD) remaining balance |
| **OpenAI Codex** | ChatGPT Codex usage API / `codex app-server` | 5-hour and weekly usage remaining |

> The extension automatically detects which provider you're using based on your current model configuration — no manual setup required.


## 🚀 Usage

Once installed, pi-balance works **completely automatically**:

1. **On session start** — it fetches your balance immediately
2. **On model switch** — it re-fetches for the new provider
3. **Auto-refresh** — balances are refreshed every **5 minutes**

The balance is displayed in the **status bar** at the bottom of your pi terminal:

```
DeepSeek: ¥49.87
```

> If the extension cannot determine your balance (e.g., unsupported provider or network issue), the status bar entry is gracefully hidden.

### `/balance` Command

Run `/balance` to open a grouped interactive configuration menu. You can:

- View support status for configured providers
- Open the **Sub2Api** submenu and enable/disable user-defined Sub2Api providers
- Enable or disable a provider in the status bar
- Refresh the current status immediately

You can also use command arguments directly:

```bash
/balance status
/balance sub2api
/balance refresh
/balance sub2api rescan
/balance disable deepseek
/balance toggle sub2api
/balance toggle codex
```

### Configuration Notes

- **Provider display toggles** are saved by the `/balance` menu and apply on the next refresh.
- **Custom Sub2Api providers** are discovered from your pi model configuration and can be enabled or disabled individually from `/balance sub2api`. Use `/balance sub2api rescan` or the submenu's **Rescan providers** item after changing model configuration.
- **OpenAI Codex usage** is shown only while the active model provider is `openai-codex`. The extension first reuses pi's Codex subscription auth headers and can fall back to `codex app-server --listen stdio://` when available; the CLI fallback can be toggled in the `/balance` menu.
- Network requests time out quickly and failures are hidden from the status bar instead of interrupting your session.

## 🧠 How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  pi Coding Agent                                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │  [Chat Interface]                                     │  │
│  │                                                       │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  Status Bar:  DeepSeek: ¥49.87     ◉ Connected        │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Extension: pi-balance ───────────────────────────────┐  │
│  │  session_start  ──►  fetchBalance()  ──►  setStatus() │  │
│  │  model_select   ──►  fetchBalance()  ──►  setStatus() │  │
│  │  5-min timer   ────►  refreshBalance()                 │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Events Handled

- **`session_start`** — initial balance fetch when a session begins
- **`model_select`** — re-fetch when you switch models/providers
- **`session_shutdown`** — cleanup timers and clear status

## 🏗️ Project Structure

```
pi-balance/
├── src/
│   └── index.ts                  # Main extension source
├── LICENSE                       # MIT license
├── README.md                     # English documentation
├── README.zh-CN.md               # Chinese documentation
├── package.json                  # Node.js and pi package manifest
├── tsconfig.build.json           # Build configuration
└── tsconfig.json                 # TypeScript configuration
```

## 🛠️ For Developers

### Type-Checking

```bash
npm run typecheck
```

### Build

```bash
npm run build
```

### Publish Checklist

This project publishes through GitHub Actions when a version tag is pushed.

Before publishing, verify the package contents:

```bash
npm pack --dry-run
```

Then create and push a tag that matches `package.json`:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Before pushing the tag, configure npm Trusted Publishing for this package:

- Publisher: GitHub Actions
- Owner: `DragonYH`
- Repository: `pi-balance`
- Workflow: `release.yml`
- Environment: leave empty unless you add one to the workflow.

### Adding a New Provider

The extension is designed to be easily extensible. To add support for a new provider, implement a balance fetcher function following the pattern of `tryDeepSeekBalance` or `trySub2ApiBalance`, then add it to `getEnabledFetchers`.

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

## 📄 License

[MIT](./LICENSE)

---

<p align="center">
  <sub>Built for the <a href="https://github.com/earendil-works/pi-coding-agent">pi coding agent</a> ecosystem</sub>
  <br>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/🇨🇳_阅读中文版本-FFD700?style=for-the-badge"></a>
</p>
