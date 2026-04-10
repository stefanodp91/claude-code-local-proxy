import { build, context } from "esbuild";

const isWatch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension/activation.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
};

if (isWatch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[esbuild] Watching for changes...");
} else {
  await build(options);
  console.log("[esbuild] Build complete.");
}
