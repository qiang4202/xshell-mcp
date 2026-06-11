# Xshell MCP Session Scripts

Create one script per Xshell tab/session:

```powershell
powershell -ExecutionPolicy Bypass -File D:\my-xshell-mcp\xshell\make-session-script.ps1 -SessionId server-a
powershell -ExecutionPolicy Bypass -File D:\my-xshell-mcp\xshell\make-session-script.ps1 -SessionId db-01
```

Then run the generated `.js` file inside the matching Xshell session.

Each script listens on:

```text
C:\Users\80703\Documents\xshell-mcp-bridge\<sessionId>
```
