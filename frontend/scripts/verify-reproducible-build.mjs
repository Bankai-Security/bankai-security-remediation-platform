import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");

async function filesUnder(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(path.join(directory, entry.name), relative));
    } else {
      files.push(relative);
    }
  }
  return files;
}

async function artifactDigest() {
  const hash = createHash("sha256");
  for (const relative of await filesUnder(dist)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(path.join(dist, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function cleanBuild() {
  await rm(dist, { recursive: true, force: true });
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is unavailable; invoke this verifier through npm");
  const result = spawnSync(process.execPath, [npmCli, "run", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return artifactDigest();
}

const first = await cleanBuild();
const second = await cleanBuild();
if (first !== second) {
  console.error(`Frontend build is not reproducible: ${first} != ${second}`);
  process.exit(1);
}
console.log(`Reproducible frontend artifact sha256:${second}`);
