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

const bodyFile = path.join(tmp, "body-fallback.jsonl");
const bodyRun = run(
  ["review.council", "--mode", "full", "--members", "1"],
  {
    VIBETRACE_FILE: bodyFile,
    GITHUB_HEAD_REF: "feature/vibetrace",
    VCR_PR_BODY: "Some context.\n\nCloses #107\n",
  },
);
if (bodyRun.status !== 0) {
  console.error("FAIL body-fallback exit", bodyRun.status, bodyRun.stderr);
  failed++;
} else {
  const rec = JSON.parse(fs.readFileSync(bodyFile, "utf8").trim());
  if (rec.attribution?.issue !== 107) {
    console.error("FAIL body-fallback issue", rec.attribution);
    failed++;
  } else {
    console.log("ok - falls back to issue number parsed from PR body");
  }
}

const runnerTemp = path.join(tmp, "runner-temp");
const runnerFallback = run(["review.council", "--mode", "full", "--members", "1"], {
  RUNNER_TEMP: runnerTemp,
  VIBETRACE_FILE: "",
  VIBETRACE_INGEST_URL: "",
});
const runnerFallbackFile = path.join(runnerTemp, "vibetrace-traces.jsonl");
if (runnerFallback.status !== 0) {
  console.error("FAIL RUNNER_TEMP fallback exit", runnerFallback.status, runnerFallback.stderr);
  failed++;
} else if (!fs.existsSync(runnerFallbackFile) || !fs.readFileSync(runnerFallbackFile, "utf8").trim()) {
  console.error("FAIL RUNNER_TEMP fallback did not append JSONL", runnerFallback.stdout, runnerFallback.stderr);
  failed++;
} else {
  console.log("ok - appends JSONL under RUNNER_TEMP when no ingest URL is set");
}

const refused = run(
  ["review.council", "--mode", "full", "--members", "1"],
  { VIBETRACE_INGEST_URL: "http://127.0.0.1:1/ingest?credential=do-not-log" },
);
const refusedOutput = refused.stdout + refused.stderr;
if (refused.status !== 0) {
  console.error("FAIL connection-refused must not fail emit", refused.status, refusedOutput);
  failed++;
} else if (refused.stderr.trim() !== "vibetrace-emit: ingest request failed") {
  console.error("FAIL connection-refused message", refused.stderr);
  failed++;
} else if (refusedOutput.includes("127.0.0.1:1") || refusedOutput.includes("do-not-log")) {
  console.error("FAIL connection-refused output leaked endpoint details", refusedOutput);
  failed++;
} else {
  console.log("ok - sanitizes a fetch exception (connection refused) without leaking the endpoint");
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
  const reqHeaders = [];
  const server = http.createServer((req, res) => {
    let body = "";
    reqHeaders.push(req.headers);
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(body);
      const status = req.url?.startsWith("/unauthorized") ? 401 : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    runAsync(
      ["review.council", "--mode", "full", "--cache-hit", "0", "--members", "2", "--cancelled", "0"],
      { VIBETRACE_INGEST_URL: `http://127.0.0.1:${port}/ingest` },
    ).then((ingestRun) => {
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
        } else if (reqHeaders[0].authorization !== undefined) {
          console.error("FAIL ingest sent authorization header when token unset", reqHeaders[0]);
          failed++;
        } else if (!/-> ingest$/.test(ingestRun.stdout.trim())) {
          console.error("FAIL ingest destination log", ingestRun.stdout);
          failed++;
        } else {
          console.log("ok - posts review.council to VIBETRACE_INGEST_URL (no token)");
        }
      }

      runAsync(
        ["review.council", "--mode", "full", "--cache-hit", "0", "--members", "2", "--cancelled", "0"],
        {
          VIBETRACE_INGEST_URL: `http://127.0.0.1:${port}/ingest`,
          VIBETRACE_INGEST_TOKEN: "secret-token-123",
        },
      ).then((ingestRun2) => {
        if (ingestRun2.status !== 0) {
          console.error("FAIL ingest with token exit", ingestRun2.status, ingestRun2.stderr);
          failed++;
        } else if (received.length !== 2) {
          console.error("FAIL ingest with token did not receive a POST", ingestRun2.stdout, ingestRun2.stderr);
          failed++;
        } else {
          const rec = JSON.parse(received[1]);
          if (rec.type !== "review.council" || rec.memberCount !== 2) {
            console.error("FAIL ingest record shape (with token)", rec);
            failed++;
          } else if (reqHeaders[1].authorization !== "Bearer secret-token-123") {
            console.error("FAIL ingest with token: bad or missing authorization header", reqHeaders[1]);
            failed++;
          } else if (!/-> ingest$/.test(ingestRun2.stdout.trim())) {
            console.error("FAIL ingest with token destination log", ingestRun2.stdout);
            failed++;
          } else {
            console.log("ok - posts review.council with Authorization Bearer token header");
          }
        }

        runAsync(
          ["review.council", "--mode", "full", "--cache-hit", "0", "--members", "2", "--cancelled", "0"],
          {
            VIBETRACE_INGEST_URL: `http://127.0.0.1:${port}/unauthorized?credential=do-not-log`,
            VIBETRACE_INGEST_TOKEN: "secret-token-123",
          },
        ).then((unauthorizedRun) => {
          server.close();
          const output = unauthorizedRun.stdout + unauthorizedRun.stderr;
          if (unauthorizedRun.status !== 0) {
            console.error("FAIL 401 must not fail emit", unauthorizedRun.status, output);
            failed++;
          } else if (!/^vibetrace-emit: ingest HTTP 401\n$/m.test(unauthorizedRun.stderr)) {
            console.error("FAIL 401 log line", unauthorizedRun.stderr);
            failed++;
          } else if (output.includes("secret-token-123") || output.includes("credential=do-not-log")) {
            console.error("FAIL 401 output leaked credential or URL query", output);
            failed++;
          } else if (/wrote review\.council/.test(output)) {
            console.error("FAIL 401 was reported as a successful write", output);
            failed++;
          } else {
            console.log(
              `ok - contains 401 visibly without failing or leaking credentials: ${unauthorizedRun.stderr.trim()}`,
            );
          }
          resolve();
        });
      });
    });
  });
  server.on("error", reject);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("vibetrace-emit tests passed");
