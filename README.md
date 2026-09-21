# xshell-mcp

`xshell-mcp` 是一个本地 MCP Server，用来让 Codex、Claude Desktop 等 MCP 客户端控制已经打开的 Xshell 终端会话。

它不依赖外部 SSH 库，也不需要重新保存服务器密码。核心思路是：在 Xshell 当前标签页里运行一个桥接脚本，MCP Server 通过本地文件队列把“发送命令、读取屏幕、等待文本”等请求交给 Xshell 执行。

## v0.2 新特性

相比 v0.1，本版本重点修复**堡垒机并发掉线**与**响应慢**两类问题，并扩展了 MCP 工具能力：

- 新增 `xshell_exec_batch` 批处理工具，单次桥接往返串行执行多条命令。
- `xshell_read_screen` 支持 `mode: tail`、`tailRows`、`stripAnsi`、`includeCursor`，**显著降低 token 消耗**。
- `xshell_exec` 默认不再回读整屏（`returnScreen: false`），节省桥接往返。
- bridge.js 轮询 150ms → **50ms**，心跳 5s → **2s**，默认 stale 阈值 15s → **30s**。
- bridge.js `writeFile` 临时文件名加入进程 PID + 随机串，**修复并发请求同毫秒冲突 bug**。
- 新增 `xshell_prune_session` 工具，移除隐式自动删除 stale 会话目录的破坏性行为。
- 服务端 `xshell_list_sessions` / `xshell_status` 内置 1 秒状态缓存，降低文件 IO。
- 审计日志增加 `durationMs` / `responseBytes` / `errorClass`，便于排查。
- 危险命令匹配加 LRU 缓存，patterns 按 length 倒序。
- 新增 HTTP transport：`xshell-mcp --transport=http --port=8765`，便于远程/容器化部署。
- 单元测试覆盖（vitest）：`npm test`。

## 功能

- 列出当前在线的 Xshell 会话。
- 向指定 Xshell 标签页发送文本或命令。
- 读取 Xshell 屏幕缓冲区内容（支持 tail/diff/stripAnsi）。
- 等待终端出现指定文本。
- 串行执行多条命令（`xshell_exec_batch`）。
- 支持 `posix`、`cmd`、`powershell`、`raw` 四种命令完成标记。
- 支持多 Xshell 会话，每个会话使用独立 `sessionId`。
- 默认拦截明显危险命令，例如 `rm -rf`、`shutdown`、`mkfs` 等。
- 写入 `audit.log`，便于排查和审计 agent 执行过的操作。

## 目录结构

```text
xshell-mcp/
├─ src/
│  ├─ server.ts              # MCP Server 源码
│  └─ pure.ts                # 纯函数（被 server.ts 与 test 共享）
├─ test/pure.test.ts         # vitest 单元测试
├─ dist/server.js            # 编译后的 MCP Server
├─ xshell/bridge.js          # 在 Xshell 内运行的桥接脚本
├─ xshell/sessions/*.js      # 可选的固定 sessionId 启动脚本
├─ vitest.config.ts
├─ mcp.example.json          # MCP 客户端配置示例
├─ package.json
└─ README.md
```

## 安装

```powershell
cd D:\mcp\xshell-mcp
npm install
npm run build
```

需要 Node.js 20 或更高版本。

## MCP 客户端配置

把下面配置加入你的 MCP 客户端配置文件，路径按你的本机实际位置调整：

```json
{
  "mcpServers": {
    "xshell": {
      "command": "node",
      "args": [
        "D:\\mcp\\xshell-mcp\\dist\\server.js"
      ],
      "env": {
        "XSHELL_MCP_CONFIG": "D:\\mcp\\xshell-mcp\\xshell-mcp.config.json"
      }
    }
  }
}
```

开发调试时也可以直接运行源码：

```json
{
  "mcpServers": {
    "xshell": {
      "command": "npm",
      "args": [
        "run",
        "dev",
        "--prefix",
        "D:\\mcp\\xshell-mcp"
      ],
      "env": {
        "XSHELL_MCP_CONFIG": "D:\\mcp\\xshell-mcp\\xshell-mcp.config.json"
      }
    }
  }
}
```

### HTTP transport

v0.2 起支持通过 HTTP 暴露 MCP server。修改配置：

```json
{
  "mcpServers": {
    "xshell": {
      "command": "node",
      "args": ["D:\\mcp\\xshell-mcp\\dist\\server.js", "--transport=http", "--port=8765"]
    }
  }
}
```

