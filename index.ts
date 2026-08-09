// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	getPackageDir,
	hasTrustRequiringProjectResources,
	InteractiveMode,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { SessionWidget, showSessionsView } from "./ui.ts";

const PARENT_SESSION_ID = "__parent__";
const HOST_KEY = "__PI_SESSIONS_HOST__";
const STATE_FILE_PREFIX = "pi-sessions-state-";
const STATE_FILE_VERSION = 1;

function stateFilePath(sessionId: string | undefined): string | null {
	if (!sessionId) return null;
	// Session ids are uuidv7 (hex + dashes), safe for filenames.
	return path.join(getAgentDir(), `${STATE_FILE_PREFIX}${sessionId}.json`);
}

function listStateFiles(): string[] {
	try {
		return fs
			.readdirSync(getAgentDir())
			.filter(
				(name) =>
					name.startsWith(STATE_FILE_PREFIX) && name.endsWith(".json"),
			)
			.map((name) => path.join(getAgentDir(), name));
	} catch {
		return [];
	}
}

function readStateFile(file: string): any {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (
			parsed?.version === STATE_FILE_VERSION &&
			Array.isArray(parsed.sessions)
		) {
			return parsed;
		}
	} catch {}
	return null;
}

const INTERACTIVE_MODE_SPINNER_PATCHED = Symbol.for(
	"pi-sessions.interactiveMode.spinnerPatched",
);

type ExtensionAPI = any;
type CommandContext = any;
type Activity = "idle" | "working";
type LiveState = "active" | "suspended" | "starting" | "stopped" | "error";
type WorkingIndicatorOptions = { frames?: string[]; intervalMs?: number };

type LiveSessionRecord = {
	id: string;
	kind: "parent" | "child";
	name: string;
	cwd: string;
	state: LiveState;
	activity: Activity;
	sessionFile?: string;
	sessionId?: string;
	parentSessionFile?: string;
	parentLeafId?: string | null;
	createdAt: number;
	lastActivityAt: number;
	status?: string;
	transcript?: string;
	runtime?: any;
	mode?: any;
	adapter?: InteractiveModeAdapter;
	sessionManager?: any;
	context?: CommandContext;
	inheritance?: any;
	started?: boolean;
	runPromise?: Promise<void>;
	expectedStop?: boolean;
	error?: string;
};

function readFirstMessage(filePath: string | undefined): string {
	if (!filePath) return "";
	try {
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (!msg || msg.role !== "user") continue;
				const text =
					typeof msg.content === "string"
						? msg.content
						: Array.isArray(msg.content)
							? msg.content
									.filter((p: any) => p.type === "text")
									.map((p: any) => p.text)
									.join(" ")
							: "";
				if (text.trim()) return text.trim().slice(0, 200);
			} catch {}
		}
	} catch {}
	return "";
}

function resolveTranscriptName(
	sessionName?: string,
	sessionFile?: string,
): string {
	return sessionName || readFirstMessage(sessionFile) || "";
}

function sanitizeName(name: string): string {
	return (
		String(name || "")
			.trim()
			.replace(/[^a-zA-Z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || `session-${Date.now().toString(36)}`
	);
}

let modelResolverPromise: Promise<any> | null = null;
const runtimeInheritanceBySessionManager = new WeakMap<object, any>();

// CLI-loaded resource paths (from `-e`/`--extension`, `--skill`, ...) plus the
// no-* toggles and system-prompt overrides. Captured from process.argv so child
// runtimes built by this extension get the same extensions the parent got via
// the command line (settings.json `packages` are re-read by the child loader).
let cliResourceLoaderOptions: Record<string, any> = {};

// Absolute path of this extension module, for self-registration into child
// runtimes as a safety net when it was loaded via an unusual mechanism.
const THIS_EXTENSION_PATH: string | undefined = (() => {
	try {
		return typeof import.meta.url === "string"
			? fileURLToPath(import.meta.url)
			: undefined;
	} catch {
		return undefined;
	}
})();

function resolveCliResourcePath(value: string): string {
	if (value.startsWith("~")) value = path.join(os.homedir(), value.slice(1));
	return path.resolve(value);
}

/**
 * Mirror pi's own CLI parsing (cli/args.js) for the resource options that the
 * main process feeds into its DefaultResourceLoader, so parallel child runtimes
 * load the same command-line extensions/skills/prompts/themes.
 */
function collectCliResourceLoaderOptions(
	argv: string[],
): Record<string, any> {
	const extensions: string[] = [];
	const skills: string[] = [];
	const promptTemplates: string[] = [];
	const themes: string[] = [];
	const appendSystemPrompt: string[] = [];
	const flags = new Set<string>();
	let systemPrompt: string | undefined;
	let i = 0;
	const takeValue = (): string | undefined => {
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("-")) return argv[++i];
		return undefined;
	};
	for (; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--extension" || arg === "-e") {
			const value = takeValue();
			if (value) extensions.push(value);
		} else if (arg === "--skill") {
			const value = takeValue();
			if (value) skills.push(value);
		} else if (arg === "--prompt-template") {
			const value = takeValue();
			if (value) promptTemplates.push(value);
		} else if (arg === "--theme") {
			const value = takeValue();
			if (value) themes.push(value);
		} else if (arg === "--system-prompt") {
			const value = takeValue();
			if (value) systemPrompt = value;
		} else if (arg === "--append-system-prompt") {
			const value = takeValue();
			if (value) appendSystemPrompt.push(value);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			flags.add("noExtensions");
		} else if (arg === "--no-skills") {
			flags.add("noSkills");
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			flags.add("noPromptTemplates");
		} else if (arg === "--no-themes") {
			flags.add("noThemes");
		} else if (arg === "--no-context-files" || arg === "-nc") {
			flags.add("noContextFiles");
		}
	}
	if (THIS_EXTENSION_PATH) extensions.push(THIS_EXTENSION_PATH);
	const dedupe = (values: string[]): string[] => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const value of values) {
			const resolved = resolveCliResourcePath(value);
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			out.push(resolved);
		}
		return out;
	};
	return {
		additionalExtensionPaths: dedupe(extensions),
		additionalSkillPaths: dedupe(skills),
		additionalPromptTemplatePaths: dedupe(promptTemplates),
		additionalThemePaths: dedupe(themes),
		noExtensions: flags.has("noExtensions"),
		noSkills: flags.has("noSkills"),
		noPromptTemplates: flags.has("noPromptTemplates"),
		noThemes: flags.has("noThemes"),
		noContextFiles: flags.has("noContextFiles"),
		systemPrompt,
		appendSystemPrompt,
	};
}

