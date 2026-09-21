// Fast, engine-independent scan for syntax the Xshell JScript engine rejects
// even though Node accepts it. Runs before the authoritative cscript check so
// failures come with an exact line number.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultFile = path.resolve(here, "..", "xshell", "bridge.js");
const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [defaultFile];

let failures = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`MISSING  ${file}`);
    failures += 1;
    continue;
  }

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const problems = [];

  for (let i = 0; i < lines.length; i += 1) {
    // 1. Trailing comma before } ] ) -- allowed in ES5+, rejected by JScript.
    if (/,\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j += 1;
      if (j < lines.length && /^[}\])]/.test(lines[j].trim())) {
        problems.push(`L${i + 1}: trailing comma before "${lines[j].trim().charAt(0)}" (JScript rejects this)`);
      }
    }
    // 2. ES6+ syntax that JScript cannot parse.
    if (/(^|[^\w.$])=>/.test(lines[i])) {
      problems.push(`L${i + 1}: arrow function`);
    }
    if (/^\s*(let|const)\s/.test(lines[i])) {
      problems.push(`L${i + 1}: let/const declaration`);
    }
    if (lines[i].includes("`")) {
      problems.push(`L${i + 1}: template literal`);
    }
    if (lines[i].includes("??") || lines[i].includes("?.")) {
      problems.push(`L${i + 1}: optional chaining / nullish coalescing`);
    }
  }

  if (problems.length === 0) {
    console.log(`OK        ${path.basename(file)}`);
    continue;
  }

  failures += 1;
  console.log(`FAIL      ${path.basename(file)}`);
  for (const problem of problems) {
    console.log(`          ${problem}`);
  }
}

console.log(`\n${failures === 0 ? "NO JSCRIPT TRAPS" : failures + " FILE(S) WITH ISSUES"}`);
process.exit(failures === 0 ? 0 : 1);
