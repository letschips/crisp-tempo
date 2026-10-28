// Builds native/tempo-apple-helper, the universal (arm64 + x86_64) EventKit helper that main.js
// embeds and writes next to itself on macOS. Needs Xcode's command line tools; run it only after
// changing native/TempoAppleHelper.swift, and commit the binary so plugin builds need no Swift.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "native/TempoAppleHelper.swift");
const plist = path.join(root, "native/Info.plist");
const output = path.join(root, "native/tempo-apple-helper");
const work = mkdtempSync(path.join(tmpdir(), "tempo-helper-"));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

try {
  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const out = path.join(work, arch);
    run("xcrun", [
      "swiftc", "-Osize", "-target", `${arch}-apple-macos13.0`, source, "-o", out,
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
    ]);
    run("xcrun", ["strip", "-x", out]);
    slices.push(out);
  }
  run("xcrun", ["lipo", "-create", ...slices, "-output", output]);
  run("codesign", ["--force", "--sign", "-", "--identifier", "com.letschips.crisp-tempo.apple-helper", output]);
  console.log(`Built ${path.relative(root, output)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
