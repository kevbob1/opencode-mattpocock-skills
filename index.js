import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULTS = {
  repository: "https://github.com/mattpocock/skills.git",
  ref: "main",
  sourceDirectory: "skills",
  exclude: ["in-progress", "misc", "deprecated"],
  updateIntervalHours: 24,
  gitTimeoutSeconds: 30,
  lockTimeoutSeconds: 300
};
const OPTION_NAMES = new Set([...Object.keys(DEFAULTS), "cacheDirectory", "logger"]);

/** Synchronize a pinned source tree into an immutable local snapshot. */
export async function syncSkills(input = {}) {
  const options = validateOptions(input);
  const log = options.logger ?? (() => {});
  const cacheRoot = resolve(options.cacheDirectory ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode-mattpocock-skills"));
  const key = hash(JSON.stringify({ repository: options.repository, ref: options.ref, sourceDirectory: options.sourceDirectory, exclude: options.exclude }));
  const root = join(cacheRoot, key);
  const current = join(root, "current");
  const stateFile = join(root, "state.json");
  const state = await readJson(stateFile);
  const existing = await activeSnapshot(current, root);

  if (!isUpdateDue(existing, state, options)) {
    log({ level: "debug", message: "Skills snapshot is not due for update", path: existing.path, commit: existing.commit });
    return { ...existing, updated: false };
  }

  try {
    await mkdir(root, { recursive: true });
    const lock = await acquireLock(join(root, "sync.lock"), options.lockTimeoutSeconds, Boolean(existing));
    if (!lock) {
      log({ level: "error", message: "Skills sync lock is held; using current snapshot", path: existing.path });
      return { ...existing, updated: false };
    }
    try {
       await cleanupTemporarySnapshots(root, options.lockTimeoutSeconds);
       const refreshed = await activeSnapshot(current, root);
       if (!isUpdateDue(refreshed, await readJson(stateFile), options)) {
        log({ level: "debug", message: "Skills snapshot was updated by another process", path: refreshed.path, commit: refreshed.commit });
        return { ...refreshed, updated: false };
      }
       const result = await update(root, options, refreshed);
      log({ level: "info", message: "Activated skills snapshot", path: result.path, commit: result.commit });
      return result;
    } finally {
      await rm(lock, { force: true });
    }
  } catch (error) {
    if (existing) {
      log({ level: "warn", message: "Skills update failed; using current snapshot", error: error.message, path: existing.path });
      return { ...existing, updated: false };
    }
    log({ level: "error", message: "No active skills snapshot is available", error: error.message });
    throw error;
  }
}

const PLUGIN_ID = "opencode-mattpocock-skills";
const REFRESH_CHECK_MINUTES = 60;

/** OpenCode V2 plugin: syncs the snapshot and registers its skills. */
export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const pluginOptions = ctx.options && typeof ctx.options === "object" ? ctx.options : {};
    const logger = (entry) => {
      const text = `[${PLUGIN_ID}] ${entry.message}${entry.error ? `: ${entry.error}` : ""}`;
      if (entry.level === "error") console.error(text);
      else if (entry.level === "warn") console.warn(text);
      else console.log(text);
    };
    const skills = { current: [] };
    const result = await syncSkills({ ...pluginOptions, logger });
    skills.current = await readSkills(result.path);
    await ctx.skill.transform((editor) => {
      for (const skill of skills.current) editor.add(skill);
    });
    const timer = setInterval(() => {
      void (async () => {
        const refreshed = await syncSkills({ ...pluginOptions, logger });
        if (!refreshed.updated) return;
        skills.current = await readSkills(refreshed.path);
        await ctx.skill.reload();
        logger({ level: "info", message: "Registered refreshed skills snapshot", path: refreshed.path, commit: refreshed.commit });
      })().catch((error) => logger({ level: "warn", message: "Skills refresh failed", error: error.message }));
    }, REFRESH_CHECK_MINUTES * 60_000);
    return () => clearInterval(timer);
  }
};

