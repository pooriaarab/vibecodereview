#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibetrace-emit.mjs");
let failed = 0;

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return r;
}

// spawnSync blocks this process's event loop, which would deadlock an
// in-process HTTP server waiting to accept the child's request. Use async
// spawn for any run() that talks to a server started in this test process.
function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcr-emit-"));
const file = path.join(tmp, "traces.jsonl");

const ok = run(
  ["review.council", "--mode", "delta", "--cache-hit", "1", "--members", "4", "--cancelled", "0"],
  {
    VIBETRACE_FILE: file,
    GITHUB_REPOSITORY: "pooriaarab/vibecodereview",
    VCR_PR: "107",
    GITHUB_HEAD_REF: "vcr-107-emit-council",
  },
);
if (ok.status !== 0) {
  console.error("FAIL exit", ok.status, ok.stderr);
  failed++;
} else {
  const line = fs.readFileSync(file, "utf8").trim();
  const rec = JSON.parse(line);
  if (rec.type !== "review.council" || rec.mode !== "delta" || rec.cacheHit !== true) {
    console.error("FAIL record shape", rec);
    failed++;
  } else if (rec.attribution?.issue !== 107 || rec.attribution?.pr !== 107) {
    console.error("FAIL attribution", rec.attribution);
    failed++;
  } else {
    console.log("ok - writes review.council with attribution");
  }
}

const bad = run(["review.council", "--mode", "nope", "--members", "1"], { VIBETRACE_FILE: file });
if (bad.status !== 0) {
  console.error("FAIL bad mode should exit 0", bad.status);
  failed++;
} else if (!/mode must be/.test(bad.stderr + bad.stdout)) {
  console.error("FAIL bad mode message", bad.stderr, bad.stdout);
  failed++;
} else {
  console.log("ok - invalid mode silent-fails with message");
}

const cancelledFile = path.join(tmp, "cancelled.jsonl");
const cancelledRun = run(
  ["review.council", "--mode", "full", "--cache-hit", "0", "--members", "0", "--cancelled", "1"],
  { VIBETRACE_FILE: cancelledFile },
);
if (cancelledRun.status !== 0) {
  console.error("FAIL cancelled exit", cancelledRun.status, cancelledRun.stderr);
  failed++;
} else {
  const rec = JSON.parse(fs.readFileSync(cancelledFile, "utf8").trim());
  if (rec.cancelled !== true) {
    console.error("FAIL cancelled flag", rec);
    failed++;
  } else {
    console.log("ok - records cancelled=1");
  }
}

await new Promise((resolve, reject) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    runAsync(
      ["review.council", "--mode", "full", "--cache-hit", "0", "--members", "2", "--cancelled", "0"],
      { VIBETRACE_INGEST_URL: `http://127.0.0.1:${port}/ingest` },
    ).then((ingestRun) => {
      server.close();
      if (ingestRun.status !== 0) {
        console.error("FAIL ingest exit", ingestRun.status, ingestRun.stderr);
        failed++;
      } else if (received.length !== 1) {
        console.error("FAIL ingest did not receive a POST", ingestRun.stdout, ingestRun.stderr);
        failed++;
      } else {
        const rec = JSON.parse(received[0]);
        if (rec.type !== "review.council" || rec.memberCount !== 2) {
          console.error("FAIL ingest record shape", rec);
          failed++;
        } else if (!/-> ingest$/.test(ingestRun.stdout.trim())) {
          console.error("FAIL ingest destination log", ingestRun.stdout);
          failed++;
        } else {
          console.log("ok - posts review.council to VIBETRACE_INGEST_URL");
        }
      }
      resolve();
    });
  });
  server.on("error", reject);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("vibetrace-emit tests passed");
