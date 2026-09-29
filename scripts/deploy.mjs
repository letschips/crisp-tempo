import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import console from "node:console";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifacts = ["main.js", "manifest.json", "styles.css"];

async function requireDirectory(path, label) {
  try {
    if (!(await stat(path)).isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) {
      throw error;
    }
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }
}

// The target vault is machine-specific, so it never lives in this public repository.
// Precedence: OBSIDIAN_VAULT, then the first argument, then an untracked `.deploy-target`
// file in the project root that holds the vault path on one line.
async function resolveTargetVault(projectRoot) {
  if (process.env.OBSIDIAN_VAULT) return process.env.OBSIDIAN_VAULT;
  if (process.argv[2]) return process.argv[2];
  try {
    const saved = (await readFile(resolve(projectRoot, ".deploy-target"), "utf8")).trim();
    if (saved) return saved;
  } catch {
    // Fall through to the usage error below.
  }
  throw new Error(
    "No target vault. Set OBSIDIAN_VAULT, pass the vault path as an argument, " +
      "or write it to .deploy-target (ignored by git).",
  );
}

async function main() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const targetVault = await resolveTargetVault(projectRoot);
  const vault = resolve(targetVault);
  await requireDirectory(vault, "Vault");
  await requireDirectory(resolve(vault, ".obsidian"), "Obsidian configuration directory");

  const manifestPath = resolve(projectRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.id !== "string" || manifest.id.length === 0) {
    throw new Error("manifest.json must contain a plugin id.");
  }
  for (const artifact of artifacts) {
    await stat(resolve(projectRoot, artifact));
  }

  const destination = resolve(vault, ".obsidian", "plugins", manifest.id);
  await mkdir(destination, { recursive: true });
  await Promise.all(
    artifacts.map((artifact) =>
      copyFile(resolve(projectRoot, artifact), resolve(destination, artifact)),
    ),
  );
  console.log(`Deployed ${manifest.name} ${manifest.version} to ${destination}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