或通过环境变量：

```json
{
  "env": {
    "XSHELL_MCP_TRANSPORT": "http",
    "XSHELL_MCP_HTTP_PORT": "8765"
  }
}
```

## 项目配置文件

你可以用 JSON 配置文件统一管理桥接目录和禁止发送的命令规则。推荐复制模板：

```powershell
copy D:\mcp\xshell-mcp\xshell-mcp.config.example.json D:\mcp\xshell-mcp\xshell-mcp.config.json
```

v0.2 配置示例：

```json
{
  "bridgeRootDir": "C:\\Users\\<your-user>\\Documents\\xshell-mcp-bridge",
  "defaultSessionId": "default",
  "sessionStaleAfterMs": 30000,
  "statusCacheTtlMs": 1000,
  "pollMs": 30,
  "transport": "stdio",
  "httpPort": 8765,
  "dangerousCommands": {
    "builtinRulesEnabled": true,
    "blockedPatterns": [
      "\\bcurl\\b.*\\|\\s*(sh|bash)\\b",
      "\\bwget\\b.*\\|\\s*(sh|bash)\\b"
    ],
    "blockedLiterals": [
      "rm -rf /",
      "format c:"
    ]
  }
}
```

配置读取优先级：

1. `XSHELL_MCP_CONFIG` 指定的配置文件。
2. 当前工作目录下的 `xshell-mcp.config.json`。
3. 程序内置默认值。

字段说明：

- `bridgeRootDir`：桥接根目录，等价于环境变量 `XSHELL_MCP_BRIDGE_DIR`。
- `defaultSessionId`：默认会话 ID，等价于 `XSHELL_MCP_DEFAULT_SESSION`。
- `sessionStaleAfterMs`：心跳多久没更新后判定会话离线，默认 30000。等价于 `XSHELL_MCP_SESSION_STALE_AFTER_MS`。
- `statusCacheTtlMs`：`xshell_list_sessions` / `xshell_status` 状态缓存 TTL。
- `pollMs`：server 端轮询响应文件的间隔（毫秒）。
- `transport`：MCP 传输协议，`stdio` 或 `http`，等价于 `XSHELL_MCP_TRANSPORT`。
- `httpPort`：HTTP 模式监听端口，等价于 `XSHELL_MCP_HTTP_PORT`。
- `dangerousCommands.builtinRulesEnabled`：是否启用内置危险命令拦截规则。
- `dangerousCommands.blockedPatterns`：自定义正则规则，命中后禁止发送。
- `dangerousCommands.blockedLiterals`：自定义固定文本规则，会按普通字符串匹配，不需要写正则转义。

推荐 MCP 客户端只配置 `XSHELL_MCP_CONFIG`，然后在 `xshell-mcp.config.json` 里维护 `bridgeRootDir`。这样 MCP Server 和 Xshell 里的 `bridge.js` 会读取同一个桥接目录配置，避免两边路径不一致。

环境变量仍然可以覆盖配置文件里的同名基础设置，例如 `XSHELL_MCP_BRIDGE_DIR` 会覆盖 `bridgeRootDir`。一般情况下不需要再配置它。

## 启动 Xshell 桥接脚本

**推荐做法：先生成启动器，再在 Xshell 里运行启动器。**

```powershell
cd D:\mcp\xshell-mcp
powershell -ExecutionPolicy Bypass -File xshell\make-session-script.ps1 -SessionId default
```

生成的文件 `xshell\sessions\default.js` 会把**绝对路径**写死进 `CONFIG_PATH_OVERRIDE`，bridge.js 拿到它就直接读配置，不做任何猜测：

```text
D:\mcp\xshell-mcp\xshell\sessions\default.js
```

在 Xshell 对应标签页里运行这一行即可。

### 直接运行 bridge.js（不推荐，仅在启动器不可用时）

```text
D:\mcp\xshell-mcp\xshell\bridge.js
```

此时 bridge.js 按下面的顺序自己找 `xshell-mcp.config.json`：

1. `CONFIG_PATH_OVERRIDE`（启动器注入的变量）
2. 环境变量 `XSHELL_MCP_CONFIG`（进程 → 用户 → 系统作用域依次尝试）
3. `XSHELL_MCP_BRIDGE_SCRIPT` 环境变量反推脚本所在目录
4. 扫描各盘符下的常见安装位置：`<盘>:\mcp\xshell-mcp`、`<盘>:\my-xshell-mcp`、`<盘>:\xshell-mcp`、`<盘>:\code\xshell-mcp`

