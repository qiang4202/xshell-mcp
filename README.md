# xshell-mcp

`xshell-mcp` 是一个本地 MCP Server，用来让 Codex、Claude Desktop 等 MCP 客户端控制已经打开的 Xshell 终端会话。

它不依赖外部 SSH 库，也不需要重新保存服务器密码。核心思路是：在 Xshell 当前标签页里运行一个桥接脚本，MCP Server 通过本地文件队列把“发送命令、读取屏幕、等待文本”等请求交给 Xshell 执行。

## 功能

- 列出当前在线的 Xshell 会话。
- 向指定 Xshell 标签页发送文本或命令。
- 读取 Xshell 屏幕缓冲区内容。
- 等待终端出现指定文本。
- 支持 `posix`、`cmd`、`powershell`、`raw` 四种命令完成标记。
- 支持多 Xshell 会话，每个会话使用独立 `sessionId`。
- 默认拦截明显危险命令，例如 `rm -rf`、`shutdown`、`mkfs` 等。
- 写入 `audit.log`，便于排查和审计 agent 执行过的操作。

## 目录结构

```text
xshell-mcp/
├─ src/server.ts              # MCP Server 源码
├─ dist/server.js             # 编译后的 MCP Server
├─ xshell/bridge.js           # 在 Xshell 内运行的桥接脚本
├─ xshell/sessions/*.js       # 可选的固定 sessionId 启动脚本
├─ mcp.example.json           # MCP 客户端配置示例
├─ package.json
└─ README.md
```

## 安装

```powershell
cd D:\my-xshell-mcp
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
        "D:\\my-xshell-mcp\\dist\\server.js"
      ],
      "env": {
        "XSHELL_MCP_CONFIG": "D:\\my-xshell-mcp\\xshell-mcp.config.json",
        "XSHELL_MCP_BRIDGE_DIR": "C:\\Users\\80703\\Documents\\xshell-mcp-bridge",
        "XSHELL_MCP_DEFAULT_SESSION": "default"
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
        "D:\\my-xshell-mcp"
      ],
      "env": {
        "XSHELL_MCP_CONFIG": "D:\\my-xshell-mcp\\xshell-mcp.config.json",
        "XSHELL_MCP_BRIDGE_DIR": "C:\\Users\\80703\\Documents\\xshell-mcp-bridge",
        "XSHELL_MCP_DEFAULT_SESSION": "default"
      }
    }
  }
}
```

## 项目配置文件

你可以用 JSON 配置文件统一管理桥接目录和禁止发送的命令规则。推荐复制模板：

```powershell
copy D:\my-xshell-mcp\xshell-mcp.config.example.json D:\my-xshell-mcp\xshell-mcp.config.json
```

然后按需编辑：

```json
{
  "bridgeRootDir": "C:\\Users\\80703\\Documents\\xshell-mcp-bridge",
  "defaultSessionId": "default",
  "sessionStaleAfterMs": 15000,
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
- `sessionStaleAfterMs`：心跳多久没更新后判定会话离线，等价于 `XSHELL_MCP_SESSION_STALE_AFTER_MS`。
- `dangerousCommands.builtinRulesEnabled`：是否启用内置危险命令拦截规则。
- `dangerousCommands.blockedPatterns`：自定义正则规则，命中后禁止发送。
- `dangerousCommands.blockedLiterals`：自定义固定文本规则，会按普通字符串匹配，不需要写正则转义。

环境变量会覆盖配置文件里的同名基础设置，例如 `XSHELL_MCP_BRIDGE_DIR` 会覆盖 `bridgeRootDir`。

## 启动 Xshell 桥接脚本

1. 打开 Xshell。
2. 连接到你希望 agent 控制的服务器。
3. 在 Xshell 中运行脚本：

```text
D:\my-xshell-mcp\xshell\bridge.js
```

启动成功后，桥接脚本会在本地目录写入状态文件：

```text
C:\Users\80703\Documents\xshell-mcp-bridge\<sessionId>\status.json
```

MCP Server 会根据 `status.json` 的心跳判断会话是否在线。

## 多会话用法

默认情况下，桥接脚本会尝试从 Xshell 的会话名、标签名或远端地址自动识别 `sessionId`。如果你想固定会话名，可以生成专用启动脚本：

```powershell
powershell -ExecutionPolicy Bypass -File D:\my-xshell-mcp\xshell\make-session-script.ps1 -SessionId server-a
powershell -ExecutionPolicy Bypass -File D:\my-xshell-mcp\xshell\make-session-script.ps1 -SessionId db-01
```

然后在对应的 Xshell 标签页中运行：

```text
D:\my-xshell-mcp\xshell\sessions\server-a.js
D:\my-xshell-mcp\xshell\sessions\db-01.js
```

## 可用工具

### xshell_list_sessions

列出当前桥接目录下在线的 Xshell 会话。

示例：

```text
xshell_list_sessions()
```

### xshell_status

查看指定会话的桥接目录、请求目录、响应目录、心跳状态。

示例：

```text
xshell_status({ "sessionId": "172.31.102.67" })
```

### xshell_send

向 Xshell 发送文本，可选择是否追加回车。

示例：

```text
xshell_send({
  "sessionId": "172.31.102.67",
  "text": "pwd",
  "appendEnter": true
})
```

### xshell_read_screen

读取 Xshell 当前屏幕缓冲区。

示例：

```text
xshell_read_screen({
  "sessionId": "172.31.102.67",
  "rows": 60,
  "columns": 200
})
```

### xshell_wait_for

等待屏幕中出现指定文本。

示例：

```text
xshell_wait_for({
  "sessionId": "172.31.102.67",
  "text": "$",
  "timeoutMs": 30000
})
```

### xshell_exec

发送命令，并等待完成标记或指定文本出现。

Linux/Unix shell 示例：

```text
xshell_exec({
  "sessionId": "172.31.102.67",
  "command": "uname -a",
  "shellType": "posix",
  "timeoutMs": 30000
})
```

Windows CMD 示例：

```text
xshell_exec({
  "sessionId": "windows-host",
  "command": "dir",
  "shellType": "cmd",
  "timeoutMs": 30000
})
```

网络设备或不支持命令拼接的 shell，可以使用 `raw` 并手动指定等待标记：

```text
xshell_exec({
  "sessionId": "router-1",
  "command": "show version",
  "shellType": "raw",
  "waitFor": "#",
  "timeoutMs": 30000
})
```

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
C:\Users\80703\Documents\xshell-mcp-bridge\<sessionId>\requests
   |
   | Xshell bridge.js 轮询读取
   v
Xshell 脚本运行时
   |
   | 调用 xsh.Screen.Send / xsh.Screen.Get
   v
当前 Xshell 终端会话
   |
   | 写入 JSON 响应文件
   v
C:\Users\80703\Documents\xshell-mcp-bridge\<sessionId>\responses
   |
   v
Node.js MCP Server 返回结果给 MCP Client
```

