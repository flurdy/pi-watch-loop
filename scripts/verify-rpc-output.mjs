import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [outputPath] = process.argv.slice(2);
assert.ok(outputPath, "usage: verify-rpc-output.mjs <output>");
const events = readFileSync(outputPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

const commandsResponse = events.find((event) => event.type === "response" && event.command === "get_commands");
assert.equal(commandsResponse?.success, true, "get_commands did not succeed");
const watchCommands = commandsResponse.data.commands.filter(
	(command) => ["watch-status", "watch-stop", "watch-resume"].includes(command.name),
);
assert.deepEqual(
	watchCommands.map(({ name, source }) => ({ name, source })),
	[
		{ name: "watch-resume", source: "extension" },
		{ name: "watch-status", source: "extension" },
		{ name: "watch-stop", source: "extension" },
	],
	"watch-loop commands were not loaded exactly once from the extension",
);

const promptResponse = events.find((event) => event.type === "response" && event.command === "prompt");
assert.equal(promptResponse?.success, true, "watch-status command did not execute");
const statusNotifications = events.filter(
	(event) => event.type === "extension_ui_request"
		&& event.method === "notify"
		&& typeof event.message === "string"
		&& event.message.includes("Protocol: 1"),
);
assert.equal(statusNotifications.length, 1, "expected one watch-status notification");
assert.match(statusNotifications[0].message, /Protocol: 1\nState: idle/);
assert.equal(statusNotifications[0].notifyType, "info");

console.log("Installed watch-loop commands and protocol status verified.");
