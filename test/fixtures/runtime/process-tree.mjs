// Fake runtime for process-runner tests. Usage: node process-tree.mjs <mode> [pidFile]
import { spawn } from "node:child_process";
import fs from "node:fs";

const [mode, pidFile] = process.argv.slice(2);
const childCode = `setInterval(() => {}, 1000); ${"process.stdout.write('');"}`;

function grandchild() {
  // inherits our stdout/stderr, so it keeps the pipes open after we are gone
  const gc = spawn(process.execPath, ["-e", childCode], { stdio: ["ignore", "inherit", "inherit"] });
  if (pidFile) fs.writeFileSync(pidFile, String(gc.pid));
  return gc;
}

if (mode === "detach-exit") {
  // a detached, unref'd child in its own session; we exit 0 after a pause, leaving it behind
  const gc = spawn(process.execPath, ["-e", childCode], { stdio: "ignore", detached: true });
  gc.unref();
  if (pidFile) fs.writeFileSync(pidFile, String(gc.pid));
  setTimeout(() => process.exit(0), Number(process.argv[4] ?? 600));
} else if (mode === "escape") {
  // a descendant in its own process group (setsid-style daemon), invisible to a group kill
  const gc = spawn(process.execPath, ["-e", childCode], { stdio: "ignore", detached: true });
  if (pidFile) fs.writeFileSync(pidFile + ".self", String(process.pid));
  if (pidFile) fs.writeFileSync(pidFile, String(gc.pid));
  setInterval(() => {}, 1000);
} else if (mode === "ok") {
  process.stdout.write('not json\n{"result":"hello","session_id":"s1","usage":{"output_tokens":7}}\n');
} else if (mode === "hang") {
  grandchild();
  setInterval(() => {}, 1000);
} else if (mode === "orphan") {
  grandchild();
  process.stdout.write('{"result":"done early"}\n');
  setTimeout(() => process.exit(0), 50);
} else if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  grandchild();
  if (pidFile) fs.writeFileSync(pidFile + ".self", String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  const chunk = Buffer.alloc(1024 * 1024, "x");
  chunk[chunk.length - 1] = 10; // a line per chunk
  let left = 100;
  const pump = () => {
    while (left > 0) {
      left--;
      if (!process.stdout.write(chunk)) {
        process.stdout.once("drain", pump);
        return;
      }
    }
    process.stdout.write('{"result":"tail result"}\n', () => process.exit(0));
  };
  pump();
} else if (mode === "fail") {
  process.stderr.write("something broke\n");
  process.exit(3);
}
