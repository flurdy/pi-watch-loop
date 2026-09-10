import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const runtimeFiles = ["README.md", "docs/protocol.md", "index.ts", "watch-loop.ts"];

assert.ok(Array.isArray(packageJson.keywords) && packageJson.keywords.includes("pi-package"), "package is missing the pi-package discovery keyword");
assert.deepEqual(packageJson.pi, { extensions: ["./index.ts"] });
assert.deepEqual([...packageJson.files].sort(), runtimeFiles, "package files must remain an exact allowlist");
assert.equal(packageJson.repository?.url, "git+https://github.com/flurdy/pi-watch-loop.git");
assert.deepEqual(packageJson.peerDependencies, {
	"@earendil-works/pi-ai": "*",
	"@earendil-works/pi-coding-agent": "*",
	typebox: "*",
});
assert.equal(packageJson.devDependencies["@earendil-works/pi-ai"], "0.85.0");
assert.equal(packageJson.devDependencies["@earendil-works/pi-coding-agent"], "0.85.0");

const report = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: repositoryRoot,
	encoding: "utf8",
}));
assert.equal(report.length, 1, "expected one npm pack report");
const files = report[0].files.map((entry) => entry.path).sort();
const expectedFiles = ["LICENSE", "package.json", ...runtimeFiles].sort();
assert.deepEqual(files, expectedFiles, "npm package contents differ from the exact allowlist");

for (const file of files.filter((path) => path.endsWith(".md"))) {
	const markdown = readFileSync(resolve(repositoryRoot, file), "utf8");
	for (const [, link] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
		if (/^[a-z][a-z0-9+.-]*:|^#/i.test(link)) continue;
		const target = posix.join(posix.dirname(file), link.split("#")[0]);
		assert.ok(files.includes(target), `${file} links to unpackaged file ${target}`);
	}
}

console.log(`Package allowlist and documentation links verified (${files.length} files).`);
