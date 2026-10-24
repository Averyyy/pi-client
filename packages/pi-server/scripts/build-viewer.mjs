import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/viewer/", import.meta.url);

await mkdir(output, { recursive: true });
await build({
	absWorkingDir: packageRoot,
	entryPoints: ["viewer/main.tsx"],
	outfile: "dist/viewer/app.js",
	bundle: true,
	minify: true,
	format: "esm",
	platform: "browser",
	target: ["es2022"],
	jsx: "automatic",
	define: { "process.env.NODE_ENV": '"production"' },
	legalComments: "external",
});
const version = randomUUID();
const html = (await readFile(new URL("../viewer/index.html", import.meta.url), "utf8")).replaceAll(
	"/viewer/assets/",
	`/viewer/assets/${version}/`,
);
await writeFile(new URL("asset-version.json", output), JSON.stringify({ version }));
await writeFile(new URL("index.html", output), html);
