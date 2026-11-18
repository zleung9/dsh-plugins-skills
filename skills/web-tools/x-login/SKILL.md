---
name: x-login
description: Log in to X.com (Twitter) with Playwright Chromium using a dedicated persistent profile that bypasses X's 403 bot block. Provides a headless login-state check, a visible-window interactive sign-in (recommended), an automated username/password form-filler with human handoff on challenges, and a logout/reset helper. Reuses the proven anti-detection profile pattern from x-digest. Run via `pi -p "/skill:x-login"`.
---

# X.com 登录 (Playwright Chromium)

用 Playwright 自带的 Chromium + **专用持久化 profile** 登录 X.com (Twitter)。
绕过 X 对无头浏览器的 403 拦截,登录态持久化到磁盘,后续运行免重复登录。

## 为什么需要这个技能

- **默认无头 Chromium 访问 x.com 直接 403 / 空白页** —— X 的反爬识别
  `navigator.webdriver` 等指纹。本技能用 `--disable-blink-features=
  AutomationControlled` + 真实 locale/viewport + 持久 profile 绕过。
- **不依赖用户的 Chrome / CDP 端口** —— 用 Playwright 自带 Chromium,
  **从不加载用户扩展**(避免 X 的 "privacy related extensions" 启动错误)。
- **登录 cookie 持久化** 在 `~/email-assistant/browser-profiles/x-login`
  (刻意放在技能目录**之外**,避免 Nutstore 同步活动的 Chrome profile;
  可用 `X_PROFILE_DIR` 环境变量覆盖),登录一次,后续免登录
  (直到 X 让会话过期)。
- 网络走 macOS 系统代理(如 Clash @ 127.0.0.1:7890),国内可达 X.com。

## 路径

真实目录: `~/Nutstore Files/skills/web-tools/x-login`
软链: `~/.pi/agent/skills/x-login` → 上面那个目录。

**先 cd 到技能目录再运行脚本:**

```bash
cd /Users/zliang/.pi/agent/skills/x-login   # = ~/Nutstore Files/skills/web-tools/x-login
```

## 首次设置

依赖**全局共享**,不在本技能目录里安装:`node_modules/` 是指向
`~/.agents/node_modules` 的**软链**(playwright 1.63.x)。

```bash
npm install --prefix ~/.agents          # 一次性安装/升级所有技能共享的依赖
```

> 不要在技能目录里跑 `npm install`——那会把软链替换成本地副本,依赖又会
> 散落回 Nutstore 同步目录。

若 Chromium 缺失(报 "Executable doesn't exist"):

```bash
cd ~/.agents && npx playwright install chromium
```

## 三种登录方式

### 1. 检查登录态(无头,最快)— `scripts/x-status.mjs`

```bash
node scripts/x-status.mjs
```

输出 JSON:`{ loggedIn, hasAuthToken, cookieCount, url, httpStatus }`
- `loggedIn: true` → 已登录,无需操作。
- `loggedIn: false` → 需要登录,用下面方式 2 或 3。
- 退出码:0 = 已登录,1 = 未登录。

加 `--headed` 可观察窗口。**始终先用它判断,避免不必要的可见窗口。**

### 2. 可见窗口交互登录(推荐,最可靠)— `scripts/x-login.mjs`

打开一个 **可见 Chromium 窗口** 到 `x.com/login`,由真人在窗口里登录
(Google / Apple / 手机 / 邮箱均可)。脚本每 5 秒轮询 `auth_token` cookie,
出现即认为登录成功并关闭窗口。

```bash
node scripts/x-login.mjs --timeout-minutes 15
```

- 输出 `ALREADY_LOGGED_IN` / `OPEN_BROWSER_WINDOW` / `LOGGED_IN` /
  `LOGIN_TIMEOUT`。
- 退出码:0 = 登录成功,1 = 超时,2 = 启动错误。
- **为什么推荐**:X 的 Arkose / 设备指纹挑战对真人浏览器远比自动化
  填表友好;人工登录一次后 cookie 持久化,长期免登录。

### 3. 自动化填表(用户名+密码)— `scripts/x-login-auto.mjs`

⚠️ **X 有强力反机器人(Arkose 挑战 / 设备指纹)**。自动填表经常触发
验证码或"验证身份"步骤,脚本无法自动解决。因此本脚本:

1. 打开**可见窗口**(挑战出现时你可接管);
2. 填用户名 → 填密码 → 点"继续/Next/Log in";
3. 检测结果(登录成功 / 验证步骤 / 被拦);
4. 若出现挑战,**保持窗口打开**,轮询最多 `--timeout-minutes` 等你手动完成。

凭据**从环境变量读取,绝不硬编码**:

```bash
X_USER='你的用户名或邮箱' X_PASS='你的密码' node scripts/x-login-auto.mjs --timeout-minutes 15
```

- 退出码:0 = 登录成功,1 = 超时/挑战未解决,2 = 错误。
- 真实 DOM(zh-CN):表单含 `input[name="username_or_email"]` +
  `input[type="password"]` + "继续"按钮;脚本已适配并处理后续的
  密码单独步 / 用户名验证步。

## 退出 / 重置 — `scripts/x-logout.mjs`

```bash
node scripts/x-logout.mjs --cookies   # 删除 auth_token 等登录 cookie(保留 profile)
node scripts/x-logout.mjs --purge     # 删除整个 profile(~/email-assistant/browser-profiles/x-login,最强重置)
```

## 完整工作流示例

```bash
cd /Users/zliang/.pi/agent/skills/x-login

# 1) 先查状态
node scripts/x-status.mjs
# → {"loggedIn":false,...}  未登录

# 2) 可见窗口登录(推荐)
node scripts/x-login.mjs --timeout-minutes 15
# 真人在弹出的窗口里登录 → LOGGED_IN

# 3) 复查状态(无头确认)
node scripts/x-status.mjs
# → {"loggedIn":true,"hasAuthToken":true,...}

# 之后每次只要没过期,x-status 直接返回 true,无需再登录。
```

## 脚本一览

| 脚本 | 用途 | 默认模式 |
|---|---|---|
| `scripts/pw-common.mjs` | 共享:反检测启动、持久 profile、登录态检测 | (被引用) |
| `scripts/x-status.mjs` | 打印登录态 JSON | 无头 |
| `scripts/x-login.mjs` | 可见窗口交互登录,轮询 auth_token | 可见 |
| `scripts/x-login-auto.mjs` | 自动填用户名+密码,挑战时人工接管 | 可见 |
| `scripts/x-logout.mjs` | 清登录 cookie / 清整个 profile | 无头 |

## 注意事项

- `~/email-assistant/browser-profiles/x-login` 同一时间**只能一个进程持有**(SingletonLock)——
  脚本需顺序运行。
- 删除该 profile 只会强制重新登录,不丢失其他东西(它不在技能目录里,
  也不进 Nutstore 同步)。
- 若 X 中途让会话过期(x-status 报未登录),重新跑 `x-login.mjs` 即可。
- 自动化填表(方式 3)成功率受 X 风控影响,**优先用方式 2**。
- 凭据只通过环境变量传入,不要写进脚本或 git。
