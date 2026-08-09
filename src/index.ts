import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { lastAssistantResult, type PaneInfo, type ScopedPane, taskLabel, validateOneShotPiArgs, workspaceForTask } from "./core.ts";

const Params = Type.Object({
	action: StringEnum([
		"pane_list", "pane_close", "read", "run", "run_in_pane", "monitor", "send_text", "send_keys",
		"run_pi", "spawn_pi", "agent_list", "agent_read", "agent_prompt", "agent_wait",
		"worktree_list", "worktree_create",
	] as const),
	paneId: Type.Optional(Type.String({ description: "Target pane. Defaults to the Pi pane that called this tool." })),
	agentId: Type.Optional(Type.String({ description: "Agent name or pane id." })),
	command: Type.Optional(Type.String({ description: "Shell command for run, run_in_pane, or monitor." })),
	text: Type.Optional(Type.String({ description: "Text for send_text or agent_prompt." })),
	keys: Type.Optional(Type.Array(Type.String(), { description: "Logical keys such as Enter or ctrl+c." })),
	prompt: Type.Optional(Type.String({ description: "Task for run_pi, or initial task for spawn_pi." })),
	piArgs: Type.Optional(Type.Array(Type.String(), {
		description: "Native Pi arguments used to shape a worker, e.g. ['--model','sonnet:high','--tools','read,grep,find,ls']. The task prompt is appended separately.",
	})),
	label: Type.Optional(Type.String({ description: "Concise 2-5 word label for a new task surface." })),
	cwd: Type.Optional(Type.String({ description: "Working directory. Different Git projects route to dedicated workspaces." })),
	focus: Type.Optional(Type.Boolean({ description: "Focus a newly created surface. Defaults to false." })),
	closeOnDone: Type.Optional(Type.Boolean({ description: "Close a temporary task surface after completion. Defaults to true." })),
	lines: Type.Optional(Type.Integer({ minimum: 1, description: "Terminal lines to read. Defaults to 80." })),
	status: Type.Optional(StringEnum(["idle", "working", "blocked", "done", "unknown"] as const)),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Wait timeout in milliseconds." })),
	branch: Type.Optional(Type.String({ description: "Branch name for worktree_create." })),
	base: Type.Optional(Type.String({ description: "Optional base revision for worktree_create." })),
});

const extensionPath = fileURLToPath(import.meta.url);
const runnerPath = fileURLToPath(new URL("./runner.mjs", import.meta.url));

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(value), "utf8");
	fs.renameSync(temp, file);
}

function formattedOutput(output: string): string {
	const result = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return result.truncated
		? `[Showing last ${result.outputLines} of ${result.totalLines} lines]\n${result.content}`
		: result.content;
}

type NewSurface = {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	placement: "tab" | "workspace";
};

type CompletionConfig = {
	marker: string;
	title: string;
	paneId: string;
	logFile: string;
	signalFile: string;
};

function completionDir(): string {
	return path.join(os.homedir(), ".pi", "yahe", String(process.pid));
}

