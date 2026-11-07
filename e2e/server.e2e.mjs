/**
 * The server stays itself under load and through shutdown, with real processes:
 *
 *  L1  While a slow `plan` runs, `/control/ping` still answers (the engine runs
 *      on its own thread), so a second launcher sees the running server.
 *  L2  Out-of-range `--idle-minutes` is refused rather than turned into an
 *      immediate stop.
 *  L3  終了 during a write is refused, and the write finishes completely.
 *  L4  終了 during a read stops the read and the process really exits.
 *  L5  Two launches started at the same moment make exactly one server.
 *  L6  A lock left by a dead server is taken over, even if something else now
 *      answers on its port with the old PID.
 *  L7  `--read-only` does not quietly open a running server that can write.
 *  L8  A malformed request target does not take the process down.
 *
 *   node e2e/server.e2e.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import { assert, checks, makeHome, REPO, seedMachine, startServer, writeFile } from "./harness.mjs";

const t = checks("server e2e");
const NONCE = "00112233445566778899aabbccddeeff";

function ask(port, method, pathname, headers = {}, body) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text, ms: Date.now() - started }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function spawnMain(home, args) {
  const child = spawn(process.execPath, [path.join(REPO, "dist", "server", "main.js"), ...args], {
    env: { ...process.env, AC_HOME: home, AM_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output: () => out, exited };
}

async function runMain(home, args, timeoutMs = 20000) {
  const run = spawnMain(home, args);
  const timer = setTimeout(() => run.child.kill(), timeoutMs);
  const code = await run.exited;
  clearTimeout(timer);
  return { code, out: run.output() };
}

/** Wait for the first JSON event line of a spawned server. */
async function firstEvent(run, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = run.output().split("\n").find((l) => l.startsWith("{"));
    if (line) return JSON.parse(line);
    if (Date.now() > deadline) throw new Error(`no event: ${run.output().slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Redeem a launch code the way a tab does; returns the API headers. */
async function login(server) {
  const u = new URL(server.launchUrl);
  const launch = await ask(server.port, "GET", u.pathname + u.search);
  const cookie = String(launch.headers["set-cookie"]).split(";")[0];
  const headerToken = /name="ac-launch-token" content="([0-9a-f]{64})"/.exec(launch.body)?.[1];
  return { Cookie: cookie, "X-Console-Token": headerToken, "Content-Type": "application/json", Origin: `http://127.0.0.1:${server.port}` };
}

const lockOf = (home) => JSON.parse(fs.readFileSync(path.join(home, ".agent-console", "server.json"), "utf8"));
const skillCount = (home, rel) => (fs.existsSync(path.join(home, rel)) ? fs.readdirSync(path.join(home, rel)).filter((n) => n.startsWith("load-")).length : 0);

function addLoad(home, count, roots) {
  for (let i = 0; i < count; i++) {
    const md = `---\nname: load-${i}\ndescription: load ${i}\n---\n\n# load\n`;
    for (const root of roots) {
      for (let j = 0; j < 20; j++) writeFile(home, `${root}/load-${i}/f${j}.txt`, "x".repeat(2000));
      writeFile(home, `${root}/load-${i}/SKILL.md`, md);
    }
  }
}

const homes = [];
const newHome = (label) => {
  const h = makeHome(`ac-e2e-${label}-`);
  homes.push(h);
  return h;
};

try {
  // ---------------------------------------------------------------- L1, L4, L8
  // Heavy enough that `plan` takes seconds: it hashes the source skill and the
  // physical copy in each target to compare them, so both sides get the files.
  const heavy = newHome("load");
  seedMachine(heavy);
  addLoad(heavy, 600, [".agents/skills", ".claude/skills", ".copilot/skills"]);
  const server = await startServer(heavy);
  const api = await login(server);

  await t.check("L1 the server answers ping and a second launcher while a slow plan runs", async () => {
    const plan = ask(server.port, "POST", "/api/run", api, JSON.stringify({ args: ["plan"] }));
    await new Promise((r) => setTimeout(r, 300));
    const ping = await ask(server.port, "GET", `/control/ping?nonce=${NONCE}`);
    const second = await runMain(heavy, ["--no-open", "--port", "0"]);
    const planReply = await plan;
    // Positive control: the plan really was slow, or this check proves nothing.
    assert(planReply.ms > 2000, `precondition: plan took only ${planReply.ms} ms`);
    assert(ping.status === 200 && ping.ms < 1000, `ping ${ping.status} in ${ping.ms} ms`);
    assert(second.out.includes('"already-running"'), `second launcher: ${second.out.slice(0, 200)}`);
    assert(lockOf(heavy).port === server.port, `lock overwritten: ${lockOf(heavy).port} vs ${server.port}`);
    assert(planReply.status === 200, `plan ${planReply.status}`);
    return `ping ${ping.ms} ms during a ${planReply.ms} ms plan; second launcher saw the running server`;
  });

  await t.check("L8 a malformed request target is answered, and the server stays up", async () => {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(server.port, "127.0.0.1", () =>
        socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`),
      );
      let out = "";
      socket.setEncoding("utf8");
      socket.setTimeout(3000, () => socket.destroy());
      socket.on("data", (c) => (out += c));
      socket.on("close", () => resolve(out));
      socket.on("error", reject);
    });
    const ping = await ask(server.port, "GET", `/control/ping?nonce=${NONCE}`);
    assert(String(reply).startsWith("HTTP/1.1 400"), `reply: ${String(reply).slice(0, 60)}`);
    assert(ping.status === 200 && server.child.exitCode === null, "server went down");
    return "400, still up";
  });

  await t.check("L4 終了 during a read stops it and the process exits", async () => {
    const plan = ask(server.port, "POST", "/api/run", api, JSON.stringify({ args: ["plan"] })).catch((e) => ({ status: 0, body: String(e) }));
    await new Promise((r) => setTimeout(r, 300));
    const shut = await ask(server.port, "POST", "/api/shutdown", api, "{}");
    const started = Date.now();
    const exit = await Promise.race([
      new Promise((r) => (server.child.exitCode !== null ? r(server.child.exitCode) : server.child.once("exit", r))),
      new Promise((r) => setTimeout(() => r("still running"), 8000)),
    ]);
    await plan;
    assert(shut.status === 200, `shutdown ${shut.status}`);
    assert(exit !== "still running", "the process did not exit");
    assert(!fs.existsSync(path.join(heavy, ".agent-console", "server.json")), "lock left behind");
    return `exit ${exit} after ${Date.now() - started} ms, lock removed`;
  });
  await server.stop();

  // ---------------------------------------------------------------- L3
  await t.check("L3 終了 during a write is refused with 409 and the write completes", async () => {
    const home = newHome("write");
    seedMachine(home);
    addLoad(home, 600, [".agents/skills"]);
    const s = await startServer(home);
    try {
      const h = await login(s);
      const plan = JSON.parse((await ask(s.port, "POST", "/api/run", h, JSON.stringify({ args: ["plan"] }))).body);
      const apply = ask(s.port, "POST", "/api/run", h, JSON.stringify({ args: ["apply", "--yes"], digest: plan.digest }));
      // Wait until the write is visibly under way.
      const deadline = Date.now() + 15000;
      while (skillCount(home, ".claude/skills") === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const shut = await ask(s.port, "POST", "/api/shutdown", h, "{}");
      const applied = await apply;
      const out = JSON.parse(applied.body);
      const claude = skillCount(home, ".claude/skills");
      const copilot = skillCount(home, ".copilot/skills");
      assert(shut.status === 409, `shutdown during the write answered ${shut.status}`);
      assert(applied.status === 200 && out.code === 0, `apply ${applied.status} code ${out.code}`);
      assert(claude === 600 && copilot === 600, `delivered claude ${claude}/600, copilot ${copilot}/600`);
      const after = await ask(s.port, "POST", "/api/shutdown", h, "{}");
      assert(after.status === 200, `shutdown after the write answered ${after.status}`);
      return `409 during the write, then all 600 delivered to both targets, then 200`;
    } finally {
      await s.stop();
    }
  });

  // ---------------------------------------------------------------- L5, L7
  await t.check("L5 two launches at the same moment make exactly one server (3 rounds)", async () => {
    const rounds = [];
    for (let round = 0; round < 3; round++) {
      const home = newHome(`race${round}`);
      seedMachine(home);
      const a = spawnMain(home, ["--no-open", "--port", "0"]);
      const b = spawnMain(home, ["--no-open", "--port", "0"]);
      const [ea, eb] = await Promise.all([firstEvent(a), firstEvent(b)]);
      const events = [ea.event, eb.event].sort();
      const server = ea.event === "listening" ? ea : eb;
      const lock = lockOf(home);
      for (const run of [a, b]) if (run.child.exitCode === null) run.child.kill();
      await Promise.all([a.exited, b.exited]);
      assert(events[0] === "already-running" && events[1] === "listening", `round ${round}: ${events.join(",")}`);
      assert(lock.port === server.port, `round ${round}: lock ${lock.port} vs ${server.port}`);
      rounds.push(events.join("+"));
    }
    return rounds.join(" / ");
  });

  await t.check("L7 --read-only does not open a running server that can write", async () => {
    const home = newHome("ro");
    seedMachine(home);
    const s = await startServer(home);
    try {
      const result = await runMain(home, ["--no-open", "--port", "0", "--read-only"]);
      assert(result.code === 1, `exit ${result.code}`);
      assert(result.out.includes('"already-running-conflict"'), result.out.slice(0, 200));
      return `exit 1, already-running-conflict`;
    } finally {
      await s.stop();
    }
  });

  // ---------------------------------------------------------------- L6
  await t.check("L6 a dead server's lock is taken over, whatever now answers on its port", async () => {
    const home = newHome("squat");
    seedMachine(home);
    // A PID that is certainly dead: a process that has already exited.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const deadPid = Number(dead.stdout);
    let opened = 0;
    const squatter = http.createServer((req, res) => {
      if (req.url?.startsWith("/control/open")) opened++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ app: "agent-console", pid: deadPid, proof: "0".repeat(64), writes: true }));
    });
    await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
    const squatPort = squatter.address().port;
    fs.mkdirSync(path.join(home, ".agent-console"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".agent-console", "server.json"),
      JSON.stringify({ app: "agent-console", port: squatPort, pid: deadPid, tokenHash: "x", controlKey: "y".repeat(64), writes: true, startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    let s;
    try {
      s = await startServer(home);
      assert(s.port !== squatPort, "started on the squatter's port?");
      assert(lockOf(home).pid === s.child.pid, "lock not taken over");
      assert(opened === 0, "the squatter was asked to open a tab");
      return `took over the lock of dead PID ${deadPid}; the squatter got no request`;
    } finally {
      if (s) await s.stop();
      await new Promise((r) => squatter.close(r));
    }
  });

  await t.check("L2 --idle-minutes beyond a week is refused, not turned into an immediate stop", async () => {
    const other = newHome("idle");
    const result = await runMain(other, ["--no-open", "--port", "0", "--idle-minutes", "40000"]);
    assert(result.code === 2 && result.out.includes("--idle-minutes needs a whole number"), `exit ${result.code}: ${result.out.slice(0, 200)}`);
    return `exit ${result.code}`;
  });
} finally {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}

process.exitCode = t.finish();
