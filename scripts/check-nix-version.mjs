import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkNixVersion(actualVersion, sourceVersion, releaseTag) {
	if (actualVersion !== sourceVersion) {
		throw new Error(`Nix runtime version ${JSON.stringify(actualVersion)} does not match source version ${sourceVersion}`);
	}
	if (releaseTag === undefined) return;

	// The scoped npm publisher applies -piclient.N only in temporary package
	// directories. Nix builds the unchanged source package and reports its version.
	const forkTag = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-piclient\.(?:0|[1-9]\d*)$/.exec(releaseTag);
	if (releaseTag !== `v${sourceVersion}` && forkTag?.[1] !== sourceVersion) {
		throw new Error(`Release tag ${JSON.stringify(releaseTag)} does not match source version ${sourceVersion}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [actualVersion, releaseTag, ...extra] = process.argv.slice(2);
	if (actualVersion === undefined || extra.length > 0) {
		throw new Error("Usage: node scripts/check-nix-version.mjs <runtime-version> [release-tag]");
	}
	const { version } = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));
	checkNixVersion(actualVersion, version, releaseTag);
	console.log(`Nix runtime version ${actualVersion} matches source${releaseTag ? ` and ${releaseTag}` : ""}.`);
}
