// 诊断工具：把待检查的命令逐行喂进来，看会被哪条危险命令规则拦下。
//
//   node test/gate-probe.mjs "awk -F: '(\$3==0){print \$1}' /etc/passwd"
//   type commands.txt | node test/gate-probe.mjs
//
// 规则来自编译产物 dist/pure.js，与 MCP server 实际使用的完全一致。
import fs from "node:fs";
import { buildDangerousPatterns } from "../dist/pure.js";

if (!fs.existsSync(new URL("../dist/pure.js", import.meta.url))) {
  console.error("dist/pure.js 不存在，请先运行 npm run build");
  process.exit(2);
}

const fromArgs = process.argv.slice(2);
let commands = fromArgs;

if (commands.length === 0) {
  const stdin = fs.readFileSync(0, "utf8");
  commands = stdin
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

if (commands.length === 0) {
  console.error("用法: node test/gate-probe.mjs <命令>... 或从 stdin 逐行读取");
  process.exit(2);
}

const patterns = buildDangerousPatterns({ builtinRulesEnabled: true });

let blocked = 0;
for (const command of commands) {
  const compact = command.replace(/\s+/g, " ").trim();
  const hits = patterns.filter((pattern) => pattern.test(compact));
  if (hits.length === 0) {
    console.log(`[ok]      ${compact}`);
    continue;
  }
  blocked += 1;
  console.log(`[BLOCKED] ${compact}`);
  for (const hit of hits) {
    console.log(`          rule: ${hit.source}`);
  }
}

console.log(`\n共 ${commands.length} 条，被拦 ${blocked} 条`);
process.exit(blocked === 0 ? 0 : 1);