找到配置后，`bridgeRootDir` 的取值顺序为：`BRIDGE_ROOT_DIR_OVERRIDE` → 配置文件里的 `bridgeRootDir` → `%USERPROFILE%\Documents\xshell-mcp-bridge` → `%TEMP%\xshell-mcp-bridge`。

**注意**：bridge.js 不会再把目录建到 Xshell 的会话目录（`...\NetSarang Computer\7\Xshell\Sessions`）——如果发现目录出现在那里，说明配置没被读到，请看下面的自检方法。

### 启动自检

bridge 启动时会弹一个对话框，直接显示解析结果：

```text
Xshell MCP bridge started.
Version: plain-js-20260921-2
Host: <计算机名>
Session: default
Bridge root: D:\mcp\xshell-mcp-bridge
Bridge dir: D:\mcp\xshell-mcp-bridge\default
Config: D:\mcp\xshell-mcp\xshell-mcp.config.json
Poll: 50ms

--- resolution ---
config: CONFIG_PATH_OVERRIDE
bridgeRoot: from config -> D:\mcp\xshell-mcp-bridge
```

看两行就够：

- `Config:` 必须是真实存在的配置文件路径，不能是 `(not found)`。
- `Bridge root:` 必须是你期望的目录，不能是 Xshell 的会话目录。

启动成功后桥接脚本写入状态文件：

```text
D:\mcp\xshell-mcp-bridge\<sessionId>\status.json
```

`status.json` 字段：`version`、`sessionId`、`startedAt`、`lastSeenAt`、`bridgeDir`、`bridgeRootDir`、`bridgeScriptPath`、`hostname`、`pollMs`、`totalHandled`、`totalFailed`，便于排查多机部署。

## 多会话用法

默认情况下，桥接脚本会尝试从 Xshell 的会话名、标签名或远端地址自动识别 `sessionId`。如果你想固定会话名，可以生成专用启动脚本：

```powershell
powershell -ExecutionPolicy Bypass -File D:\mcp\xshell-mcp\xshell\make-session-script.ps1 -SessionId server-a
powershell -ExecutionPolicy Bypass -File D:\mcp\xshell-mcp\xshell\make-session-script.ps1 -SessionId db-01
```

然后在对应的 Xshell 标签页中运行：

```text
D:\mcp\xshell-mcp\xshell\sessions\server-a.js
D:\mcp\xshell-mcp\xshell\sessions\db-01.js
```

## 可用工具

### xshell_list_sessions

列出当前桥接目录下在线的 Xshell 会话。v0.2 新增 `includeStale` 参数（默认 false），为 true 时包含 stale 会话。

```text
xshell_list_sessions()
xshell_list_sessions({ "includeStale": true })
```

### xshell_prune_session

显式删除一个会话的桥接目录（当 Xshell 标签已关闭时可调用）。

```text
xshell_prune_session({ "sessionId": "server-a" })
```

### xshell_status

查看指定会话的桥接目录、请求目录、响应目录、心跳状态。**走 1 秒缓存**。

```text
xshell_status({ "sessionId": "172.31.102.67" })
```

### xshell_send

向 Xshell 发送文本，可选择是否追加回车。

```text
xshell_send({
  "sessionId": "172.31.102.67",
  "text": "pwd",
  "appendEnter": true
})
```

### xshell_read_screen

读取 Xshell 当前屏幕缓冲区。v0.2 新参数：

- `mode`：`"full"`（默认）或 `"tail"`。
- `tailRows`：tail 模式保留的行数，默认 30。
- `stripAnsi`：是否剥离 ANSI 转义码（颜色、标题等），默认 `true`。
- `includeCursor`：是否返回 `cursorRow=...`，默认 `false`。

```text
xshell_read_screen({ "sessionId": "172.31.102.67", "mode": "tail", "tailRows": 20, "stripAnsi": true })
```

### xshell_wait_for

等待屏幕中出现指定文本。v0.2 改为**半轮询**（50ms 起步 + 200ms 周期），避免长时间阻塞同一会话的其他请求。

```text
xshell_wait_for({
  "sessionId": "172.31.102.67",
  "text": "$",
  "timeoutMs": 30000
})
```

### xshell_exec

发送命令，等待完成标记，并返回输出的尾部。

- `returnScreen`：默认 `true`。
- `screenTailRows`：默认 40，控制回传的屏幕行数（只取尾部，避免整屏 token 浪费）。
- `recoverOnTimeout`：默认 `true`。超时后自动发 `Ctrl+C` 把 shell 拉回提示符。