export default function herdrExtension(pi: ExtensionAPI) {
	const callerPaneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !callerPaneId) return;

	async function execHerdr(args: string[], cwd?: string, signal?: AbortSignal, timeout = 120_000): Promise<string> {
		const result = await pi.exec("herdr", args, { cwd, signal, timeout });
		if (result.killed || signal?.aborted) throw new Error("Herdr command cancelled");
		if (result.code !== 0) throw new Error((result.stderr || result.stdout || `herdr ${args.join(" ")} failed`).trim());
		return [result.stdout, result.stderr].filter(Boolean).join("").trim();
	}

	async function projectScope(cwd?: string): Promise<string | undefined> {
		if (!cwd) return undefined;
		let resolved: string;
		try { resolved = fs.realpathSync(cwd); }
		catch { resolved = path.resolve(cwd); }
		const result = await pi.exec("git", ["-C", resolved, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
		if (result.code !== 0) return resolved;
		try { return fs.realpathSync(result.stdout.trim()); }
		catch { return result.stdout.trim(); }
	}

	async function panes(cwd?: string, signal?: AbortSignal): Promise<PaneInfo[]> {
		const output = await execHerdr(["pane", "list"], cwd, signal);
		return JSON.parse(output)?.result?.panes ?? [];
	}

	async function targetPane(params: any, cwd?: string, signal?: AbortSignal): Promise<PaneInfo> {
		const all = await panes(cwd, signal);
		const paneId = params.paneId || callerPaneId;
		const pane = all.find((candidate) => candidate.pane_id === paneId);
		if (!pane) throw new Error(`Herdr pane not found: ${paneId}`);
		return pane;
	}

	async function createSurface(params: any, cwd: string | undefined, label: string, signal?: AbortSignal): Promise<NewSurface> {
		const all = await panes(cwd, signal);
		const sourceId = params.paneId || callerPaneId;
		const source = all.find((pane) => pane.pane_id === sourceId);
		if (!source) throw new Error(`Herdr pane not found: ${sourceId}`);

		const surfaceCwd = cwd ?? source.foreground_cwd ?? source.cwd;
		let workspaceId = source.workspace_id;
		if (!params.paneId && cwd) {
			const scoped = await Promise.all(all.map(async (pane): Promise<ScopedPane> => ({
				...pane,
				scope: await projectScope(pane.foreground_cwd ?? pane.cwd),
			})));
			const scopedSource = scoped.find((pane) => pane.pane_id === source.pane_id)!;
			const scope = await projectScope(cwd);
			const destination = scope ? workspaceForTask(scopedSource, scoped, scope) : source.workspace_id;
			if (!destination) {
				const args = ["workspace", "create", "--cwd", cwd, "--label", path.basename(scope || cwd), params.focus === true ? "--focus" : "--no-focus"];
				const output = await execHerdr(args, cwd, signal);
				const result = JSON.parse(output)?.result;
				const paneId = result?.root_pane?.pane_id;
				const tabId = result?.tab?.tab_id ?? result?.root_pane?.tab_id;
				const createdWorkspaceId = result?.workspace?.workspace_id ?? result?.root_pane?.workspace_id;
				if (!paneId) throw new Error(`Could not find new workspace pane in: ${output}`);
				if (tabId) await execHerdr(["tab", "rename", tabId, label], cwd, signal);
				await new Promise((resolve) => setTimeout(resolve, 250));
				return { paneId, tabId, workspaceId: createdWorkspaceId, placement: "workspace" };
			}
			workspaceId = destination;
		}

		const args = ["tab", "create", "--workspace", workspaceId, "--label", label];
		if (surfaceCwd) args.push("--cwd", surfaceCwd);
		args.push(params.focus === true ? "--focus" : "--no-focus");
		const output = await execHerdr(args, cwd, signal);
		const result = JSON.parse(output)?.result;
		const paneId = result?.root_pane?.pane_id;
		if (!paneId) throw new Error(`Could not find new tab pane in: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
		return { paneId, tabId: result?.tab?.tab_id ?? result?.root_pane?.tab_id, placement: "tab" };
	}

	type Cleanup = { kind: "pane" | "tab" | "workspace"; id: string };

	function surfaceCleanup(surface: NewSurface, closeOnDone: boolean): Cleanup | undefined {
		if (!closeOnDone) return undefined;
		if (surface.placement === "workspace" && surface.workspaceId) return { kind: "workspace", id: surface.workspaceId };
		if (surface.tabId) return { kind: "tab", id: surface.tabId };
		return { kind: "pane", id: surface.paneId };
	}

	// Close a created surface when task startup fails, so tabs/workspaces do not leak.
	async function withSurfaceCleanup<T>(surface: NewSurface | undefined, cwd: string | undefined, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		try { return await fn(); }
		catch (error) {
			const cleanup = surface ? surfaceCleanup(surface, true) : undefined;
			if (cleanup) { try { await execHerdr([cleanup.kind, "close", cleanup.id], cwd, signal); } catch {} }
			throw error;
		}
	}

	function runnerInvocation(config: Record<string, unknown>): string {
		const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
		return `${shellQuote(process.execPath)} ${shellQuote(runnerPath)} ${shellQuote(encoded)}`;
	}

	function commandRunner(command: string, title: string, paneId: string, cwd: string | undefined, surface?: NewSurface, closeOnDone = true, monitor = false) {
		const marker = monitor ? `YAHE_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined;
		const logFile = marker ? path.join(completionDir(), `${marker}.log`) : undefined;
		const signalFile = marker ? path.join(completionDir(), `${marker}.json`) : undefined;
		const body = runnerInvocation({
			mode: "command", command, title, paneId, cwd, marker, logFile, signalFile,
			cleanup: surface ? surfaceCleanup(surface, closeOnDone) : undefined,
			notify: monitor,
		});
		return { body, marker };
	}

	function backgroundPiRunner(prompt: string, title: string, piArgs: string[], config: CompletionConfig, surface: NewSurface, closeOnDone: boolean, cwd?: string): string {
		return runnerInvocation({
			mode: "pi",
			title,
			cwd,
			args: ["--no-session", "--name", title, "--extension", extensionPath, ...piArgs, prompt],
			completion: config,
			cleanup: surfaceCleanup(surface, closeOnDone),
			notify: true,
		});
	}

	const backgroundConfig = (() => {
		try {
			const encoded = process.env.PI_YAHE_RUN_CONFIG;
			return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as CompletionConfig : undefined;
		} catch { return undefined; }
	})();
	let childReported = false;
	let pendingAsyncTasks = 0;
	let watcher: fs.FSWatcher | undefined;
	const pendingDeliveries = new Set<string>();

	if (backgroundConfig) {
		pi.on("agent_settled", (_event, ctx) => {
			// Contract: defer reporting while async tasks are outstanding; the nested task's steer
			// (triggerTurn) fires the next agent_settled, which reports then.
			if (childReported || pendingAsyncTasks > 0) return;
			childReported = true;
			try {
				const result = lastAssistantResult(ctx.sessionManager.getBranch());
				fs.writeFileSync(backgroundConfig.logFile, result.output, "utf8");
				// Write the .reported marker before the signal: the runner's fallback checks the marker,
				// not the signal file, so it cannot mistake a consumed signal for a missing report.
				fs.writeFileSync(`${backgroundConfig.signalFile}.reported`, String(result.exitCode), "utf8");
				writeJsonAtomic(backgroundConfig.signalFile, { ...backgroundConfig, exitCode: result.exitCode });
			} finally {
				ctx.shutdown();
			}
		});
	}

	pi.on("session_start", (_event, ctx) => {
		fs.rmSync(completionDir(), { recursive: true, force: true }); // Clear stale files from crashes/pid reuse so signals cannot bleed across sessions.
		fs.mkdirSync(completionDir(), { recursive: true, mode: 0o700 });
		watcher?.close();
		const deliver = (file: string) => {
			if (pendingDeliveries.has(file)) return;
			pendingDeliveries.add(file);
			setTimeout(() => {
				try {
					const payload = JSON.parse(fs.readFileSync(file, "utf8"));
					let captured = "";
					try { captured = fs.readFileSync(payload.logFile, "utf8"); } catch {}
					const truncated = truncateTail(captured, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
					if (!truncated.truncated) fs.rmSync(payload.logFile, { force: true });
					const fullLog = truncated.truncated ? `\nFull output: ${payload.logFile}` : "";
					// Also point at the child worker's full run log (if any), so output survives tab close.
					let runLogHint = "";
					try { if (fs.existsSync(`${payload.logFile}.run`)) runLogHint = `\nFull worker output: ${payload.logFile}.run`; } catch {}
					const content = `Herdr task completed: ${payload.title ?? "task"} exited ${payload.exitCode}.` +
						(truncated.content ? `\n\n${truncated.content}` : "") + fullLog + runLogHint;
					ctx.ui.notify(`Herdr task completed: ${payload.title ?? "task"} exited ${payload.exitCode}`, payload.exitCode === 0 ? "info" : "warning");
					pi.sendMessage({
						customType: "yahe-result",
						content,
						display: true,
						details: payload,
					}, { deliverAs: "steer", triggerTurn: true });
				} catch {
					// Corrupt completion signal (rare under atomic rename): delete so delivery cannot wedge.
				} finally {
					fs.rmSync(file, { force: true }); // Consume the signal file exactly once, on success or failure.
					pendingAsyncTasks = Math.max(0, pendingAsyncTasks - 1);
					pendingDeliveries.delete(file);
				}
			}, 200);
		};
		for (const filename of fs.readdirSync(completionDir())) if (filename.endsWith(".json")) deliver(path.join(completionDir(), filename));
		watcher = fs.watch(completionDir(), (_type, filename) => {
			if (filename?.endsWith(".json")) deliver(path.join(completionDir(), filename));
		});
	});

	pi.on("session_shutdown", () => {
		watcher?.close();
		watcher = undefined;
		fs.rmSync(completionDir(), { recursive: true, force: true }); // Session over; sidecar files are no longer needed.
	});

	pi.registerTool({
		name: "herdr",
		label: "Herdr",
		description: "A single composable control surface for Herdr. Run commands, create fresh task-shaped Pi workers, interact with persistent agents, and route work by project. No roles, squads, or delegation graph are predefined: the current agent assembles only the process tree the task needs. Long tasks can complete asynchronously and steer results back. Requires Pi inside Herdr 0.7.5+.",
		promptSnippet: "Compose visible Herdr commands and temporary Pi workers when the task benefits from parallel or independent work",
		promptGuidelines: [
			"Use herdr only after understanding the task; do not spawn agents merely because the tool exists.",
			"Use herdr run_pi for independent one-shot work. It returns immediately and automatically steers the result back; never poll it.",
			"Shape run_pi workers with piArgs when narrower tools, another model, or different thinking is useful. Prefer the least authority the task needs.",
			"Use herdr spawn_pi only when the worker needs follow-up conversation; otherwise prefer run_pi.",
			"Use herdr monitor for long commands and continue independent work while they run.",
			"Give concurrent writers separate worktrees with herdr worktree_create.",
		],
		parameters: Params,
		async execute(_id, params: any, signal): Promise<any> {
			const cwd = params.cwd;
			switch (params.action) {
				case "pane_list": return { content: [{ type: "text", text: formattedOutput(await execHerdr(["pane", "list"], cwd, signal)) }], details: { action: params.action } };
				case "worktree_list": {
					const args = ["worktree", "list", "--json"];
					if (cwd) args.push("--cwd", cwd);
					else args.push("--workspace", (await targetPane(params, cwd, signal)).workspace_id);
					return { content: [{ type: "text", text: formattedOutput(await execHerdr(args, cwd, signal)) }], details: { action: params.action } };
				}
				case "worktree_create": {
					if (!params.branch) throw new Error("branch is required for worktree_create");
					const args = ["worktree", "create", "--branch", params.branch];
					if (cwd) args.push("--cwd", cwd);
					else args.push("--workspace", (await targetPane(params, cwd, signal)).workspace_id);
					if (params.base) args.push("--base", params.base);
					if (params.label) args.push("--label", params.label);
					args.push(params.focus === true ? "--focus" : "--no-focus");
					return { content: [{ type: "text", text: await execHerdr(args, cwd, signal) }], details: { action: params.action } };
				}
				case "pane_close": {
					if (!params.paneId) throw new Error("paneId is required for pane_close");
					if (params.paneId === callerPaneId) throw new Error("Refusing to close the pane running the current Pi");
					return { content: [{ type: "text", text: await execHerdr(["pane", "close", params.paneId], cwd, signal) || `Closed ${params.paneId}` }], details: { action: params.action, paneId: params.paneId } };
				}
				case "read": {
					const paneId = (await targetPane(params, cwd, signal)).pane_id;
					const output = await execHerdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(params.lines ?? 80)], cwd, signal);
					return { content: [{ type: "text", text: formattedOutput(output) }], details: { action: params.action, paneId } };
				}
				case "send_text": {
					if (params.text == null) throw new Error("text is required for send_text");
					const paneId = (await targetPane(params, cwd, signal)).pane_id;
					await execHerdr(["pane", "send-text", paneId, params.text], cwd, signal);
					return { content: [{ type: "text", text: `Sent text to ${paneId}` }], details: { action: params.action, paneId } };
				}
				case "send_keys": {
					if (!params.keys?.length) throw new Error("keys are required for send_keys");
					const paneId = (await targetPane(params, cwd, signal)).pane_id;
					await execHerdr(["pane", "send-keys", paneId, ...params.keys], cwd, signal);
					return { content: [{ type: "text", text: `Sent ${params.keys.join(" ")} to ${paneId}` }], details: { action: params.action, paneId } };
				}
				case "run_in_pane": {
					if (!params.command) throw new Error("command is required for run_in_pane");
					const paneId = (await targetPane(params, cwd, signal)).pane_id;
					await execHerdr(["pane", "run", paneId, params.command], cwd, signal);
					return { content: [{ type: "text", text: `Started command in ${paneId}` }], details: { action: params.action, paneId } };
				}
				case "run": {
					if (!params.command) throw new Error("command is required for run");
					const title = taskLabel(params.label, params.command, "task");
					const surface = await createSurface(params, cwd, title, signal);
					const wrapped = commandRunner(params.command, title, surface.paneId, cwd, surface, params.closeOnDone !== false);
					await withSurfaceCleanup(surface, cwd, signal, () => execHerdr(["pane", "run", surface.paneId, wrapped.body], cwd, signal));
					return { content: [{ type: "text", text: `Started command in ${surface.placement} pane ${surface.paneId}` }], details: { action: params.action, ...surface } };
				}
				case "monitor": {
					if (!params.command) throw new Error("command is required for monitor");
					const title = taskLabel(params.label, params.command, "task");
					let paneId = params.paneId;
					let surface: NewSurface | undefined;
					if (!paneId) { surface = await createSurface(params, cwd, title, signal); paneId = surface.paneId; }
					const wrapped = commandRunner(params.command, title, paneId, cwd, surface, params.closeOnDone !== false, true);
					pendingAsyncTasks++;
					try { await withSurfaceCleanup(surface, cwd, signal, () => execHerdr(["pane", "run", paneId, wrapped.body], cwd, signal)); }
					catch (error) { pendingAsyncTasks--; throw error; }
					return { content: [{ type: "text", text: `Monitoring ${title} in pane ${paneId}. Continue other work; completion ${wrapped.marker} will arrive automatically.` }], details: { action: params.action, paneId, marker: wrapped.marker } };
				}
				case "run_pi": {
					if (!params.prompt) throw new Error("prompt is required for run_pi");
					validateOneShotPiArgs(params.piArgs ?? []);
					const title = taskLabel(params.label, params.prompt, "pi task");
					const surface = await createSurface(params, cwd, title, signal);
					const marker = `YAHE_PI_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
					const config: CompletionConfig = {
						marker, title, paneId: surface.paneId,
						logFile: path.join(completionDir(), `${marker}.log`),
						signalFile: path.join(completionDir(), `${marker}.json`),
					};
					pendingAsyncTasks++;
					try { await withSurfaceCleanup(surface, cwd, signal, () => execHerdr(["pane", "run", surface.paneId, backgroundPiRunner(params.prompt, title, params.piArgs ?? [], config, surface, params.closeOnDone !== false, cwd)], cwd, signal)); }
					catch (error) { pendingAsyncTasks--; throw error; }
					return { content: [{ type: "text", text: `Started fresh Pi worker in ${surface.placement} pane ${surface.paneId}. Do not poll; ${marker} will steer the result back.` }], details: { action: params.action, marker, ...surface } };
				}
				case "spawn_pi": {
					const title = taskLabel(params.label, params.prompt, "pi worker");
					const surface = await createSurface(params, cwd, title, signal);
					const agentId = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
					await withSurfaceCleanup(surface, cwd, signal, async () => {
						await execHerdr(["agent", "start", agentId, "--kind", "pi", "--pane", surface.paneId, "--timeout", "20000", "--", "--name", title, ...(params.piArgs ?? [])], cwd, signal, 30_000);
						if (params.prompt) await execHerdr(["agent", "prompt", agentId, params.prompt], cwd, signal);
					});
					return { content: [{ type: "text", text: `Spawned interactive Pi ${agentId} in pane ${surface.paneId}` }], details: { action: params.action, agentId, ...surface } };
				}
				case "agent_list": return { content: [{ type: "text", text: formattedOutput(await execHerdr(["agent", "list"], cwd, signal)) }], details: { action: params.action } };
				case "agent_read": {
					const agentId = params.agentId || params.paneId || callerPaneId;
					const output = await execHerdr(["agent", "read", agentId, "--source", "recent-unwrapped", "--lines", String(params.lines ?? 80)], cwd, signal);
					return { content: [{ type: "text", text: formattedOutput(output) }], details: { action: params.action, agentId } };
				}
				case "agent_prompt": {
					if (params.text == null) throw new Error("text is required for agent_prompt");
					const agentId = params.agentId || params.paneId || callerPaneId;
					await execHerdr(["agent", "prompt", agentId, params.text], cwd, signal);
					return { content: [{ type: "text", text: `Prompted ${agentId}` }], details: { action: params.action, agentId } };
				}
				case "agent_wait": {
					const agentId = params.agentId || params.paneId || callerPaneId;
					const timeout = params.timeoutMs ?? 60_000;
					const args = ["agent", "wait", agentId];
					if (params.status) args.push("--until", params.status);
					args.push("--timeout", String(timeout));
					return { content: [{ type: "text", text: await execHerdr(args, cwd, signal, timeout + 5_000) }], details: { action: params.action, agentId } };
				}
			}
			throw new Error(`Unknown action: ${params.action}`);
		},
	});
}
