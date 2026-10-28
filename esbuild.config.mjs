import esbuild from "esbuild";
import builtins from "builtin-modules";
import process from "node:process";
import { readFileSync } from "node:fs";

// `import helper from "tempo-apple-helper"` is the EventKit helper (native/, see build-helper.mjs) as base64.
const appleHelper = {
  name: "tempo-apple-helper",
  setup(build) {
    build.onResolve({ filter: /^tempo-apple-helper$/ }, () => ({ path: "tempo-apple-helper", namespace: "tempo-binary" }));
    build.onLoad({ filter: /.*/, namespace: "tempo-binary" }, () => ({
      contents: readFileSync(new URL("./native/tempo-apple-helper", import.meta.url)),
      loader: "base64",
      watchFiles: [new URL("./native/tempo-apple-helper", import.meta.url).pathname],
    }));
  },
};

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  jsx: "automatic",
  jsxImportSource: "preact",
  plugins: [appleHelper],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
