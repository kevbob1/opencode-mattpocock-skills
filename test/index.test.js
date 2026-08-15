import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, readlink, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import plugin, { syncSkills } from "../index.js";

const run = promisify(execFile);
let root;
let repository;
let cache;

async function git(args, cwd = repository) { return run("git", args, { cwd }); }
async function publish(files) {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(repository, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  await git(["add", "."]); await git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "skills"]);
}
function options(extra = {}) { return { repository, cacheDirectory: cache, updateIntervalHours: 24, ...extra }; }

async function setup() {
  root = await mkdtemp(join(tmpdir(), "matt-skills-"));
  repository = join(root, "repo"); cache = join(root, "cache");
  await mkdir(repository); await git(["init", "-b", "main"]); await publish({ "skills/alpha/SKILL.md": "one", "skills/in-progress/SKILL.md": "skip", "skills/alpha/nested/in-progress/SKILL.md": "keep" });
}
async function teardown() { await rm(root, { recursive: true, force: true }); }

beforeEach(setup); afterEach(teardown);

test("installs, skips a not-due update, and forwards tuple options to OpenCode", async () => {
  const logs = [];
  const first = await syncSkills(options({ logger: (entry) => logs.push(entry) }));
  assert.equal(await readFile(join(first.path, "alpha", "SKILL.md"), "utf8"), "one");
  await assert.rejects(readFile(join(first.path, "in-progress", "SKILL.md")));
  assert.equal(await readFile(join(first.path, "alpha", "nested", "in-progress", "SKILL.md"), "utf8"), "keep");
  const second = await syncSkills(options());
  assert.equal(second.updated, false);
  assert.equal(second.path, first.path);
  assert.equal(logs.at(-1).level, "info");
  const appLogs = [];
  const instance = await plugin({ client: { app: { log: (entry) => appLogs.push(entry) } } }, options());
  const config = { skills: { paths: ["local"] } };
  await instance.config(config);
  assert.equal(config.skills.paths[0], "local");
  assert.equal(config.skills.paths[1], join(cache, (await readdir(cache))[0], "current"));
  assert.equal(appLogs[0].body.service, "opencode-mattpocock-skills");
});

test("retains the current and previously activated snapshots", async () => {
  const first = await syncSkills(options());
  await publish({ "skills/alpha/SKILL.md": "two" });
  const second = await syncSkills(options({ updateIntervalHours: 0 }));
  await publish({ "skills/alpha/SKILL.md": "three" });
  const third = await syncSkills(options({ updateIntervalHours: 0 }));
  const key = (await (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ repository, ref: "main", sourceDirectory: "skills", exclude: ["in-progress", "misc", "deprecated"] })).digest("hex").slice(0, 16));
  const snapshots = await readdir(join(cache, key));
  assert.deepEqual(snapshots.filter((name) => name.startsWith("snapshot-")).sort(), [`snapshot-${second.commit}`, `snapshot-${third.commit}`].sort());
  assert.equal(snapshots.includes(`snapshot-${first.commit}`), false);
});

test("updates to a new explicit ref commit and falls back after a failed update", async () => {
  const first = await syncSkills(options());
  await publish({ "skills/alpha/SKILL.md": "two" });
  const next = await syncSkills(options({ updateIntervalHours: 0 }));
  assert.equal(next.updated, true);
  assert.notEqual(next.commit, first.commit);
  assert.equal(await readFile(join(next.path, "alpha", "SKILL.md"), "utf8"), "two");
  await rm(join(repository, "skills"), { recursive: true });
  await git(["add", "-A"]); await git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "remove skills"]);
  const logs = [];
  const fallback = await syncSkills(options({ updateIntervalHours: 0, logger: (entry) => logs.push(entry) }));
  assert.equal(fallback.path, next.path);
  assert.equal(fallback.commit, next.commit);
  assert.equal(await readFile(join(fallback.path, "alpha", "SKILL.md"), "utf8"), "two");
  assert.equal(logs.at(-1).level, "warn");
});

test("does not replace current when snapshot metadata cannot be completed", async () => {
  const first = await syncSkills(options());
  const oldTarget = await readlink(first.path);
  await publish({ "skills/alpha/SKILL.md": "two" });
  const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const key = (await (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ repository, ref: "main", sourceDirectory: "skills", exclude: ["in-progress", "misc", "deprecated"] })).digest("hex").slice(0, 16));
  const snapshot = join(cache, key, `snapshot-${commit}`);
  await mkdir(snapshot, { recursive: true });
  await chmod(snapshot, 0o555);
  try {
    const fallback = await syncSkills(options({ updateIntervalHours: 0 }));
    assert.equal(fallback.updated, false);
    assert.equal(fallback.commit, first.commit);
    assert.equal(await readlink(first.path), oldTarget);
  } finally {
    await chmod(snapshot, 0o755);
  }
});

test("removes abandoned temporary snapshots while preserving completed snapshots", async () => {
  const first = await syncSkills(options());
  const key = (await (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ repository, ref: "main", sourceDirectory: "skills", exclude: ["in-progress", "misc", "deprecated"] })).digest("hex").slice(0, 16));
  const abandoned = join(cache, key, ".snapshot-abandoned");
  const recent = join(cache, key, ".snapshot-recent");
  await mkdir(abandoned); await mkdir(recent);
  const old = new Date(Date.now() - 2_000);
  await utimes(abandoned, old, old);
  await syncSkills(options({ updateIntervalHours: 0, lockTimeoutSeconds: 1 }));
  await assert.rejects(readdir(abandoned));
  await readdir(recent);
  await readdir(join(cache, key, `snapshot-${first.commit}`));
});

test("rejects invalid options and throws on an initial missing source directory", async () => {
  await assert.rejects(syncSkills(options({ nope: true })), /Unknown option/);
  await assert.rejects(syncSkills(options({ exclude: ["nested/name"] })), /exclude/);
  await assert.rejects(syncSkills(options({ sourceDirectory: "missing" })), /Source directory/);
});

test("uses current snapshot when a live lock contends", async () => {
  const first = await syncSkills(options());
  const key = (await (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ repository, ref: "main", sourceDirectory: "skills", exclude: ["in-progress", "misc", "deprecated"] })).digest("hex").slice(0, 16));
  const lock = join(cache, key, "sync.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
  const logs = [];
  const result = await syncSkills(options({ updateIntervalHours: 0, logger: (entry) => logs.push(entry) }));
  assert.equal(result.path, first.path);
  assert.equal(logs.at(-1).level, "error");
});
