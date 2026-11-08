# DSH 微信提醒

> DSH 任务完成、出错、需要你选择时，通过 PushPlus 推送到微信。

[![npm](https://img.shields.io/npm/v/@fanpaisk/dsh-pushplus-notify)](https://www.npmjs.com/package/@fanpaisk/dsh-pushplus-notify)
[![CI](https://github.com/fanpaisk/dsh-pushplus-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/fanpaisk/dsh-pushplus-notify/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/fanpaisk/dsh-pushplus-notify)](LICENSE)

包名：`@fanpaisk/dsh-pushplus-notify` · 标准 DSH **Bundle 插件** · 支持桌面版 / Web / Headless

## 30 秒开始

**桌面版**：插件 → 添加插件 → 输入 `@fanpaisk/dsh-pushplus-notify` → 安装并打开开关。

**Web 版**：

```powershell
dsh plugin --profile web add @fanpaisk/dsh-pushplus-notify
```

**配置微信提醒**：

```powershell
npx @fanpaisk/dsh-pushplus-notify setup
```

> 没有 PushPlus Token？打开 https://www.pushplus.plus/ ，微信扫码登录后复制。
> Token 是每个用户自己的，不要发给别人。

## 功能

| DSH 事件 | 微信标题 |
|---|---|
| 任务完成 `turn/end completed` | `[DSH] 任务已完成` |
| 任务出错 `turn/end error` | `[DSH] 任务出错` |
| 任务中断 `turn/end aborted` | `[DSH] 任务已中断` |
| 任务阻塞 `turn/end blocked` | `[DSH] 任务等待处理` |
| 输出达到上限 `turn/end max-tokens` | `[DSH] 输出达到上限` |
| 权限审批 `approval/asked` | `[DSH] 等待权限确认` |
| 需要选择 `tool/call ask_user_question` | `[DSH] 需要你做出选择` |

- 每个 DSH 进程启动时发送一次「提醒服务已启动」；
- `ask_user_question` 不产生 `turn/end`，插件单独监听，并在加载时补扫仍挂起的问题；
- 子代理会话默认不提醒；
- PushPlus 失败自动重试，并可切换 http 备用地址。

## 安装

### 桌面版（Desktop）

桌面版使用独立的 `desktop` profile，由桌面 App 管理，**不能**用
`dsh plugin --profile desktop ...` 安装。

1. 打开 **插件 / Plugins** 页
2. 点 **添加插件**
3. 输入：

```text
@fanpaisk/dsh-pushplus-notify
```

4. 安装源选 **npm 官方源**
5. 安装完成后，把插件开关打开

也可以用 GitHub 地址安装：

```text
https://github.com/fanpaisk/dsh-pushplus-notify
```

> 注意：在终端运行 `dsh plugin --profile web add ...` 只会安装到 `web` profile，
> 不会影响桌面版。桌面版读的是 `desktop` profile。

安装后 DSH 每次启动会自动加载，不需要 watchdog。

### Web 版

在终端安装到 `web` profile，然后启动 Web：

```powershell
dsh plugin --profile web add @fanpaisk/dsh-pushplus-notify
dsh web
```

GitHub 方式：

```powershell
dsh plugin --profile web add github:fanpaisk/dsh-pushplus-notify
```

### Headless（可选）

```powershell
dsh plugin --profile headless add @fanpaisk/dsh-pushplus-notify
```

### 本地 tarball

```powershell
npm run pack
dsh plugin --profile web add file:C:\path\to\fanpaisk-dsh-pushplus-notify-1.0.2.tgz
```

> `web`、`desktop`、`headless` 是三个独立 profile。装到哪个 profile，
> 只有那个入口会生效。桌面版请在桌面 App 的插件页安装。

## 首次配置

### 先获取 PushPlus Token

1. 打开 https://www.pushplus.plus/
2. 用微信扫码登录
3. 在首页复制你的 token
4. 运行下面的 `setup`，把 token 粘贴进去

> PushPlus 是一个微信推送服务，token 是每个用户自己的，不能共用，也不要发给别人。

```powershell
npx @fanpaisk/dsh-pushplus-notify setup
```

按提示粘贴 PushPlus Token，会写入：

```text
%USERPROFILE%\.dsh\pushplus-notify.json
```

并可选发送一条测试消息。其他命令：

```powershell
npx @fanpaisk/dsh-pushplus-notify test
npx @fanpaisk/dsh-pushplus-notify status
```

也可以在 DSH 的插件设置里直接编辑该 JSON。最小配置：

```json
{
  "token": "你的 PushPlus Token",
  "notifyOnStartup": true,
  "notifyOnComplete": true,
  "notifyOnQuestion": true
}
```

## 配置字段

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `token` | 空 | PushPlus token；也可用 `PUSHPLUS_TOKEN` 环境变量 |
| `logFile` | `~/.dsh/logs/pushplus-notify.log` | 插件日志 |
| `notifyOnComplete` / `Error` / `Abort` / `Blocked` / `MaxTokens` | `true` | 各类回合提醒 |
| `notifyOnPermission` | `true` | 权限审批提醒 |
| `notifyOnQuestion` | `true` | 需要选择提醒 |
| `notifyOnSubagent` | `false` | 是否提醒子代理 |
| `timeoutMs` | `10000` | 单次请求超时 |
| `maxAttempts` | `2` | 网络失败重试轮数 |
| `fallbackEndpoint` | `http://www.pushplus.plus/send` | 主地址失败后的备用地址 |
| `permissionCooldownSeconds` | `60` | 权限提醒冷却 |

优先级：默认值 < `pushplus-notify.json` < 插件 config < `PUSHPLUS_TOKEN`。

## 结构

```text
lib/
├─ index.js       # 装配：settings → logger → transport → router
├─ config.js      # 默认值、用户配置、分层归一化
├─ events.js      # DSH 事件 → 通知模型
├─ format.js      # 纯消息模板
├─ pushplus.js    # 传输/重试/备用地址
├─ session.js     # session 读取辅助
├─ state.js       # 去重/冷却状态
├─ text.js        # 文本/时间工具
└─ log.js         # 文件 + DSH 日志

bin/cli.mjs       # setup / test / status
cordis.patch.yml  # bundle 插入条目
```

新增事件只改 `events.js` + `format.js`；换通知渠道只替换 `pushplus.js` 的 transport；
设置 UI/CLI 只读写同一个 settings JSON。

## 开发

```powershell
npm test
npm run pack
npm publish --access public
```

## 市场

DSH 当前没有官方中心市场；Discover 展示的是用户添加的 index。若要提供市场条目，
可以生成 format 1 的 `index.json` 并让用户添加其 URL。npm 和 GitHub 是实际安装渠道。

## License

MIT
