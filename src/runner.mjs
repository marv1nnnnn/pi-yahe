import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

function decode(value) {
	return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function encode(value) {
	return Buffer.from(JSON.stringify(value)).toString("base64");
}

function writeJsonAtomic(file, value) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(value), "utf8");
	renameSync(temp, file);
}

function shellInvocation(command) {
	const shell = process.env.SHELL || process.env.COMSPEC || "/bin/sh";
	const name = basename(shell).toLowerCase();
	if (name === "nu" || name === "nu.exe") return { command: shell, args: ["--login", "-c", command] };
	if (name === "pwsh" || name === "pwsh.exe" || name === "powershell" || name === "powershell.exe") {
		return { command: shell, args: ["-NoLogo", "-Command", command] };
	}
	return { command: shell, args: ["-lc", command] };
}

function cleanup(config) {
	if (!config) return;
	spawnSync("herdr", [config.kind, "close", config.id], { stdio: "ignore" });
}

function notify(title, exitCode) {
	spawnSync("herdr", ["notification", "show", title, "--body", `exit ${exitCode}`, "--sound", "done"], { stdio: "ignore" });
}

async function runChild(command, args, options = {}) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (code, log) => {
			if (settled) return;
			settled = true;
			if (log) log.end(() => resolve(code));
			else resolve(code);
		};
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env || process.env,
			stdio: options.logFile ? ["inherit", "pipe", "pipe"] : "inherit",
		});
		let log;
		if (options.logFile) {
			mkdirSync(dirname(options.logFile), { recursive: true, mode: 0o700 });
			log = createWriteStream(options.logFile);
			child.stdout.on("data", (chunk) => { process.stdout.write(chunk); log.write(chunk); });
			child.stderr.on("data", (chunk) => { process.stderr.write(chunk); log.write(chunk); });
		}
		child.on("error", (error) => {
			if (log) log.write(`${error.message}\n`);
			finish(1, log);
		});
		child.on("close", (code) => finish(code ?? 1, log));
	});
}

const config = decode(process.argv[2] || "");
let exitCode = 1;

if (config.mode === "pi") {
	const completion = config.completion;
	exitCode = await runChild("pi", config.args, {
		cwd: config.cwd,
		env: { ...process.env, PI_YAHE_RUN_CONFIG: encode(completion) },
		// Persist the child's full output so evidence survives tab close.
		logFile: `${completion.logFile}.run`,
	});
	if (!existsSync(`${completion.signalFile}.reported`)) {
		// Worker exited without reporting: append the run-log tail so the parent can see what it actually did.
		// Check the .reported marker, not the signal file itself: the parent may have already consumed it.
		let tail = "";
		try {
			const runLog = `${completion.logFile}.run`;
			if (existsSync(runLog)) tail = `\n\n--- worker output ---\n${readFileSync(runLog, "utf8").slice(-4000)}`;
		} catch {}
		writeFileSync(completion.logFile, `Child Pi exited before reporting completion.${tail}`, "utf8");
		writeJsonAtomic(completion.signalFile, { ...completion, exitCode: exitCode || 1 });
	}
} else {
	const invocation = shellInvocation(config.command);
	exitCode = await runChild(invocation.command, invocation.args, { cwd: config.cwd, logFile: config.logFile });
	if (config.signalFile) {
		writeJsonAtomic(config.signalFile, {
			marker: config.marker,
			title: config.title,
			paneId: config.paneId,
			logFile: config.logFile,
			closeOnDone: Boolean(config.cleanup),
			exitCode,
		});
	}
}

if (config.notify) notify(config.title, exitCode);
if (config.cleanup) cleanup(config.cleanup);
process.exit(exitCode);