async function loadModelResolver(): Promise<any> {
	modelResolverPromise ??= import(
		pathToFileURL(path.join(getPackageDir(), "dist/core/model-resolver.js"))
			.href
	);
	return await modelResolverPromise;
}

function sameModel(a: any, b: any): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function hasExistingMessages(sessionManager: any): boolean {
	return (sessionManager.buildSessionContext?.().messages?.length ?? 0) > 0;
}

function inferThinkingLevel(ctx: CommandContext): string | undefined {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "thinking_level_change" && entry.thinkingLevel) {
			return entry.thinkingLevel;
		}
	}
	return undefined;
}

function collectRuntimeInheritance(ctx?: CommandContext): any {
	if (!ctx) return {};
	const promptOptions = ctx.getSystemPromptOptions?.() ?? {};
	const sessionOptions: any = {};
	if (Array.isArray(promptOptions.selectedTools)) {
		sessionOptions.tools = [...promptOptions.selectedTools];
	}
	if (ctx.model) sessionOptions.model = ctx.model;
	const thinkingLevel = inferThinkingLevel(ctx);
	if (thinkingLevel) sessionOptions.thinkingLevel = thinkingLevel;
	return {
		ctx,
		authStorage: ctx.modelRegistry?.authStorage,
		sessionOptions,
	};
}

function safeCollectRuntimeInheritance(ctx?: CommandContext): any {
	try {
		return collectRuntimeInheritance(ctx);
	} catch {
		return {};
	}
}

function createInheritedSettingsManager(
	cwd: string,
	agentDir: string,
	inheritance: any,
): { settingsManager: any; diagnostics: any[] } {
	const diagnostics: any[] = [];
	const sameCwd =
		inheritance?.ctx?.cwd &&
		path.resolve(inheritance.ctx.cwd) === path.resolve(cwd);
	let projectTrusted = true;
	if (sameCwd) {
		projectTrusted = inheritance.ctx.isProjectTrusted?.() ?? true;
	} else if (hasTrustRequiringProjectResources(cwd)) {
		const trustStore = new ProjectTrustStore(agentDir);
		projectTrusted = trustStore.get(cwd) === true;
		if (!projectTrusted) {
			diagnostics.push({
				type: "warning",
				message: `Project resources in child cwd are not trusted: ${cwd}`,
			});
		}
	}
	return {
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }),
		diagnostics,
	};
}