/** Read every SKILL.md below the snapshot and map it to an OpenCode skill. */
async function readSkills(snapshot) {
  const files = [];
  for (const category of await readdir(snapshot, { withFileTypes: true })) {
    if (!category.isDirectory() || category.name.startsWith(".")) continue;
    const categoryPath = join(snapshot, category.name);
    const direct = join(categoryPath, "SKILL.md");
    if (await exists(direct)) {
      files.push({ path: direct, name: category.name });
      continue;
    }
    for (const skill of await readdir(categoryPath, { withFileTypes: true })) {
      if (skill.name.startsWith(".")) continue;
      if (skill.isFile() && skill.name === "SKILL.md") {
        files.push({ path: join(categoryPath, skill.name), name: skillName(category.name) });
        continue;
      }
      if (!skill.isDirectory()) continue;
      const file = join(categoryPath, skill.name, "SKILL.md");
      if (await exists(file)) files.push({ path: file, name: skillName(skill.name) });
    }
  }
  return Promise.all(files.map(async ({ path, name }) => {
    const content = await readFile(path, "utf8");
    const frontmatter = parseFrontmatter(content);
    const skill = {
      id: frontmatter.name || name,
      name: frontmatter.name || name,
      description: frontmatter.description ?? "",
      location: path,
      content
    };
    if (frontmatter["disable-model-invocation"] === true) skill.autoinvoke = false;
    return skill;
  }));
}

function skillName(directory) {
  return directory.replace(/^\d+[-_.]/, "");
}

/** Parse a minimal `---` frontmatter block: name, description, disable-model-invocation. */
function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!entry) continue;
    const value = entry[2].trim().replace(/^["']|["']$/g, "");
    result[entry[1]] = value === "true" ? true : value === "false" ? false : value;
  }
  return result;
}

function validateOptions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Options must be an object");
  for (const name of Object.keys(input)) if (!OPTION_NAMES.has(name)) throw new TypeError(`Unknown option: ${name}`);
  const options = { ...DEFAULTS, ...input };
  for (const name of ["repository", "ref", "sourceDirectory"]) if (typeof options[name] !== "string" || !options[name]) throw new TypeError(`${name} must be a non-empty string`);
  if (!Array.isArray(options.exclude) || options.exclude.some((entry) => typeof entry !== "string" || !entry || entry.includes("/") || entry.includes("\\"))) throw new TypeError("exclude must be an array of top-level directory names");
  for (const name of ["updateIntervalHours", "gitTimeoutSeconds", "lockTimeoutSeconds"]) if (!Number.isFinite(options[name]) || options[name] < 0) throw new TypeError(`${name} must be a non-negative number`);
  if (options.cacheDirectory !== undefined && (typeof options.cacheDirectory !== "string" || !options.cacheDirectory)) throw new TypeError("cacheDirectory must be a non-empty string");
  if (options.logger !== undefined && typeof options.logger !== "function") throw new TypeError("logger must be a function");
  return options;
}

async function update(root, options, previous) {
  const bare = join(root, "repository.git");
  if (!(await exists(bare))) await git(["init", "--bare", bare], root, options);
  await git(["fetch", "--force", "--no-tags", options.repository, options.ref], bare, options);
  const commit = (await git(["rev-parse", "FETCH_HEAD^{commit}"], bare, options)).trim();
  const tree = join(root, "worktree");
  await rm(tree, { recursive: true, force: true });
  await mkdir(tree, { recursive: true });
  await extractArchive(bare, commit, tree, options);
  const source = resolve(tree, options.sourceDirectory);
  if (!source.startsWith(`${tree}/`) || !(await isDirectory(source))) throw new Error(`Source directory does not exist: ${options.sourceDirectory}`);
  const snapshot = join(root, `snapshot-${commit}`);
  if (!(await exists(snapshot))) {
    const temp = join(root, `.snapshot-${randomUUID()}`);
    await cp(source, temp, { recursive: true });
    await Promise.all(options.exclude.map((name) => rm(join(temp, name), { recursive: true, force: true })));
    const updatedAt = new Date().toISOString();
    await writeSnapshotMetadata(temp, { commit, updatedAt, activation: { type: "sync", ...(previous ? { previousSnapshot: basename(previous.snapshot) } : {}) } });
    await rename(temp, snapshot);
  }
  const metadata = await snapshotMetadata(snapshot, commit);
  if (!metadata) throw new Error(`Snapshot metadata is missing or invalid: ${basename(snapshot)}`);
  await rm(tree, { recursive: true, force: true });
  await writeSyncCache(root, { commit, checkedAt: new Date().toISOString() });
  const tempLink = join(root, `.current-${randomUUID()}`);
  await symlink(basename(snapshot), tempLink);
  await rename(tempLink, join(root, "current"));
  await cleanupSnapshots(root, [basename(snapshot), previous && basename(previous.snapshot), metadata.activation.previousSnapshot]).catch(() => {});
  return { path: join(root, "current"), commit, updatedAt: metadata.updatedAt, updated: true };
}

async function extractArchive(bare, commit, destination, options) {
  const archive = join(destination, ".source.tar");
  await execFileAsync("git", ["--git-dir", bare, "archive", `--output=${archive}`, commit], { timeout: options.gitTimeoutSeconds * 1000 });
  await execFileAsync("tar", ["-x", "-f", archive, "-C", destination], { timeout: options.gitTimeoutSeconds * 1000 });
  await rm(archive, { force: true });
}

