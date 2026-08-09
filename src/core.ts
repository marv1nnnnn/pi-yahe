export type PaneInfo = {
	pane_id: string;
	workspace_id: string;
	tab_id?: string;
	cwd?: string;
	foreground_cwd?: string;
	focused?: boolean;
};

export type ScopedPane = PaneInfo & { scope?: string };

export function lastAssistantResult(entries: any[]): { output: string; exitCode: number } {
	let exitCode = 1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = entries[i]?.type === "message" ? entries[i].message : undefined;
		if (message?.role !== "assistant") continue;
		const text = typeof message.content === "string"
			? message.content.trim()
			: Array.isArray(message.content)
				? message.content
					.filter((part: any) => part?.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text)
					.join("\n")
					.trim()
				: "";
		const failed = ["error", "aborted", "length"].includes(message.stopReason);
		exitCode = failed ? 1 : 0;
		if (text) return { output: text, exitCode };
		if (failed) return { output: message.errorMessage || "(no output)", exitCode: 1 };
	}
	return { output: "(no output)", exitCode };
}

export function taskLabel(label: unknown, hint: unknown, fallback: string): string {
	const raw = [label, hint, fallback].find((value) => value != null && String(value).trim());
	const text = String(raw ?? fallback).split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim() || fallback;
	return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

export function workspaceForTask(source: ScopedPane, panes: ScopedPane[], targetScope: string): string | undefined {
	if (source.scope === targetScope) return source.workspace_id;
	const workspaceIds = [...new Set(panes.filter((pane) => pane.scope === targetScope).map((pane) => pane.workspace_id))];
	return workspaceIds.find((id) => panes.filter((pane) => pane.workspace_id === id).every((pane) => pane.scope === targetScope));
}

const ONE_SHOT_RESERVED_ARGS = new Set([
	"--continue", "-c", "--fork", "--mode", "--no-extensions", "-ne", "--print", "-p", "--resume", "-r", "--session", "--session-id",
	"--extension", "-e", "--name", // Overriding these would break the worker's completion report or its title.
]);

export function validateOneShotPiArgs(args: string[]): void {
	const invalid = args.find((arg) => ONE_SHOT_RESERVED_ARGS.has(arg) || arg.startsWith("--mode=") || arg.startsWith("--session="));
	if (invalid) throw new Error(`piArgs cannot contain ${invalid}; run_pi owns worker lifecycle. Use spawn_pi for persistent sessions.`);
}
