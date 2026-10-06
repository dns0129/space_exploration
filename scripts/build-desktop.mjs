import { build } from "vite";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const output = join(project, "dist-desktop");
const { version } = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const revision = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: project,
  encoding: "utf8",
}).trim();

await build({
  root: project,
  base: "/",
  define: {
    "import.meta.env.VITE_DESKTOP": JSON.stringify("true"),
    "import.meta.env.VITE_PUBLIC_SITE": JSON.stringify("false"),
  },
  build: {
    outDir: output,
    emptyOutDir: true,
    rollupOptions: {
      input: join(project, "index.html"),
    },
  },
});

await mkdir(join(output, "legal"), { recursive: true });
for (const filename of ["ASSETS.md", "THIRD_PARTY_NOTICES.md"])
  await copyFile(join(project, filename), join(output, "legal", filename));
await writeFile(join(output, "build-info.json"), JSON.stringify({
  platform: "desktop",
  version,
  revision,
  builtAt: new Date().toISOString(),
}, null, 2) + "\n");
console.log(`Desktop renderer built at ${revision.slice(0, 7)}; assets and saves are local.`);