async function git(args, cwd, options) {
  const full = ["--git-dir", cwd, ...args];
  if (args[0] === "init") return (await execFileAsync("git", args, { cwd, timeout: options.gitTimeoutSeconds * 1000 })).stdout;
  return (await execFileAsync("git", full, { cwd, timeout: options.gitTimeoutSeconds * 1000 })).stdout;
}

async function acquireLock(lock, timeoutSeconds, hasCurrent) {
  try { await writeFile(lock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), { flag: "wx" }); return lock; } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const value = await readJson(lock);
    const stale = !value || Date.now() - value.timestamp > timeoutSeconds * 1000 || !processAlive(value.pid);
    if (!stale) { if (hasCurrent) return null; throw new Error("Skills sync lock is held and no current snapshot exists"); }
    await rm(lock, { force: true });
    return acquireLock(lock, timeoutSeconds, hasCurrent);
  }
}

function processAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function isUpdateDue(snapshot, state, options) {
  if (!snapshot) return true;
  const checkedAt = state?.commit === snapshot.commit && typeof state.checkedAt === "string" && !Number.isNaN(Date.parse(state.checkedAt)) ? state.checkedAt : snapshot.updatedAt;
  return Date.now() - Date.parse(checkedAt) >= options.updateIntervalHours * 3_600_000;
}
async function activeSnapshot(current, root) {
  const target = await readlink(current).catch(() => null);
  if (!target || target !== basename(target) || !target.startsWith("snapshot-")) return null;
  const snapshot = join(root, target);
  const metadata = await snapshotMetadata(snapshot, target.slice("snapshot-".length));
  if (!metadata) return null;
  return { path: current, snapshot, commit: metadata.commit, updatedAt: metadata.updatedAt };
}
async function exists(path) { try { await lstat(path); return true; } catch { return false; } }
async function isDirectory(path) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function snapshotMetadata(snapshot, commit) {
  if (!(await isDirectory(snapshot))) return null;
  const metadata = await readJson(join(snapshot, ".opencode-snapshot.json"));
  if (!metadata || metadata.commit !== commit || typeof metadata.updatedAt !== "string" || Number.isNaN(Date.parse(metadata.updatedAt)) || !metadata.activation || metadata.activation.type !== "sync" || (metadata.activation.previousSnapshot !== undefined && (typeof metadata.activation.previousSnapshot !== "string" || metadata.activation.previousSnapshot !== basename(metadata.activation.previousSnapshot) || !metadata.activation.previousSnapshot.startsWith("snapshot-")))) return null;
  return metadata;
}
async function writeSnapshotMetadata(snapshot, metadata) {
  const temp = join(snapshot, `.metadata-${randomUUID()}`);
  await writeFile(temp, JSON.stringify(metadata));
  await rename(temp, join(snapshot, ".opencode-snapshot.json"));
}
async function writeSyncCache(root, cache) {
  const temp = join(root, `.state-${randomUUID()}`);
  await writeFile(temp, JSON.stringify(cache));
  await rename(temp, join(root, "state.json"));
}
async function cleanupTemporarySnapshots(root, timeoutSeconds) {
  const threshold = Date.now() - timeoutSeconds * 1000;
  const names = (await readdir(root)).filter((name) => name.startsWith(".snapshot-"));
  await Promise.all(names.map(async (name) => {
    const path = join(root, name);
    if ((await lstat(path)).mtimeMs < threshold) await rm(path, { recursive: true, force: true });
  }));
}
async function cleanupSnapshots(root, retainedSnapshots) {
  const snapshots = (await readdir(root)).filter((name) => name.startsWith("snapshot-"));
  const currentTarget = await readlink(join(root, "current")).catch(() => null);
  const currentMetadata = currentTarget && await snapshotMetadata(join(root, currentTarget), currentTarget.slice("snapshot-".length));
  const retained = new Set([currentTarget, currentMetadata?.activation.previousSnapshot, ...retainedSnapshots].filter((name) => snapshots.includes(name)));
  const ordered = await Promise.all(snapshots.map(async (name) => ({ name, mtime: (await stat(join(root, name))).mtimeMs })));
  for (const { name } of ordered.sort((a, b) => b.mtime - a.mtime)) {
    if (retained.size >= 2) break;
    retained.add(name);
  }
  await Promise.all(snapshots.filter((name) => !retained.has(name)).map((name) => rm(join(root, name), { recursive: true, force: true })));
}
function hash(value) { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
