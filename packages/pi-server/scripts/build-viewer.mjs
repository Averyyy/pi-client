import { copyFile, mkdir } from "node:fs/promises";
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
await copyFile(new URL("../viewer/index.html", import.meta.url), new URL("index.html", output));
