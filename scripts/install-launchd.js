const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const homeDir = os.homedir();
const projectDir = process.cwd();
const nodePath = process.execPath;
const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDir, "com.nicola.tg-codex-agent.plist");
const outLog = path.join(projectDir, "logs", "launchd.out.log");
const errLog = path.join(projectDir, "logs", "launchd.err.log");

fs.mkdirSync(launchAgentsDir, { recursive: true });
fs.mkdirSync(path.join(projectDir, "logs"), { recursive: true });

const escaped = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nicola.tg-codex-agent</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escaped(nodePath)}</string>
    <string>dist/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${escaped(projectDir)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escaped(`${path.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${escaped(outLog)}</string>

  <key>StandardErrorPath</key>
  <string>${escaped(errLog)}</string>
</dict>
</plist>
`;

fs.writeFileSync(plistPath, plist, "utf8");
console.log(plistPath);