```text
xshell_exec({
  "sessionId": "172.31.102.67",
  "command": "uname -a",
  "shellType": "posix",
  "timeoutMs": 30000
})

xshell_exec({
  "sessionId": "172.31.102.67",
  "command": "systemctl status myapp --no-pager",
  "shellType": "posix",
  "screenTailRows": 60,
  "recoverOnTimeout": true,
  "timeoutMs": 30000
})
```

### xshell_exec_batch（v0.2 新增）

单次桥接往返串行执行多条命令，每项独立等待自己的完成标记。

- **未指定 `waitFor` 时自动生成唯一完成标记**，因此每项都会真正等到命令结束。
- **单项超时不再中断整批**，失败项在结果里标 `FAILED` 并带上原因。
- `items` 接受多种形状：真数组、`{"item":[...]}`、`{"items":[...]}`、JSON 字符串、单个命令对象。
- 返回的是可读文本报告（`[1/3] ok` + 该项输出尾部），不是一大坨 JSON。

```text
xshell_exec_batch({
  "sessionId": "172.31.102.67",
  "items": [
    { "command": "cd /opt/app", "shellType": "posix" },
    { "command": "git pull", "shellType": "posix", "timeoutMs": 60000 },
    { "command": "systemctl restart myapp", "shellType": "posix", "timeoutMs": 30000 }
  ],
  "defaultTimeoutMs": 30000,
  "defaultShellType": "posix"
})
```

### xshell_interrupt

向会话发送 `Ctrl+C`，把卡住的终端（命令没返回、或停在 `less`/`top`/`vi` 等交互程序里）拉回提示符。这是**手动逃生口**。

```text
xshell_interrupt({ "sessionId": "172.31.102.67", "times": 2 })
xshell_interrupt({ "sessionId": "172.31.102.67", "times": 2, "waitForPromptAfterMs": 800 })
```

### xshell_bridge_stop

让 bridge 脚本退出它的循环，**释放 Xshell 标签页**（重跑 bridge 前必须先做这一步，因为 bridge 是死循环，会一直占着标签页）。

```text
xshell_bridge_stop({ "sessionId": "172.31.102.67" })
```

停掉之后，在对应标签页重新运行 `xshell/sessions/<id>.js` 即可恢复。

## 卡住了怎么恢复

排查顺序：

1. **先看还活着没**。`xshell_list_sessions({ "includeStale": true })` 看 `liveness.ageMs`。小于 30 秒说明 bridge 活着；很大或没有该会话说明 bridge 已停。
2. **活着但每条命令都超时** → 终端多半停在交互程序里或被占用。调 `xshell_interrupt` 发 Ctrl+C（可带 `waitForPromptAfterMs` 顺带回读屏幕确认）。
3. **`xshell_interrupt` 也没反应** → 用 `xshell_bridge_stop` 让循环退出，然后在 Xshell 标签页重新运行 `sessions/<id>.js`。
4. **`xshell_bridge_stop` 也超时** → bridge 已经死了（脚本终止，不再轮询请求）。直接在 Xshell 里手动停止脚本（脚本 → 停止）再重跑启动器。
5. **看日志定位原因**：`D:\mcp\xshell-mcp-bridge\<sessionId>\logs\bridge.log`。里面会记录 `loop error`、`sent Ctrl+C`、`bridge stopped by request` 等。`status.json` 里的 `totalRecovered` 表示发生过几次超时恢复。

v0.2.1 起，以下情况**不会再导致 bridge 永久失联**：

- `sleep` 抛异常（以前会直接终止脚本）—— 现在整轮循环都有保护，异常只记日志。
- 命令超时后 shell 停在坏状态 —— 现在会自动发 Ctrl+C 回收提示符（可用 `recoverOnTimeout: false` 关掉）。
- bridge 心跳 stale 时，工具调用**立即返回明确错误**并告诉你怎么恢复，不再让你干等 30 秒。

## 与 Xshell 的交互原理

整体由两部分组成：

```text
MCP Client
   |
   | 调用 xshell_send / xshell_exec / xshell_read_screen
   v
Node.js MCP Server
   |
   | 写入 JSON 请求文件
   v
%USERPROFILE%\Documents\xshell-mcp-bridge\<sessionId>\requests
   |
   | Xshell bridge.js 轮询读取（50ms）
   v
Xshell 脚本运行时
   |
   | 调用 xsh.Screen.Send / xsh.Screen.Get
   v
当前 Xshell 终端会话
   |
   | 写入 JSON 响应文件
   v
%USERPROFILE%\Documents\xshell-mcp-bridge\<sessionId>\responses
   |
   v
Node.js MCP Server 返回结果给 MCP Client
```

