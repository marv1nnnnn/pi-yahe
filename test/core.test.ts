import assert from "node:assert/strict";
import test from "node:test";
import { lastAssistantResult, taskLabel, validateOneShotPiArgs, workspaceForTask } from "../src/core.ts";

test("returns the final assistant result and failure state", () => {
	assert.deepEqual(lastAssistantResult([
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }], stopReason: "stop" } },
	]), { output: "final", exitCode: 0 });
	assert.deepEqual(lastAssistantResult([
		{ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" } },
	]), { output: "provider failed", exitCode: 1 });
});

test("falls back to the previous text when the last assistant turn is tool-call only", () => {
	assert.deepEqual(lastAssistantResult([
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "investigating" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }], stopReason: "tool_use" } },
	]), { output: "investigating", exitCode: 0 });
});

test("normalizes task labels", () => {
	assert.equal(taskLabel(undefined, "  run   tests\nignored", "task"), "run tests");
	assert.equal(taskLabel("x".repeat(60), undefined, "task").length, 48);
});

test("keeps one-shot lifecycle flags under extension control", () => {
	assert.doesNotThrow(() => validateOneShotPiArgs(["--model", "sonnet:high", "--tools", "read,grep"]));
	assert.throws(() => validateOneShotPiArgs(["--print"]), /run_pi owns worker lifecycle/);
	assert.throws(() => validateOneShotPiArgs(["--mode=json"]), /run_pi owns worker lifecycle/);
	assert.throws(() => validateOneShotPiArgs(["--extension", "other"]), /run_pi owns worker lifecycle/);
	assert.throws(() => validateOneShotPiArgs(["--name", "other"]), /run_pi owns worker lifecycle/);
});

test("reuses only a dedicated workspace for another project", () => {
	const source = { pane_id: "w1:p1", workspace_id: "w1", scope: "/a" };
	const panes = [
		source,
		{ pane_id: "w2:p1", workspace_id: "w2", scope: "/b" },
		{ pane_id: "w2:p2", workspace_id: "w2", scope: "/b" },
		{ pane_id: "w3:p1", workspace_id: "w3", scope: "/b" },
		{ pane_id: "w3:p2", workspace_id: "w3", scope: "/c" },
	];
	assert.equal(workspaceForTask(source, panes, "/a"), "w1");
	assert.equal(workspaceForTask(source, panes, "/b"), "w2");
	assert.equal(workspaceForTask(source, panes, "/missing"), undefined);
});
