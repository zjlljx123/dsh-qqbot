# dsh-im-bridge 🐧💬

把 **QQ**（OneBot v11 / [NapCat](https://github.com/NapNeko/NapCatQQ)、Lagrange 等）和**个人微信**（[WeChatFerry](https://github.com/lich0821/WeChatFerry) / wcf）接入 **DeepSeek Harness (DSH)** 的聊天桥接插件，像 OpenClaw / Harness 那样直接和你的 agent 聊天：

- ✅ **双向文本对话**：私聊 / 群聊，每个会话对应一个独立的 DSH 会话（带独立工作目录，上下文连续）
- ✅ **发文件**：让 agent 在回复中写 `/send <绝对路径>`，插件自动通过平台原生接口把文件发给对方
  - QQ：`upload_private_file` / `upload_group_file`（失败自动降级为 `file` 消息段）
  - 微信：`WCF_SendFile`
- ✅ **收文件**：对方发的图片 / 文件自动下载到该会话工作区的 `inbox/`，agent 可以直接读取
- ✅ **安全启动**：所有桥接连接都是可选的、后台自动重连，**即使 NapCat / wcf 没启动，`dsh web` 也照常启动**（再也不会“整个工程起不来”）
- ✅ 会话/工作区映射持久化，重启 DSH 后对话自动恢复

> 参考实现：QQ 侧参考 [constansino/openclaw_qq](https://github.com/constansino/openclaw_qq)（OneBot v11 + NapCat，含文件收发）的成熟做法；微信侧直接对接 WeChatFerry 的 RPC 协议。

---

## 目录

- [工作原理](#工作原理)
- [一、安装](#一安装)
- [二、准备 QQ 端（NapCat）](#二准备-qq-端napcat)
- [三、准备微信端（WeChatFerry）](#三准备微信端wechatferry)
- [四、配置](#四配置)
- [五、使用](#五使用)
- [六、常见问题](#六常见问题)
- [免责声明](#免责声明)

---

## 工作原理

```
QQ 用户 ──OneBot v11 WS──▶ NapCat ──▶ dsh-im-bridge (QQClient)
微信用户 ──wcf RPC TCP────▶ WeChatFerry ─▶ dsh-im-bridge (WcfClient)
                                              │
                                    ctx.apiProxy（与 Web UI 同一套 RPC）
                                              │
                                    DSH 会话（每个聊天一个 session + 独立工作目录）
                                              │
                                    DeepSeek agent 处理 → 回复 → 原路发回
```

- 每个聊天（QQ 私聊 / QQ 群 / 微信私聊 / 微信群）绑定一个 DSH 会话，会话工作目录默认为 `$DSH_HOME/im-bridge/workspaces/<聊天key>`。
- 群聊默认需要 **@ 机器人**（QQ）或 **触发关键词**（微信）才回复，避免刷屏；均可配置。
- 会话可以在 DSH Web 界面左侧看到，也可以直接在网页里继续和该会话对话。

---

## 一、安装

### 方式 A：让 DSH 自己装（推荐）

把本目录（或 zip）交给 DSH，对它说：

> 帮我安装 dsh-im-bridge 插件

### 方式 B：手动安装（Windows，已验证）

推荐把插件放到 profile 目录里（与 `dsh-usagi-pet` 同样的方式，避免 pnpm 绝对路径 `link:` 在 Windows 上生成坏链接）：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\web"

# 1. 把插件源码复制进 profile 目录
Copy-Item D:\path\to\dsh-im-bridge $profile\dsh-im-bridge -Recurse
Remove-Item $profile\dsh-im-bridge\node_modules -Recurse -Force -ErrorAction SilentlyContinue

# 2. 在 profile 的 package.json 里加依赖 + bundle（已有内容不要删，只加这两处）
#    dependencies:  "dsh-im-bridge": "link:./dsh-im-bridge"
#    dsh.profile.bundles: [..., "@deepseek-ai/dsh-web-app", "dsh-im-bridge"]

# 3. 在 profile 目录安装依赖
Set-Location $profile
pnpm install

# 4. 重启 DSH Web（Ctrl+C 后重新运行 dsh web）
```

### 方式 C：`dsh plugin` 命令

```powershell
cd D:\path\to\repo
dsh plugin --profile web add link:./dsh-im-bridge
```

> ⚠️ 注意：Windows 上 `pnpm add link:<绝对路径>` 可能生成损坏的符号链接（本机实测）。如果装完 `node_modules\dsh-im-bridge` 指向不存在，请改用**方式 B**（相对 `link:./dsh-im-bridge` 放在 profile 目录内）。

装完后刷新/重启，日志里会出现 `[dsh-im-bridge]` 开头的输出。

---

## 二、准备 QQ 端（NapCat）

1. 下载安装 [NapCat](https://github.com/NapNeko/NapCatQQ)（Windows 一键安装），用你的 QQ 号登录。
2. 打开 NapCat 配置（WebUI / `config.json`），开启 **WebSocket 服务器**，监听 `127.0.0.1:3001`：
   - `ws` 端口：`3001`
   - `message_post_format`：**`array`**（推荐，插件兼容 array 与 CQ 字符串两种格式）
   - 如设置 `accessToken`，插件 `qq.accessToken` 填同一个值
3. 插件默认连接 `ws://127.0.0.1:3001`，无需额外改动即可工作。

> 发送文件时，NapCat 需要能访问你机器上的**本地文件路径**（本机运行即满足）。若 NapCat 跑在 Docker/远程容器里，需要共享目录并把文件放到容器可见路径（见 `上传失败` 排查）。

---

## 三、准备微信端（WeChatFerry）

WeChatFerry 是 Windows 下通过 DLL 注入 PC 微信实现收发消息的免费方案（个人微信）。

1. 安装 **微信 3.9.12.17（Windows x64）** 并登录机器人微信号（下载：[wechat-windows-versions](https://github.com/tom-snow/wechat-windows-versions/releases/tag/v3.9.12.17)，关闭自动更新）。
2. 下载 [WeChatFerry 最新 Release](https://github.com/lich0821/WeChatFerry/releases)，解压得到 `wcf.exe`、`sdk.dll` 等文件。
3. 以**管理员身份**运行（把微信注入并启动 RPC 服务）：

   ```powershell
   .\wcf.exe start 10086
   ```

   - 命令口：`127.0.0.1:10086`；消息口：`127.0.0.1:10087`（插件自动连接）。
   - 可多开端口：`wcf.exe start <port>`。
4. 插件默认连接 `127.0.0.1:10086`，启动后日志出现 `WeChat 已连接 (wxid=...)` 即成功。

> 微信收文件依赖 `download_attach` + 微信文件目录（`WeChat Files`）；如果收文件失败，可在配置里手动指定 `wechat.wechatFilesDir`。

---

## 四、配置

插件默认配置见插件内 [`cordis.patch.yml`](cordis.patch.yml)。要修改，把整个 `config:` 块复制到你 profile 的 `cordis.patch.yml`（`C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`）里再改（profile 层覆盖 bundle 层）：

```yaml
- id: dsh-im-bridge
  config:
    enabled: true
    logLevel: 'info'          # info | warn | error | silent
    # stateDir / workspaceRoot 留空 = 默认 $DSH_HOME/im-bridge/...
    systemHint: '...'         # 注入给 agent 的提示词（含 /send 用法）
    qq:
      enabled: true
      wsUrl: 'ws://127.0.0.1:3001'
      accessToken: ''          # 与 NapCat 一致
      selfId: 0                # 0 = 自动获取
      requireMention: true     # 群聊仅被 @ 时回复
      adminOnly: false         # true = 只回 admins 私聊
      admins: []               # 管理员 QQ 号（字符串数组）
      allowedChats: []         # 非空 = 只服务这些 QQ 号/群号
      blockedChats: []         # 黑名单
      maxMessageChars: 4000    # 超长回复自动分段
    wechat:
      enabled: true
      host: '127.0.0.1'
      port: 10086
      requireMention: false    # 群聊仅被 @ / 命中关键词时回复
      triggerKeyword: ''       # 群聊触发词；空且 requireMention=false 则全回
      adminOnly: false
      admins: []
      allowedChats: []
      blockedChats: []
      maxMessageChars: 2000
      wechatFilesDir: ''       # 微信文件目录，空 = 自动探测
```

**群聊回复策略（重要）**：

| 平台 | requireMention | 效果 |
|---|---|---|
| QQ | `true`（默认） | 群里被 @ 才回复 |
| QQ | `false` | 群里所有消息都回复（慎用，可用 allowedChats 限定群） |
| 微信 | `false`（默认）+ 空 triggerKeyword | 所有群消息都回复（慎用！） |
| 微信 | `true` | 被 @（内容含 @机器人名）或命中 triggerKeyword 才回复 |

---

## 五、使用

### 聊天

- 私聊机器人即可对话；群聊按上述策略触发。
- 支持 `@`（QQ 群）、关键词（微信群）。

### 聊天内命令

| 命令 | 说明 |
|---|---|
| `/help` | 帮助 |
| `/status` | 查看桥接状态 / 会话 ID / 工作目录 |
| `/reset` | 重置本聊天会话（开全新上下文），仅管理员 |

### 让 agent 发文件

在提示词里告诉 agent（插件已自动注入），或直接说“把 XX 文件发给我”。agent 会在回复中单独一行写：

```
/send C:\Users\...\report.pdf
```

插件会：
1. 解析出该行 → 校验文件存在（相对路径按会话工作目录解析，支持 `~`）
2. QQ：`upload_private_file` / `upload_group_file`（失败降级 `file` 消息段）
3. 微信：`WCF_SendFile`
4. 把文件从回复文本中剔除，只把剩余文字发出去

### 接收文件

- **QQ**：对方发的文件 / 图片自动下载到 `<会话工作目录>/inbox/`，agent 通过文件工具可读。
- **微信**：图片（type 3）自动解密保存；文件（type 49）`download_attach` 后定位复制到 inbox；链接卡片只转发链接。

### 会话与工作目录

每个聊天的工作目录：`$DSH_HOME/im-bridge/workspaces/<聊天key>/`，例如
`qq_private_123456`、`qq_group_789`、`wx_private_wxid_xxx`、`wx_room_xxx@chatroom`。
映射关系存在 `$DSH_HOME/im-bridge/state/chats.json`，重启不丢。

---

## 六、常见问题

**Q：装上后 `dsh web` 起不来了？**
插件本身不会阻止启动：所有连接都是可选 + 后台重试。若启动失败，请检查 profile 的 `package.json` 是否 JSON 合法（不要用带 BOM 的编辑器保存）、`bundles` 是否写对、`pnpm install` 是否成功。

**Q：日志里 `QQ (ws://...) 连接失败 / wcf 不可达`？**
说明对应端没起来——NapCat 没开 / wcf 没注入。插件每 5 秒重试，不影响 DSH。

**Q：QQ 上传文件失败？**
- NapCat 需能读到该本地路径（本机运行没问题；容器部署需共享目录）。
- 检查文件是否真的存在、路径是否绝对路径。
- 部分 QQ 场景有文件类型/大小限制，可让 agent 先压缩。

**Q：微信收文件失败？**
wcf 的 `download_attach` 需要微信端已登录且消息较新；老消息可能下载不到。可在 `wechat.wechatFilesDir` 指定 `WeChat Files` 目录帮助定位。

**Q：群聊不回？**
检查策略：QQ 默认 `requireMention: true`（没 @ 不回）；微信默认全回，若设置了 `requireMention` 需命中关键词或 @。

**Q：回复乱码 / 表情？**
QQ 的 `face`、`record` 等段只保留 `[表情]` 等占位标记；如需表情渲染可自行扩展。

---

## 免责声明

- 个人微信接入（WeChatFerry / 微信 Hook）仅供学习交流，请遵守微信用户协议与当地法律，**禁止用于骚扰、营销、诈骗等用途**；使用微信 Hook 有一定账号风险，后果自负。
- QQ 机器人请使用合规账号，遵守 QQ 平台规则。
- 本项目与 DeepSeek、腾讯、微信官方无关。

## License

MIT