具体流程：

1. MCP Server 启动后，暴露 `xshell_*` 工具。
2. 用户在 Xshell 标签页中运行 `xshell/bridge.js`。
3. `bridge.js` 创建会话目录，并定期更新 `status.json` 心跳（2 秒一次）。
4. 当 MCP Client 调用工具时，`server.ts` 会生成一个唯一请求 ID，并把请求写入 `requests/<id>.json`。
5. Xshell 内的 `bridge.js` 每隔 50ms 扫描请求目录。
6. 发现请求后，桥接脚本根据 `op` 执行动作：
   - `send`：调用 `xsh.Screen.Send()` 发送文本。
   - `read_screen`：调用 `xsh.Screen.Get()` 读取屏幕文本。
   - `wait_for`：循环读取屏幕，直到出现指定文本或超时。
   - `exec`：发送命令，追加完成标记，然后等待标记出现。
   - `batch`：串行执行多条命令。
7. 桥接脚本把结果写入 `responses/<id>.json`。
8. MCP Server 读取响应文件，删除响应文件，并把结果返回给 MCP Client。

## 编码约定

这里有一个很重要的兼容点：

- MCP Server 写入请求 JSON 使用 `utf8`。
- Xshell 桥接脚本读取请求时使用 `OpenTextFile(..., 0)`，按系统默认文本读取，兼容 ASCII/UTF-8 请求内容。
- Xshell 桥接脚本写入响应和状态时使用 `OpenTextFile(..., -1)`，写入 Unicode 文本。
- MCP Server 读取响应和状态时使用 `utf16le`。

如果请求读取也使用 `-1`，Xshell 会把 UTF-8 请求误读成 UTF-16，从而在解析 JSON 时出现“无效字符”。

同一个坑还有第二处：**会话启动器读取 `bridge.js` 源码时必须用 `0`。**

```js
// xshell/sessions/<id>.js —— 正确
eval(new ActiveXObject("Scripting.FileSystemObject")
  .OpenTextFile("...\\bridge.js", 1, false, 0).ReadAll());
```

`bridge.js` 是 ASCII/UTF-8 且无 BOM。若这里写成 `-1`（TristateTrue/Unicode），FSO 会把 ASCII 字节当 UTF-16 解读，`eval()` 拿到的就是一串乱码，Xshell 报 **“缺少标识符”**。实测对比：

| format | 读同一份 ASCII 文件 | 结果 |
|---|---|---|
| `0` (TristateFalse) | 42 字符，原文正确 | ✅ |
| `-1` (TristateTrue) | 21 字符，`24950 8306 17747...` 乱码 | ❌ |
| `-2` (TristateUseDefault) | 42 字符，原文正确 | ✅ |

## JScript 兼容性约束

`xshell/bridge.js` 跑在 Xshell 的 JScript 引擎里（ES3 时代），**TypeScript/Node 能编译不代表 JScript 能解析**。已踩过的坑：

- **对象字面量 / 函数实参的尾随逗号**（`{ a: 1, }`、`f(a, )`）——JScript 不支持，报“缺少标识符、字符串或数字”，并指向紧随其后的 `}` 或 `)`。
- 箭头函数、`let` / `const`、模板字符串、可选链 `?.`、空值合并 `??`。

改完 `bridge.js` 请务必跑：

```powershell
npm run test:xshell   # 快速：语法陷阱扫描 + JScript 引擎真实解析 + 行为功能测试
```

`test:xshell` 做三件事：

1. `find-js-traps.mjs` —— 静态扫描上述陷阱，直接给出**行号**。
2. `jscript-parse.mjs` —— 调用 Windows 的 JScript 引擎（与 Xshell 同一个）真实解析 `bridge.js` 与全部启动器；同时校验 `bridge.js` 无 UTF-16 BOM、全 CRLF。
3. `jscript-bridge.mjs` —— 在 JScript 引擎里**真的运行 bridge.js**（stub 掉 `xsh` 宿主），喂请求文件、断言响应，覆盖 exec 等待、批处理自动生成完成标记、单项超时不中断整批等行为。

`npm test` 会依次跑完上面三项，再跑 vitest 与路径解析检查。

