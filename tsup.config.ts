import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    daemon: "src/daemon/entry.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  splitting: false,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
