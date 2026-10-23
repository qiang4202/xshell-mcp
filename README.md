# xshell-mcp

让 AI 通过 MCP 控制已经打开的 Xshell 终端。桥接脚本运行在 Xshell 标签页内，MCP Server 通过本地文件队列收发请求。

## 目录

```text
src/server.ts                    MCP Server 源码
src/pure.ts                      纯函数
xshell/bridge.js                 Xshell 内运行的桥接脚本
xshell/make-session-script.ps1   生成启动器
xshell/sessions/bastion.js       交互式启动器（运行后输入目标名）
xshell-mcp.config.json           运行时配置
```

## 安装与构建

```powershell
npm install
npm run build
```

## MCP 客户端配置

```json
{
  "mcpServers": {
    "xshell": {
      "command": "node",
      "args": ["D:\\code\\xshell-mcp\\dist\\server.js"],
      "env": {
        "XSHELL_MCP_CONFIG": "D:\\code\\xshell-mcp\\xshell-mcp.config.json"
      }
    }
  }
}
```

## 在 Xshell 里启动桥接

每个标签页运行一次：

```text
D:\code\xshell-mcp\xshell\sessions\bastion.js
```

运行后会弹输入框，输入该标签页对应的目标名（如 `web-01`）。启动信息显示 `Session: web-01 (prompt)` 即成功。

`bastion.js` 里写死了绝对路径；如果项目移动，重新生成：

```powershell
powershell -ExecutionPolicy Bypass -File D:\code\xshell-mcp\xshell\make-session-script.ps1 -Interactive
```

固定名字的启动器：

```powershell
powershell -ExecutionPolicy Bypass -File D:\code\xshell-mcp\xshell\make-session-script.ps1 -SessionId web-01
```

然后运行生成的 `xshell\sessions\web-01.js`。

## 堡垒机多目标

- 每个标签页用不同名字，MCP 里按 `sessionId` 独立操作。
- 在 `xshell-mcp.config.json` 的 `sessionLabels` 里维护 ID → 真实机器映射：

```json
"sessionLabels": {
  "web-01": "生产 Nginx 10.0.1.11",
  "db-02": "生产 MySQL 10.0.2.12"
}
```

`xshell_list_sessions` 会返回 `sessionId`、`label`、`displayName`、`sessionSource`。

## 说明

- `xshell-mcp.config.json` 的 `bridgeRootDir` 当前指向 `D:\\mcp\\xshell-mcp-bridge`，与运行副本共用会话数据；如需独立，改成自己的目录。
- 若以后把本项目放进 git，保留 `.gitattributes`（它保证 UTF-16 启动器不被换行转换破坏）。