具体流程：

1. MCP Server 启动后，暴露 `xshell_*` 工具。
2. 用户在 Xshell 标签页中运行 `xshell/bridge.js`。
3. `bridge.js` 创建会话目录，并定期更新 `status.json` 心跳。
4. 当 MCP Client 调用工具时，`server.ts` 会生成一个唯一请求 ID，并把请求写入 `requests/<id>.json`。
5. Xshell 内的 `bridge.js` 每隔约 150ms 扫描请求目录。
6. 发现请求后，桥接脚本根据 `op` 执行动作：
   - `send`：调用 `xsh.Screen.Send()` 发送文本。
   - `read_screen`：调用 `xsh.Screen.Get()` 读取屏幕文本。
   - `wait_for`：循环读取屏幕，直到出现指定文本或超时。
   - `exec`：发送命令，追加完成标记，然后等待标记出现。
7. 桥接脚本把结果写入 `responses/<id>.json`。
8. MCP Server 读取响应文件，删除响应文件，并把结果返回给 MCP Client。

## 编码约定

这里有一个很重要的兼容点：

- MCP Server 写入请求 JSON 使用 `utf8`。
- Xshell 桥接脚本读取请求时使用 `OpenTextFile(..., 0)`，按系统默认文本读取，兼容 ASCII/UTF-8 请求内容。
- Xshell 桥接脚本写入响应和状态时使用 `OpenTextFile(..., -1)`，写入 Unicode 文本。
- MCP Server 读取响应和状态时使用 `utf16le`。

如果请求读取也使用 `-1`，Xshell 会把 UTF-8 请求误读成 UTF-16，从而在解析 JSON 时出现“无效字符”。

## 安全说明

- 这个 MCP 会向真实终端发送输入，等同于给 agent 一只键盘。
- 不建议在生产服务器上无审查使用。
- 默认会拦截一些明显危险命令，但这不是完整安全沙箱。
- 如需执行高风险命令，必须显式设置 `allowDangerous: true`。
- 每个会话目录下有 `audit.log`，可查看调用历史。

## 常见问题

### xshell_list_sessions 为空

检查：

- Xshell 中是否已经运行 `D:\my-xshell-mcp\xshell\bridge.js`。
- `XSHELL_MCP_BRIDGE_DIR` 是否和脚本里的桥接目录一致。
- `status.json` 是否仍在更新。

### 调用工具超时

检查：

- `requests` 目录里是否残留旧请求。
- `responses` 目录是否生成响应。
- Xshell 终端是否处于可输入状态。
- `waitFor` 是否设置成了不会出现的文本。

### 出现“无效字符”

通常是编码或脚本运行方式问题：

- 确认运行的是 `D:\my-xshell-mcp\xshell\bridge.js`，不是旧副本。
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
