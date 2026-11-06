import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const files = [
  ...new Set(
    execFileSync(
      "git",
      [
        "-c",
        "core.excludesFile=.gitignore",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean),
  ),
];
const forbidden =
  /(^|\/)(\.env(?:\..*)?|\.aws|\.ssh|node_modules|dist|test-results|\.local|\.npm-cache|\.npm-logs)(\/|$)|\.(?:pdf|pem|key|p12|pfx|vault)(?:\.json)?$/i;
const secrets = [
  /(?:gh[pousr]_|github_pat_|sk-proj-|sk-ant-)[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
let failed = false;
for (const file of files) {
  if (forbidden.test(file)) {
    console.error(`Excluded content is staged or visible: ${file}`);
    failed = true;
    continue;
  }
  if (/\.(png|jpg|webp|svg|ico)$/i.test(file)) continue;
  const data = await readFile(file, "utf8");
  if (secrets.some((re) => re.test(data))) {
    console.error(
      `Potential credential in ${file}. Inspect privately before publishing.`,
    );
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else
  console.log(
    `Checked ${files.length} candidate source files. No forbidden document/key paths or recognized credential patterns found. Review remains necessary; pattern scans cannot establish that every file is non-sensitive.`,
  );