async function resolveChildSessionOptions(
	services: any,
	sessionManager: any,
	inheritance: any,
): Promise<any> {
	const options: any = { ...(inheritance?.sessionOptions ?? {}) };
	const existing = hasExistingMessages(sessionManager);
	if (existing) {
		delete options.model;
		delete options.thinkingLevel;
	}

	const patterns = services.settingsManager?.getEnabledModels?.();
	if (!patterns?.length) return options;

	const { resolveModelScope } = await loadModelResolver();
	const scopedModels = await resolveModelScope(
		patterns,
		services.modelRegistry,
	);
	if (!scopedModels.length) return options;

	options.scopedModels = scopedModels;
	if (!existing) {
		const inheritedModel = inheritance?.sessionOptions?.model;
		const savedProvider = services.settingsManager?.getDefaultProvider?.();
		const savedModelId = services.settingsManager?.getDefaultModel?.();
		const savedModel =
			savedProvider && savedModelId
				? services.modelRegistry.find(savedProvider, savedModelId)
				: undefined;
		const selected =
			scopedModels.find((scoped: any) =>
				sameModel(scoped.model, inheritedModel),
			) ??
			scopedModels.find((scoped: any) => sameModel(scoped.model, savedModel)) ??
			scopedModels[0];
		options.model = selected.model;
		if (selected.thinkingLevel) options.thinkingLevel = selected.thinkingLevel;
	}

	return options;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function inferToolPaths(toolName: string, input: any): string[] {
	const paths = new Set<string>();
	if (toolName === "write" || toolName === "edit") {
		const p =
			asString(input?.path) ||
			asString(input?.file_path) ||
			asString(input?.filePath);
		if (p) paths.add(p);
	}
	if (toolName === "bash") {
		const command = asString(input?.command) || "";
		const redir = [...command.matchAll(/(?:>|>>|2>|&>)\s*([^\s;&|]+)/g)].map(
			(m) => m[1],
		);
		for (const p of redir) {
			if (p && !p.startsWith("/dev/")) paths.add(p.replace(/^["']|["']$/g, ""));
		}
		const mutating =
			/\b(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|install|tee|sed\s+-i|perl\s+-i|python\b.*\b(open|write)|node\b.*writeFile)\b/.test(
				command,
			);
		if (mutating) {
			const tokens = command.match(/(?:\.\.?|~|\/)?[\w@%+=:,./-]+/g) || [];
			for (const token of tokens) {
				if (token.includes("/") || token.startsWith("."))
					paths.add(token.replace(/^["']|["']$/g, ""));
			}
			if (paths.size === 0) paths.add(".");
		}
	}
	return [...paths];
}

function resetExtendedKeyboardModesForHandoff(): void {
	try {
		process.stdout.write("\x1b[<999u\x1b[>4;0m");
	} catch {}
}

function normalizeLockPath(p: string, cwd: string): string | null {
	if (!p || typeof p !== "string") return null;
	if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
	return path.resolve(cwd || process.cwd(), p);
}

function pathsConflict(a: string, b: string): boolean {
	const ar = a.endsWith(path.sep) ? a : a + path.sep;
	const br = b.endsWith(path.sep) ? b : b + path.sep;
	return a === b || a.startsWith(br) || b.startsWith(ar);
}

class LockManager {
	locks = new Map<string, { sessionId: string; acquiredAt: number }>();
	heldByToolCall = new Map<string, { sessionId: string; paths: string[] }>();

	acquire(sessionId: string, rawPaths: string[], cwd: string) {
		const paths = [
			...new Set(
				(rawPaths || []).map((p) => normalizeLockPath(p, cwd)).filter(Boolean),
			),
		].sort();
		const conflicts = [];
		for (const p of paths) {
			for (const [held, info] of this.locks.entries()) {
				if (info.sessionId !== sessionId && pathsConflict(p, held)) {
					conflicts.push({ path: p, heldPath: held, by: info.sessionId });
				}
			}
		}
		if (conflicts.length) return { ok: false, conflicts };
		const acquiredAt = Date.now();
		for (const p of paths) this.locks.set(p, { sessionId, acquiredAt });
		return { ok: true, paths };
	}

	release(sessionId: string, rawPaths?: string[]) {
		const wanted = rawPaths?.length ? new Set(rawPaths) : null;
		const released = [];
		for (const [p, info] of this.locks.entries()) {
			if (info.sessionId === sessionId && (!wanted || wanted.has(p))) {
				this.locks.delete(p);
				released.push(p);
			}
		}
		return released;
	}

	releaseByToolCall(toolCallId: string) {
		const held = this.heldByToolCall.get(toolCallId);
		if (!held) return [];
		this.heldByToolCall.delete(toolCallId);
		return this.release(held.sessionId, held.paths);
	}
}

class InteractiveModeAdapter {
	state: "never-started" | "active" | "suspended" | "stopped" = "never-started";
	private terminalGateInstalled = false;
	private originalSetProgress?: any;
	private originalSetTitle?: any;

	constructor(
		readonly id: string,
		readonly runtime: any,
		readonly mode: any,
		private readonly host: PiSessionsHost,
	) {}

	get ui(): any {
		return (this.mode as any).ui;
	}

	installTerminalGate(): void {
		if (this.terminalGateInstalled) return;
		const terminal = this.ui?.terminal;
		if (!terminal) return;
		this.terminalGateInstalled = true;
		this.originalSetProgress = terminal.setProgress?.bind(terminal);
		this.originalSetTitle = terminal.setTitle?.bind(terminal);
		if (this.originalSetProgress) {
			terminal.setProgress = (active: boolean) => {
				if (this.host.activeId === this.id) this.originalSetProgress(active);
			};
		}
		if (this.originalSetTitle) {
			terminal.setTitle = (...args: any[]) => {
				if (this.host.activeId === this.id) this.originalSetTitle(...args);
			};
		}
	}

	start(): void {
		if (this.state !== "never-started") return this.resume();
		this.installTerminalGate();
		this.state = "active";
		const record = this.host.get(this.id);
		if (record) {
			record.started = true;
			record.state = "active";
			record.runPromise = this.mode.run().catch((error: any) => {
				record.state = record.expectedStop ? "stopped" : "error";
				record.error = String(error?.message || error);
				record.status = record.error;
				this.host.locks.release(record.id);
				this.host.notify();
			});
		} else {
			void this.mode.run();
		}
	}

	suspend(): void {
		if (this.state === "stopped") return;
		try {
			this.ui?.stop?.();
			resetExtendedKeyboardModesForHandoff();
		} catch {}
		this.state = "suspended";
		const record = this.host.get(this.id);
		if (record && record.state !== "stopped" && record.state !== "error")
			record.state = "suspended";
	}

	resume(): void {
		if (this.state === "stopped") return;
		this.installTerminalGate();
		try {
			this.ui?.start?.();
			this.ui?.requestRender?.(true);
		} catch {}
		this.state = "active";
		const record = this.host.get(this.id);
		if (record) record.state = "active";
	}

	async dispose(): Promise<void> {
		this.state = "stopped";
		const ui = this.ui;
		const originalUiStop = ui?.stop?.bind(ui);
		const canTouchTerminal = this.host.activeId === this.id;
		try {
			if (ui && originalUiStop && !canTouchTerminal) {
				ui.stop = () => {};
			}
			this.mode?.stop?.();
		} catch {
		} finally {
			if (ui && originalUiStop) ui.stop = originalUiStop;
		}
		try {
			await this.runtime?.dispose?.();
		} catch {}
	}
}

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
	cwd,
	agentDir,
	sessionManager,
	sessionStartEvent,
}) => {
	const host = getHost();
	const activeRecord =
		host.activeId !== PARENT_SESSION_ID ? host.get(host.activeId) : null;
	let inheritance = runtimeInheritanceBySessionManager.get(sessionManager);
	// /new and /resume inside a child create a fresh SessionManager, so WeakMap
	// inheritance from the original child manager is lost. Reattach it from the
	// active child record before session construction, without mutating session log.
	if (!inheritance && activeRecord?.kind === "child") {
		inheritance =
			activeRecord.inheritance ??
			safeCollectRuntimeInheritance(activeRecord.context);
		runtimeInheritanceBySessionManager.set(sessionManager, inheritance);
		activeRecord.inheritance = inheritance;
	}
	inheritance ??= {};
	const inheritedSettings = createInheritedSettingsManager(
		cwd,
		agentDir,
		inheritance,
	);
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		authStorage: inheritance.authStorage,
		settingsManager: inheritedSettings.settingsManager,
		resourceLoaderOptions: cliResourceLoaderOptions,
	});
	services.diagnostics.push(...inheritedSettings.diagnostics);
	let sessionOptions: any = {};
	try {
		sessionOptions = await resolveChildSessionOptions(
			services,
			sessionManager,
			inheritance,
		);
	} catch (error) {
		services.diagnostics.push({
			type: "warning",
			message: `Failed to resolve inherited child session options: ${String(error)}`,
		});
	}
	const result = await createAgentSessionFromServices({
		services,
		sessionManager,
		sessionStartEvent,
		...sessionOptions,
	});
	return {
		...result,
		services,
		diagnostics: services.diagnostics,
	};
};

class PiSessionsHost {
	activeId = PARENT_SESSION_ID;
	records = new Map<string, LiveSessionRecord>();
	subscribers = new Set<() => void>();
	locks = new LockManager();
	parentTui: any = null;
	parentDone: (() => void) | null = null;
	parentHandoffActive = false;
	activationInProgress: Promise<void> | null = null;
	queuedActivation: string | null = null;
	workingIndicator: WorkingIndicatorOptions | undefined = undefined;

	constructor() {
		this.records.set(PARENT_SESSION_ID, {
			id: PARENT_SESSION_ID,
			kind: "parent",
			name: "parent",
			cwd: process.cwd(),
			state: "active",
			activity: "idle",
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			status: "parent",
			pid: process.pid,
		});
	}

	get(id: string): LiveSessionRecord | undefined {
		return (
			this.records.get(id) ||
			[...this.records.values()].find((r) => r.name === id)
		);
	}

	subscribe(listener: () => void): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	notify(): void {
		for (const listener of [...this.subscribers]) {
			try {
				listener();
			} catch {}
		}
	}

	publicSession(record: LiveSessionRecord): any {
		return {
			id: record.id,
			name: record.name,
			cwd: record.cwd,
			state: record.state,
			status: record.status || record.state,
			pid: process.pid,
			lastActivityAt: record.lastActivityAt,
			agentStatus: record.activity || "idle",
			transcript: record.transcript || "",
		};
	}

	snapshot(): any {
		return {
			attached: this.activeId,
			updatedAt: Date.now(),
			sessions: this.listLive().map((r) => this.publicSession(r)),
		};
	}

	listLive(): LiveSessionRecord[] {
		const parent = this.records.get(PARENT_SESSION_ID);
		const children = [...this.records.values()].filter(
			(r) => r.kind === "child" && !["stopped", "error"].includes(r.state),
		);
		return [parent, ...children].filter(Boolean);
	}

	/**
	 * Persist the current live-session set so a later `pi --session <id>` resume
	 * can re-attach the parallel sessions that were running in this process.
	 * The state file is keyed by the parent session id, so concurrent processes
	 * never clobber each other, and a fresh/unrelated session never restores it.
	 */
	persistState(): void {
		const parent = this.records.get(PARENT_SESSION_ID);
		const file = stateFilePath(parent?.sessionId);
		if (!file) return;
		const sessions = [...this.records.values()]
			.filter(
				(r) => r.sessionFile && !["stopped", "error"].includes(r.state),
			)
			.map((r) => ({
				kind: r.kind,
				id: r.id,
				name: r.name,
				cwd: r.cwd,
				sessionFile: r.sessionFile,
				sessionId: r.sessionId,
			}));
		try {
			if (sessions.length <= 1) {
				// No parallel sessions (or nothing persisted) — nothing to restore.
				if (fs.existsSync(file)) fs.rmSync(file, { force: true });
				return;
			}
			fs.writeFileSync(
				file,
				JSON.stringify(
					{ version: STATE_FILE_VERSION, savedAt: Date.now(), sessions },
					null,
					2,
				),
			);
		} catch {}
	}

	/**
	 * Re-attach the parallel sessions that were live in a previous process when
	 * the current session matches a recorded one (resumed via `pi --session`,
	 * `pi -c`, or the resume picker). Restored children are created suspended,
	 * exactly like sessions opened through the switcher: they appear in the
	 * widget/switcher and start their runtime on first activation.
	 * Returns the number of sessions restored.
	 */
	async tryRestoreFromState(ctx: CommandContext): Promise<number> {
		const currentFile = ctx.sessionManager?.getSessionFile?.();
		if (!currentFile) return 0;
		const resolvedCurrent = path.resolve(currentFile);

		// Prefer the state file keyed by the current session id (resumed parent),
		// then fall back to scanning, which also covers resuming a former child.
		const candidates: string[] = [];
		const direct = stateFilePath(ctx.sessionManager?.getSessionId?.());
		if (direct) candidates.push(direct);
		for (const file of listStateFiles()) {
			if (!candidates.includes(file)) candidates.push(file);
		}

		let state: any = null;
		for (const file of candidates) {
			state = readStateFile(file);
			if (state) break;
		}
		if (!state) return 0;

		const sessions = (state.sessions as any[]).filter(
			(s) =>
				s?.sessionFile &&
				typeof s.sessionFile === "string" &&
				fs.existsSync(s.sessionFile),
		);
		if (
			!sessions.some(
				(s) => path.resolve(s.sessionFile) === resolvedCurrent,
			)
		) {
			// Current session is unrelated to the recorded set — don't resurrect.
			return 0;
		}

		let restored = 0;
		const failed: string[] = [];
		for (const s of sessions) {
			if (path.resolve(s.sessionFile) === resolvedCurrent) continue;
			// Skip when ANY live record (parent or child) already covers the file;
			// restore runs from child contexts too, where the parent is already
			// represented by its kind="parent" record.
			const existing = [...this.records.values()].find(
				(r) => r.sessionFile === s.sessionFile,
			);
			if (existing) continue;
			try {
				await this.openSavedSessionAsLive(
					s.sessionFile,
					typeof s.cwd === "string" ? s.cwd : undefined,
					ctx,
				);
				restored++;
			} catch {
				failed.push(s.name || s.sessionId || s.sessionFile);
			}
		}
		if (failed.length > 0) {
			try {
				ctx.ui.notify(
					`Could not restore ${failed.length} session${failed.length === 1 ? "" : "s"}: ${failed.join(", ")}`,
					"warning",
				);
			} catch {}
		}
		return restored;
	}

	registerParent(ctx: CommandContext): void {
		const record = this.records.get(PARENT_SESSION_ID)!;
		record.cwd = ctx.cwd || process.cwd();
		record.context = ctx;
		record.sessionManager = ctx.sessionManager;
		record.sessionFile = ctx.sessionManager?.getSessionFile?.();
		record.sessionId = ctx.sessionManager?.getSessionId?.();
		record.transcript = resolveTranscriptName(
			ctx.sessionManager?.getSessionName?.(),
			record.sessionFile,
		);
		record.lastActivityAt = Date.now();
		if (this.activeId === PARENT_SESSION_ID) record.state = "active";
		this.notify();
	}

	private updateChildFromContext(
		child: LiveSessionRecord,
		ctx: CommandContext,
	): LiveSessionRecord {
		child.context = ctx;
		child.cwd = ctx.cwd || child.cwd;
		child.sessionManager = ctx.sessionManager || child.sessionManager;
		child.sessionId = ctx.sessionManager?.getSessionId?.() || child.sessionId;
		child.sessionFile =
			ctx.sessionManager?.getSessionFile?.() || child.sessionFile;
		child.transcript = resolveTranscriptName(
			ctx.sessionManager?.getSessionName?.(),
			child.sessionFile,
		);
		child.lastActivityAt = Date.now();
		this.notify();
		return child;
	}

	bindSessionContext(ctx: CommandContext): LiveSessionRecord {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const child = [...this.records.values()].find(
			(r) =>
				r.kind === "child" &&
				((sessionId && r.sessionId === sessionId) ||
					(sessionFile && r.sessionFile === sessionFile)),
		);
		if (child) return this.updateChildFromContext(child, ctx);

		const parent = this.records.get(PARENT_SESSION_ID)!;
		const isParentContext =
			(sessionId && parent.sessionId === sessionId) ||
			(sessionFile && parent.sessionFile === sessionFile);
		if (isParentContext) {
			this.registerParent(ctx);
			return parent;
		}

		// /new or /resume inside the active child changes session id/file before we
		// can match by identity. Route that replacement to the active child, but only
		// after ruling out the parent context above.
		const activeChild =
			this.activeId !== PARENT_SESSION_ID ? this.get(this.activeId) : null;
		if (activeChild?.kind === "child") {
			return this.updateChildFromContext(activeChild, ctx);
		}

		this.registerParent(ctx);
		return parent;
	}

	updateActivity(ctx: CommandContext, activity: Activity): void {
		const record = this.bindSessionContext(ctx);
		record.activity = activity;
		record.lastActivityAt = Date.now();
		this.notify();
	}

	currentContextId(ctx: CommandContext): string {
		return this.bindSessionContext(ctx).id;
	}

	async createChildFromContext(
		ctx: CommandContext,
		cwd: string,
	): Promise<LiveSessionRecord> {
		this.bindSessionContext(ctx);
		const sessionManager = SessionManager.create(cwd, undefined, {});
		return await this.createRecordForSessionManager({
			name: path.basename(cwd || process.cwd()) || "session",
			cwd,
			sessionManager,
			inheritance: safeCollectRuntimeInheritance(ctx),
		});
	}

	async openSavedSessionAsLive(
		sessionPath: string,
		cwdOverride?: string,
		ctx?: CommandContext,
	): Promise<LiveSessionRecord> {
		const existing = [...this.records.values()].find(
			(r) =>
				r.kind === "child" &&
				r.sessionFile === sessionPath &&
				!["stopped", "error"].includes(r.state),
		);
		if (existing) return existing;
		const sessionManager = SessionManager.open(
			sessionPath,
			undefined,
			cwdOverride,
		);
		const cwd = sessionManager.getCwd?.() || cwdOverride || process.cwd();
		const name = sanitizeName(
			sessionManager.getSessionName?.() ||
				path.basename(cwd) ||
				sessionManager.getSessionId?.(),
		);
		return await this.createRecordForSessionManager({
			name,
			cwd,
			sessionManager,
			inheritance: safeCollectRuntimeInheritance(ctx),
		});
	}

	private async createRecordForSessionManager(opts: {
		name: string;
		cwd: string;
		sessionManager: any;
		parent?: LiveSessionRecord;
		inheritance?: any;
	}): Promise<LiveSessionRecord> {
		const id = `${sanitizeName(opts.name)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
		const record: LiveSessionRecord = {
			id,
			kind: "child",
			name: sanitizeName(opts.name),
			cwd: opts.cwd,
			state: "starting",
			activity: "idle",
			sessionManager: opts.sessionManager,
			sessionFile: opts.sessionManager.getSessionFile?.(),
			sessionId: opts.sessionManager.getSessionId?.(),
			parentSessionFile: opts.parent?.sessionFile,
			parentLeafId: opts.parent?.sessionManager?.getLeafId?.() || null,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			transcript: resolveTranscriptName(
				opts.sessionManager.getSessionName?.(),
				opts.sessionManager.getSessionFile?.(),
			),
			inheritance: opts.inheritance,
		};
		this.records.set(id, record);
		this.notify();
		if (opts.inheritance) {
			runtimeInheritanceBySessionManager.set(
				opts.sessionManager,
				opts.inheritance,
			);
		}
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: opts.cwd,
			agentDir: getAgentDir(),
			sessionManager: opts.sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" } as any,
		});
		const mode = new InteractiveMode(runtime, {
			migratedProviders: [],
			modelFallbackMessage: runtime.modelFallbackMessage,
			initialMessage: undefined,
			initialImages: [],
			initialMessages: [],
		});
		record.runtime = runtime;
		record.mode = mode;
		record.adapter = new InteractiveModeAdapter(id, runtime, mode, this);
		record.state = "suspended";
		record.transcript = resolveTranscriptName(
			opts.sessionManager.getSessionName?.(),
			opts.sessionManager.getSessionFile?.(),
		);
		this.notify();
		this.persistState();
		return record;
	}

	async stopChild(nameOrId: string): Promise<void> {
		const record = this.get(nameOrId);
		if (!record || record.kind !== "child")
			throw new Error("session not found");
		const wasActive = this.activeId === record.id;
		record.expectedStop = true;
		record.state = "stopped";
		record.status = "stopped";
		this.locks.release(record.id);
		try {
			if (wasActive) record.adapter?.suspend();
			await record.adapter?.dispose();
		} catch {}
		this.records.delete(record.id);
		this.notify();
		this.persistState();
		if (wasActive) await this.activate(PARENT_SESSION_ID);
	}

	async activate(targetIdOrName: string): Promise<void> {
		const target = this.get(targetIdOrName);
		if (!target) throw new Error(`session not found: ${targetIdOrName}`);
		if (this.activationInProgress) {
			this.queuedActivation = target.id;
			await this.activationInProgress;
			return;
		}
		this.activationInProgress = this.doActivate(target).finally(() => {
			this.activationInProgress = null;
		});
		await this.activationInProgress;
		const queued = this.queuedActivation;
		this.queuedActivation = null;
		if (queued && queued !== this.activeId) await this.activate(queued);
	}

	private async doActivate(target: LiveSessionRecord): Promise<void> {
		if (target.id === this.activeId) return;
		const current = this.get(this.activeId);
		if (current?.kind === "child") current.adapter?.suspend();
		if (current?.kind === "parent") current.state = "suspended";

		if (target.kind === "parent") {
			this.activeId = PARENT_SESSION_ID;
			target.state = "active";
			try {
				this.parentTui?.terminal?.setProgress?.(false);
				this.parentTui?.start?.();
				this.parentTui?.requestRender?.(true);
			} catch {}
			const done = this.parentDone;
			this.parentTui = null;
			this.parentDone = null;
			this.parentHandoffActive = false;
			this.notify();
			done?.();
			return;
		}

		this.activeId = target.id;
		target.state = "active";
		if (!target.started) target.adapter?.start();
		else target.adapter?.resume();
		this.notify();
	}

	async enterFromParent(ctx: CommandContext, targetId: string): Promise<void> {
		if (this.parentHandoffActive) return this.activate(targetId);
		await ctx.ui.custom(
			(tui: any, _theme: any, _keybindings: any, done: () => void) => {
				this.parentTui = tui;
				this.parentDone = done;
				this.parentHandoffActive = true;
				try {
					tui.stop();
					resetExtendedKeyboardModesForHandoff();
				} catch {}
				void this.activate(targetId).catch((error) => {
					try {
						tui.start();
						tui.requestRender(true);
					} catch {}
					this.parentHandoffActive = false;
					this.parentTui = null;
					this.parentDone = null;
					ctx.ui.notify(String(error?.message || error), "error");
					done();
				});
				return { render: () => [], invalidate: () => {}, dispose: () => {} };
			},
		);
	}

	async activateFromContext(
		ctx: CommandContext,
		targetId: string,
	): Promise<void> {
		const current = this.currentContextId(ctx);
		if (current === PARENT_SESSION_ID && targetId !== PARENT_SESSION_ID) {
			await this.enterFromParent(ctx, targetId);
		} else {
			await this.activate(targetId);
		}
	}
}

function getHost(): PiSessionsHost {
	const g = globalThis as any;
	if (!g[HOST_KEY]) g[HOST_KEY] = new PiSessionsHost();
	return g[HOST_KEY];
}

function patchInteractiveModeWorkingIndicator(host: PiSessionsHost): void {
	const proto = (InteractiveMode as any)?.prototype;
	if (
		!proto ||
		proto[INTERACTIVE_MODE_SPINNER_PATCHED] ||
		typeof proto.setWorkingIndicator !== "function"
	) {
		return;
	}
	const original = proto.setWorkingIndicator;
	proto.setWorkingIndicator = function (options?: WorkingIndicatorOptions) {
		const source = [...host.records.values()].find((record) => record.mode === this);
		const teardownReset =
			options === undefined &&
			source !== undefined &&
			(source.expectedStop === true ||
				source.state === "stopped" ||
				source.state === "error");
		if (!teardownReset) {
			host.workingIndicator = options;
			host.notify();
		}
		return original.call(this, options);
	};
	proto[INTERACTIVE_MODE_SPINNER_PATCHED] = true;
}

function installWidget(ctx: CommandContext, host: PiSessionsHost): void {
	ctx.ui.setWidget("pi-sessions", (tui: any, theme: any) => {
		const requestRender = () => tui.requestRender();
		const unsubscribe = host.subscribe(requestRender);
		const widget = new SessionWidget(
			theme,
			() => host.snapshot(),
			requestRender,
			() => host.workingIndicator,
		);
		return {
			render: (width: number) => widget.render(width),
			invalidate: () => widget.invalidate(),
			dispose: () => {
				unsubscribe();
				widget.dispose();
			},
		};
	});
}

async function getResumeSessions(): Promise<any[]> {
	const sessions = await SessionManager.listAll();
	return sessions.sort(
		(a: any, b: any) => Number(b.modified) - Number(a.modified),
	);
}

async function openSessions(
	ctx: CommandContext,
	host: PiSessionsHost,
): Promise<void> {
	let targetToActivate: string | null = null;
	let targetToKill: string | null = null;
	await showSessionsView(ctx, {
		getSessions: async () =>
			host.listLive().map((record) => host.publicSession(record)),
		getResumeSessions,
		getAttached: () => host.activeId,
		getCwd: () => ctx.cwd || process.cwd(),
		switchTo: async (id: string) => {
			const target = host.get(id === "parent" ? PARENT_SESSION_ID : id);
			if (!target) throw new Error(`session not found: ${id}`);
			targetToActivate = target.id;
		},
		newSession: async () => {
			const child = await host.createChildFromContext(
				ctx,
				ctx.cwd || process.cwd(),
			);
			targetToActivate = child.id;
		},
		newSessionInFolder: async (cwd: string) => {
			const child = await host.createChildFromContext(ctx, cwd);
			targetToActivate = child.id;
		},
		cloneSession: async () => {
			// Mirror regular Pi /clone (fork at the current leaf, position "at")
			// but keep the original running and open the clone as a new parallel
			// session instead of replacing the current one.
			const id =
				host.activeId === PARENT_SESSION_ID
					? PARENT_SESSION_ID
					: host.activeId;
			const record = host.get(id);
			if (!record) throw new Error("session not found");
			const leafId = record.sessionManager?.getLeafId?.();
			if (!leafId) throw new Error("Nothing to clone yet");
			if (!record.sessionFile || !fs.existsSync(record.sessionFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}
			// Branch from a separate SessionManager so the live session is untouched.
			const branch = SessionManager.open(
				record.sessionFile,
				undefined,
				record.cwd,
			);
			const branchLeaf = branch.getLeafId();
			if (!branchLeaf) throw new Error("Nothing to clone yet");
			const newFile = branch.createBranchedSession(branchLeaf);
			if (!newFile || !fs.existsSync(newFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}
			const child = await host.openSavedSessionAsLive(
				newFile,
				record.cwd,
				ctx,
			);
			targetToActivate = child.id;
		},
		resumeSession: async (sessionPath?: string) => {
			if (!sessionPath) {
				const sessions = await getResumeSessions();
				sessionPath = sessions[0]?.path;
			}
			if (!sessionPath) throw new Error("No saved sessions found");
			const child = await host.openSavedSessionAsLive(
				sessionPath,
				undefined,
				ctx,
			);
			targetToActivate = child.id;
		},
		killSession: async (id: string) => {
			targetToKill = id;
		},
		notify: (message: string, type?: "info" | "warning" | "error") =>
			ctx.ui.notify(message, type || "info"),
	});
	if (targetToKill) {
		await host.stopChild(targetToKill);
		return;
	}
	if (!targetToActivate || targetToActivate === host.activeId) return;
	await host.activateFromContext(ctx, targetToActivate);
}

export default function (pi: ExtensionAPI) {
	const host = getHost();
	cliResourceLoaderOptions = collectCliResourceLoaderOptions(process.argv);
	patchInteractiveModeWorkingIndicator(host);

	pi.registerCommand("sessions", {
		description: "Open the pi-sessions switcher",
		handler: async (_args: string, ctx: CommandContext) =>
			openSessions(ctx, host),
	});

	pi.registerShortcut("ctrl+r", {
		description: "Open sessions switcher",
		handler: async (ctx: CommandContext) => openSessions(ctx, host),
	});

	pi.on("session_start", (_event: any, ctx: CommandContext) => {
		host.bindSessionContext(ctx);
		installWidget(ctx, host);
		// Re-attach the parallel sessions that were live in the previous process.
		// Fire-and-forget: restoring creates suspended child runtimes, which must
		// not block first paint; the widget/switcher pick them up as they appear.
		void host
			.tryRestoreFromState(ctx)
			.then((restored) => {
				if (restored > 0) {
					try {
						ctx.ui.notify(
							`Restored ${restored} parallel session${restored === 1 ? "" : "s"} from previous run`,
							"info",
						);
					} catch {}
				}
			})
			.catch(() => {});
	});

	pi.on("agent_start", (_event: any, ctx: CommandContext) => {
		host.updateActivity(ctx, "working");
	});

	pi.on("agent_end", (_event: any, ctx: CommandContext) => {
		host.updateActivity(ctx, "idle");
	});

	pi.on("tool_call", async (event: any, ctx: CommandContext) => {
		const record = host.bindSessionContext(ctx);
		const paths = inferToolPaths(event.toolName, event.input);
		if (!paths.length) return undefined;
		const result = host.locks.acquire(record.id, paths, ctx.cwd || record.cwd);
		if (!result.ok) {
			return {
				block: true,
				reason: `pi-sessions path lock conflict: ${JSON.stringify(result.conflicts)}`,
			};
		}
		host.locks.heldByToolCall.set(event.toolCallId, {
			sessionId: record.id,
			paths: result.paths,
		});
		return undefined;
	});

	pi.on("tool_result", async (event: any, ctx: CommandContext) => {
		host.locks.releaseByToolCall(event.toolCallId);
		return undefined;
	});

	pi.on("session_shutdown", (_event: any, ctx: CommandContext) => {
		const record = host.bindSessionContext(ctx);
		host.locks.release(record.id);
		host.persistState();
		try {
			ctx.ui.setWidget("pi-sessions", undefined);
		} catch {}
		host.notify();
	});
}