## 审计日志

每个会话目录下的 `audit.log` 是 JSONL 格式，每行一条记录。v0.2 起每条记录包含：

- `timestamp`：UTC ISO-8601。
- `sessionId`：会话标识。
- `tool`：工具名。
- `status`：`started` / `completed` / `failed`。
- `durationMs`：工具执行总耗时。
- `responseBytes`：响应字节数（用于评估 token 消耗）。
- `errorClass`：`timeout` / `blocked_command` / `bridge_error` / `internal_error`。

bridge 端日志写入 `<sessionId>/logs/bridge.log`，包含桥接自身错误（轮询异常、未知 op 等）。

## 安全说明

- 这个 MCP 会向真实终端发送输入，等同于给 agent 一只键盘。
- 不建议在生产服务器上无审查使用。
- 默认会拦截一些明显危险命令，但这不是完整安全沙箱。
- 如需执行高风险命令，必须显式设置 `allowDangerous: true`。
- 每个会话目录下有 `audit.log`，可查看调用历史。

## 测试

```powershell
npm install
npm test
```

测试覆盖 `src/pure.ts` 中的纯函数：字符串处理、shell quote、liveness 计算、ANSI 剥离、危险命令匹配等。

## 常见问题

### xshell_list_sessions 为空

检查：

- Xshell 中是否已经运行 `D:\mcp\xshell-mcp\xshell\sessions\default.js`（或 `bridge.js`）。
- bridge 启动对话框里的 `Config:` 是否为真实路径、`Bridge root:` 是否指向 `D:\mcp\xshell-mcp-bridge`。
- `XSHELL_MCP_CONFIG` 是否指向正确配置文件，且配置里的 `bridgeRootDir` 是否和 Xshell 脚本读取的一致。
- `status.json` 是否仍在更新（v0.2 心跳 2 秒一次，stale 阈值默认 30 秒）。
- 调用 `xshell_list_sessions({ "includeStale": true })` 看是否只是 stale 被过滤掉了。

### 桥接目录被建到了 Xshell 的会话目录

现象：`C:\Users\<你>\Documents\NetSarang Computer\7\Xshell\Sessions\xshell-mcp-bridge` 出现。

含义：bridge.js 没能找到 `xshell-mcp.config.json`，退化成了相对路径。

处理：

1. 确认 `D:\mcp\xshell-mcp\xshell-mcp.config.json` 存在。
2. 改用启动器运行：`D:\mcp\xshell-mcp\xshell\sessions\default.js`（它会把绝对路径注入 `CONFIG_PATH_OVERRIDE`）。
3. 或设置用户级环境变量后重开 Xshell：

```powershell
setx XSHELL_MCP_CONFIG "D:\mcp\xshell-mcp\xshell-mcp.config.json"
```

4. 删掉误建的目录：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\Documents\NetSarang Computer\7\Xshell\Sessions\xshell-mcp-bridge"
```

### 调用工具超时

检查：

- `requests` 目录里是否残留旧请求。
- `responses` 目录是否生成响应。
- Xshell 终端是否处于可输入状态。
- `waitFor` 是否设置成了不会出现的文本。
- `D:\mcp\xshell-mcp-bridge\<sessionId>\logs\bridge.log` 是否有异常记录。

### 出现“无效字符”

通常是编码或脚本运行方式问题：

- 确认运行的是最新版本 `D:\mcp\xshell-mcp\xshell\bridge.js`，不是旧副本。
- 确认脚本文件使用 CRLF 换行。
- 确认 `readFile()` 读取请求使用 `OpenTextFile(filePath, 1, false, 0)`。

### xshell_exec 卡住

可能是完成标记没有出现。可以改用 `raw` 模式并指定 shell 提示符：

```text
xshell_exec({
  "command": "show version",
  "shellType": "raw",
  "waitFor": "#"
})
```

### 堡垒机多目标无法区分

v0.1 的 bridge 通过 Xshell 的 `SessionName` / `TabText` 识别会话，堡垒机场景下多台目标会落到同一个会话目录。这是已知限制。v0.3 计划引入**二级会话 ID**（`sessionId/subtarget`），允许用户主动声明当前堡垒机内目标。详见 CHANGELOG。

### 并发请求偶发失败

v0.2 起 bridge 的 `writeFile` 使用 PID + 随机串作为临时文件名后缀，**修复了同毫秒并发冲突**。如果仍遇到丢请求，先看 `bridge.log` 是否有轮询异常。
