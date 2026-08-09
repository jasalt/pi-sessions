// @ts-nocheck
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { UserMessageSelectorComponent } from "@earendil-works/pi-coding-agent";

type SessionInfo = {
	id: string;
	name: string;
	cwd: string;
	state: string;
	status?: string;
	pid?: number | null;
	lastActivityAt?: number;
	agentStatus?: string;
	transcript?: string;
	shortName?: string;
};

type SavedSessionInfo = {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	modified?: Date;
	firstMessage?: string;
	messageCount?: number;
};

type ForkMessage = {
	id: string;
	text: string;
};

type SessionsActions = {
	getSessions: () => Promise<SessionInfo[]>;
	getResumeSessions?: () => Promise<SavedSessionInfo[]>;
	getAttached: () => string | null;
	getCwd: () => string;
	switchTo: (id: string) => Promise<void>;
	newSession: () => Promise<void>;
	newSessionInFolder: (cwd: string) => Promise<void>;
	cloneSession: () => Promise<void>;
	forkSessionAt: (entryId: string) => Promise<void>;
	getForkMessages: () => ForkMessage[];
	resumeSession: (sessionPath?: string) => Promise<void>;
	killSession: (id: string) => Promise<void>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
};

type WidgetSnapshot = {
	attached: string | null;
	sessions: SessionInfo[];
	updatedAt: number;
};

const PARENT_SESSION_ID = "__parent__";
const DEFAULT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_SPINNER_INTERVAL_MS = 80;

type WorkingIndicatorOptions = {
	frames?: string[];
	intervalMs?: number;
};

function isCtrl(
	data: string,
	key: "c" | "o" | "r" | "k" | "p" | "n" | "f",
): boolean {
	const codes: Record<string, string> = {
		c: "\x03",
		o: "\x0f",
		r: "\x12",
		k: "\x0b",
		p: "\x10",
		n: "\x0e",
		f: "\x06",
	};
	return data === codes[key] || matchesKey(data, Key.ctrl(key));
}

function padVisible(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function renderInputChild(input: Input, width: number): string {
	const line = input.render(Math.max(1, width))[0] ?? "";
	return line.startsWith("> ") ? line.slice(2) : line;
}

function cwdBasename(cwd: string): string {
	const trimmed = cwd.replace(/\/+$/, "");
	const i = trimmed.lastIndexOf("/");
	return i >= 0 ? trimmed.slice(i + 1) || "/" : trimmed || "/";
}

function computeShortNames(sessions: SessionInfo[]): void {
	const counts = new Map<string, number>();
	for (const session of sessions) {
		const base = cwdBasename(session.cwd || "") || session.name;
		const n = counts.get(base) ?? 0;
		counts.set(base, n + 1);
		session.shortName = n === 0 ? base : `${base}<${n}>`;
	}
}

export class SessionWidget implements Component {
	private frame = 0;
	private timer: NodeJS.Timeout | null = null;
	private timerIntervalMs = DEFAULT_SPINNER_INTERVAL_MS;

	constructor(
		private readonly theme: Theme,
		private readonly getSnapshot: () => WidgetSnapshot | null,
		private readonly requestRender: () => void,
		private readonly getWorkingIndicator?: () => WorkingIndicatorOptions | undefined,
	) {}

	render(width: number): string[] {
		const snapshot = this.getSnapshot();
		if (!snapshot || snapshot.sessions.length === 0) {
			this.updateTimer(false);
			return [];
		}
		const sessions = [...snapshot.sessions];
		computeShortNames(sessions);
		const ordered = this.currentLast(sessions, snapshot.attached);
		const hasWorking = ordered.some((session) => this.isWorking(session));
		this.updateTimer(hasWorking);
		const segments = ordered.map((session) =>
			this.segment(session, snapshot.attached),
		);
		const line = this.fitFromRight(segments, width);
		if (!line) return [];
		return [" ".repeat(Math.max(0, width - visibleWidth(line))) + line];
	}

	invalidate(): void {}

	dispose(): void {
		this.updateTimer(false);
	}

	private currentLast(
		sessions: SessionInfo[],
		attached: string | null,
	): SessionInfo[] {
		if (!attached) return sessions;
		const current = sessions.find(
			(session) => session.id === attached || session.name === attached,
		);
		if (!current) return sessions;
		return sessions.filter((session) => session !== current).concat(current);
	}

	private isWorking(session: SessionInfo): boolean {
		return (session.agentStatus || "idle") === "working";
	}

	private spinnerFrame(): string {
		const indicator = this.getWorkingIndicator?.();
		const frames =
			indicator?.frames !== undefined
				? [...indicator.frames]
				: DEFAULT_SPINNER_FRAMES;
		if (!frames.length) return "";
		const frame = frames[this.frame % frames.length] ?? "";
		return indicator !== undefined ? frame : this.theme.fg("accent", frame);
	}

	private spinnerIntervalMs(): number {
		const interval = this.getWorkingIndicator?.()?.intervalMs;
		return interval && interval > 0 ? interval : DEFAULT_SPINNER_INTERVAL_MS;
	}

	private isWaiting(session: SessionInfo): boolean {
		return (session.agentStatus || "idle") === "waiting";
	}

	private segment(session: SessionInfo, attached: string | null): string {
		const current = session.id === attached || session.name === attached;
		const name = this.theme.fg(
			current ? "accent" : "muted",
			truncateToWidth(session.shortName || session.name, 18, "…"),
		);
		if (this.isWorking(session)) {
			const spinner = this.spinnerFrame();
			return spinner ? `${spinner} ${name}` : name;
		}
		if (this.isWaiting(session)) {
			return `${this.theme.fg("warning", "?")} ${name}`;
		}
		return `${this.theme.fg("success", "✓")} ${name}`;
	}

	private fitFromRight(segments: string[], width: number): string {
		let line = "";
		for (let i = segments.length - 1; i >= 0; i--) {
			const next = line ? `${segments[i]}  ${line}` : segments[i]!;
			if (visibleWidth(next) > width) break;
			line = next;
		}
		return line;
	}

	private updateTimer(shouldRun: boolean): void {
		const interval = this.spinnerIntervalMs();
		if (shouldRun && this.timer && this.timerIntervalMs !== interval) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (shouldRun && !this.timer) {
			this.timerIntervalMs = interval;
			this.timer = setInterval(() => {
				this.frame++;
				this.requestRender();
			}, interval);
			return;
		}
		if (!shouldRun && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

// --- FileExplorer (from pi-project) ---

const FILE_EXPLORER_MAX_VISIBLE = 8;
const SESSIONS_MAX_VISIBLE = 12;
const RESUME_MAX_VISIBLE = 12;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

function normalizeExistingDir(input: string): string | null {
	try {
		const expanded = expandHome(input.trim());
		if (!expanded) return null;
		const absolute = path.resolve(expanded);
		if (!existsSync(absolute)) return null;
		if (!statSync(absolute).isDirectory()) return null;
		return absolute;
	} catch {
		return null;
	}
}

function relativeTime(date: Date): string {
	const ms = Date.now() - date.getTime();
	if (!Number.isFinite(ms) || ms < 0) return "now";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return "now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h ago`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day}d ago`;
	const month = Math.floor(day / 30);
	if (month < 12) return `${month}mo ago`;
	return `${Math.floor(month / 12)}y ago`;
}

function fits(width: number, text: string): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function indent(width: number, text: string): string {
	return fits(width, `  ${text}`);
}

function setInputValueAtEnd(input: Input, value: string): void {
	input.setValue(value);
	(input as unknown as { cursor: number }).cursor = value.length;
}

function dirPrefix(value: string): string {
	const slash = value.lastIndexOf("/");
	return slash >= 0 ? value.slice(0, slash + 1) : "";
}

function formatSize(bytes: number): string {
	if (bytes < 1000) return `${bytes}b`;
	if (bytes < 1_000_000)
		return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)}kb`;
	if (bytes < 1_000_000_000)
		return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)}Mb`;
	return `${(bytes / 1_000_000_000).toFixed(1)}Gb`;
}

type FileEntry = {
	name: string;
	path: string;
	isDirectory: boolean;
	size: string;
	modified: Date;
};

function readFileEntries(dir: string): FileEntry[] {
	const entries: FileEntry[] = [
		{
			name: "./",
			path: dir,
			isDirectory: true,
			size: "",
			modified: new Date(),
		},
	];

	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		try {
			const entryPath = path.join(dir, dirent.name);
			const stat = statSync(entryPath);
			const isDirectory = stat.isDirectory();
			entries.push({
				name: `${dirent.name}${isDirectory ? "/" : ""}`,
				path: entryPath,
				isDirectory,
				size: isDirectory ? "" : formatSize(stat.size),
				modified: stat.mtime,
			});
		} catch {
			// Ignore unreadable entries.
		}
	}

	return entries.sort((a, b) => {
		if (a.name === "./") return -1;
		if (b.name === "./") return 1;
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

export class FileExplorer implements Component, Focusable {
	private entries: FileEntry[] = [];
	private selectedIndex = 0;
	private readonly searchInput = new Input();
	private error: string | undefined;
	private readonly theme: Theme;
	private readonly done: (path: string | null) => void;
	private readonly requestRender: () => void;

	constructor(
		initialCwd: string,
		theme: Theme,
		done: (path: string | null) => void,
		requestRender: () => void,
	) {
		setInputValueAtEnd(
			this.searchInput,
			`${normalizeExistingDir(initialCwd) ?? homedir()}/`,
		);
		this.theme = theme;
		this.done = done;
		this.requestRender = requestRender;
		this.refresh();
	}

	render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const lines: string[] = [];
		lines.push(this.border(width));
		lines.push(this.header(width));
		lines.push(this.border(width, "dim"));
		this.renderEntries(lines, width);
		lines.push(this.border(width));
		lines.push(
			fits(
				width,
				dim("↑↓/<C-p>/<C-n>") +
					muted(" move · ") +
					dim("<tab>") +
					muted(" enter folder · ") +
					dim("<enter>") +
					muted(" choose folder · ") +
					dim("<M-backspace>") +
					muted(" parent · ") +
					dim("<esc>") +
					muted(" cancel"),
			),
		);
		return lines;
	}

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.enterSelectedDirectory();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.chooseSelectedDirectory();
			return;
		}
		if (getKeybindings().matches(data, "tui.editor.deleteWordBackward")) {
			this.deletePathSegmentBackward();
			return;
		}

		const before = this.search;
		const beforeDir = dirPrefix(before);
		this.searchInput.handleInput(data);
		const after = this.search;
		if (after !== before) {
			if (dirPrefix(after) !== beforeDir) this.refresh();
			else this.clampSelection();
		}
		this.requestRender();
	}

	private get search(): string {
		return this.searchInput.getValue();
	}

	private set search(value: string) {
		setInputValueAtEnd(this.searchInput, value);
	}

	private deletePathSegmentBackward(): void {
		const before = this.search;
		const trimmed = before.replace(/\/+$/, "");
		const slash = trimmed.lastIndexOf("/");
		if (slash < 0) return;
		const next = trimmed.slice(0, slash + 1);
		if (next === before) return;
		this.search = next || "/";
		this.refresh();
		this.requestRender();
	}

	private refresh(): void {
		try {
			this.entries = readFileEntries(dirPrefix(this.search));
			this.selectedIndex = Math.max(
				0,
				Math.min(this.selectedIndex, Math.max(0, this.entries.length - 1)),
			);
			this.error = undefined;
		} catch (error) {
			this.entries = [];
			this.selectedIndex = 0;
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private header(width: number): string {
		const entries = this.filteredEntries();
		const total = Math.max(1, entries.length);
		const index = Math.min(this.selectedIndex + 1, total);
		const prefix = `${index}/${total}\tOpen session in folder: `;
		const input = renderInputChild(
			this.searchInput,
			Math.max(1, width - visibleWidth(prefix)),
		);
		return this.theme.fg("accent", fits(width, `${prefix}${input}`));
	}

	private border(width: number, color: "accent" | "dim" = "accent"): string {
		return this.theme.fg(color, "─".repeat(Math.max(0, width)));
	}

	private renderEntries(lines: string[], width: number): void {
		if (this.error) {
			lines.push(this.theme.fg("dim", indent(width, this.error)));
			this.padRows(lines, width, 1);
			return;
		}
		const entries = this.filteredEntries();
		if (entries.length === 0) {
			lines.push(
				this.theme.fg(
					"dim",
					indent(width, this.search ? "No matches." : "No entries."),
				),
			);
			this.padRows(lines, width, 1);
			return;
		}

		let rendered = 0;
		const start = this.visibleStart(entries.length);
		const end = Math.min(entries.length, start + FILE_EXPLORER_MAX_VISIBLE);
		for (let i = start; i < end; i++) {
			lines.push(
				this.entryLine(width, entries[i]!, {
					selected: i === this.selectedIndex,
				}),
			);
			rendered++;
		}
		this.padRows(lines, width, rendered);
	}

	private entryLine(
		width: number,
		entry: FileEntry,
		options: { selected: boolean },
	): string {
		if (entry.name === "./") return this.currentDirLine(width, options);
		const left = `${options.selected ? "›" : " "} ${entry.name}`;
		const timeW = 7;
		const meta = `${entry.size.padStart(5)}  ${relativeTime(entry.modified).padStart(timeW)}`;
		const metaWidth = Math.min(
			5 + 2 + timeW,
			Math.max(0, Math.floor(width * 0.38)),
		);
		const renderedMeta = fits(metaWidth, meta);
		const renderedLeft = fits(
			Math.max(0, width - visibleWidth(renderedMeta) - 1),
			left,
		);
		const gap = " ".repeat(
			Math.max(
				1,
				width - visibleWidth(renderedLeft) - visibleWidth(renderedMeta),
			),
		);
		const styledLeft = !entry.isDirectory
			? this.theme.fg("dim", renderedLeft)
			: options.selected
				? this.theme.fg("accent", renderedLeft)
				: renderedLeft;
		return `${styledLeft}${gap}${this.theme.fg("dim", renderedMeta)}`;
	}

	private currentDirLine(
		width: number,
		options: { selected: boolean },
	): string {
		const marker = options.selected ? "›" : " ";
		const name = `${marker} ./`;
		const note = " (select current dir)";
		const availableNoteWidth = Math.max(0, width - visibleWidth(name));
		const renderedNote = fits(availableNoteWidth, note);
		const renderedName = fits(
			Math.max(0, width - visibleWidth(renderedNote)),
			name,
		);
		const padding = " ".repeat(
			Math.max(
				0,
				width - visibleWidth(renderedName) - visibleWidth(renderedNote),
			),
		);
		const styledName = options.selected
			? this.theme.fg("accent", renderedName)
			: renderedName;
		return `${styledName}${this.theme.fg("dim", renderedNote)}${padding}`;
	}

	private visibleStart(total: number): number {
		if (total <= FILE_EXPLORER_MAX_VISIBLE) return 0;
		const half = Math.floor(FILE_EXPLORER_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selectedIndex - half),
			total - FILE_EXPLORER_MAX_VISIBLE,
		);
	}

	private padRows(lines: string[], width: number, rendered: number): void {
		for (let i = rendered; i < FILE_EXPLORER_MAX_VISIBLE; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private filteredEntries(): FileEntry[] {
		const query = this.search.trim().split("/").pop() ?? "";
		if (!query) return this.entries;
		return fuzzyFilter(this.entries, query, (entry) => entry.name);
	}

	private clampSelection(): void {
		const maxIndex = Math.max(0, this.filteredEntries().length - 1);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, maxIndex));
	}

	private move(delta: number): void {
		const entries = this.filteredEntries();
		if (entries.length === 0) return;
		this.selectedIndex =
			(this.selectedIndex + delta + entries.length) % entries.length;
		this.requestRender();
	}

	private selected(): FileEntry | undefined {
		return this.filteredEntries()[this.selectedIndex];
	}

	private enterSelectedDirectory(): void {
		const entry = this.selected();
		if (!entry?.isDirectory) return;
		const next = normalizeExistingDir(entry.path) + "/";
		if (!next) return;
		this.search = next;
		this.refresh();
		this.requestRender();
	}

	private chooseSelectedDirectory(): void {
		const entry = this.selected();
		if (!entry?.isDirectory) return;
		const chosen = normalizeExistingDir(entry.path);
		if (chosen) this.done(chosen);
	}
}

class ResumeSessionPicker implements Component, Focusable {
	private sessions: SavedSessionInfo[] = [];
	private selected = 0;
	private loading = true;
	private error: string | null = null;
	private readonly filterInput = new Input();

	constructor(
		private readonly theme: any,
		private readonly loadSessions: () => Promise<SavedSessionInfo[]>,
		private readonly onDone: (sessionPath: string | null) => void,
		private readonly requestRender: () => void,
	) {
		this.filterInput.focused = true;
		void this.refresh();
	}

	get focused(): boolean {
		return true;
	}

	set focused(_value: boolean) {}

	private async refresh(): Promise<void> {
		try {
			this.error = null;
			this.sessions = await this.loadSessions();
		} catch (error) {
			this.error = String(error);
		} finally {
			this.loading = false;
			this.clampSelection();
			this.requestRender();
		}
	}

	private filteredSessions(): SavedSessionInfo[] {
		const query = this.filterInput.getValue().trim();
		return fuzzyFilter(this.sessions, query, (session) =>
			[
				session.name,
				session.cwd,
				session.firstMessage,
				session.path,
				session.id,
			]
				.filter(Boolean)
				.join(" "),
		);
	}

	private visibleStart(total: number): number {
		if (total <= RESUME_MAX_VISIBLE) return 0;
		const half = Math.floor(RESUME_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selected - half),
			total - RESUME_MAX_VISIBLE,
		);
	}

	private padRows(
		lines: string[],
		width: number,
		rendered: number,
		totalItems: number,
	): void {
		const target = Math.min(Math.max(totalItems, rendered), RESUME_MAX_VISIBLE);
		for (let i = rendered; i < target; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private clampSelection(): void {
		const max = Math.max(0, this.filteredSessions().length - 1);
		this.selected = Math.max(0, Math.min(this.selected, max));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onDone(null);
			return;
		}
		if (matchesKey(data, "up") || isCtrl(data, "p")) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || isCtrl(data, "n")) {
			this.selected = Math.min(
				Math.max(0, this.filteredSessions().length - 1),
				this.selected + 1,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const session = this.filteredSessions()[this.selected];
			if (session?.path) this.onDone(session.path);
			return;
		}
		const before = this.filterInput.getValue();
		this.filterInput.handleInput(data);
		if (this.filterInput.getValue() !== before) this.selected = 0;
		this.clampSelection();
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const border = (color: "accent" | "dim" = "accent") =>
			th.fg(color, "─".repeat(Math.max(0, width)));
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);
		const error = (s: string) => th.fg("error", s);
		const lines: string[] = [];
		const visibleSessions = this.filteredSessions();
		const total = Math.max(1, visibleSessions.length);
		const index = Math.min(this.selected + 1, total);
		const prefix = `${index}/${total}\tResume: `;
		const renderedInput = renderInputChild(
			this.filterInput,
			width - visibleWidth(prefix),
		);

		lines.push(border());
		lines.push(accent(fits(width, `${prefix}${renderedInput}`)));
		lines.push(border("dim"));
		const startIdx = this.visibleStart(visibleSessions.length);
		const endIdx = Math.min(
			visibleSessions.length,
			startIdx + RESUME_MAX_VISIBLE,
		);
		let rendered = 0;
		if (this.error) {
			lines.push(padVisible(`  ${error("error")} ${this.error}`, width));
			rendered = 1;
		} else if (visibleSessions.length === 0) {
			lines.push(
				padVisible(
					`  ${dim(this.loading ? "Loading…" : "No saved sessions")}`,
					width,
				),
			);
			rendered = 1;
		} else {
			for (let i = startIdx; i < endIdx; i++) {
				const session = visibleSessions[i]!;
				const marker = i === this.selected ? "›" : " ";
				const title =
					session.name || session.firstMessage || session.id.slice(0, 8);
				const styledName =
					i === this.selected
						? accent(`${marker} ${title}`)
						: `${marker} ${title}`;

				const cwdText = session.cwd || "";
				const msgCountText = session.messageCount
					? String(session.messageCount)
					: "";
				const timeText = session.modified ? relativeTime(session.modified) : "";

				const rightParts = [];
				if (cwdText) rightParts.push(muted(cwdText));
				if (msgCountText && timeText)
					rightParts.push(dim(`${msgCountText} ${timeText}`));
				else if (msgCountText) rightParts.push(dim(msgCountText));
				else if (timeText) rightParts.push(dim(timeText));
				const rightText = rightParts.join("  ");
				const rightWidth = visibleWidth(rightText);

				const leftWidth = Math.max(10, width - rightWidth - 1);
				const left = truncateToWidth(styledName, leftWidth, "…");
				const gap = " ".repeat(
					Math.max(1, width - visibleWidth(left) - rightWidth),
				);
				let line = left + gap + rightText;
				if (i === this.selected) {
					line = th.bg("selectedBg", line);
				}
				lines.push(line);
				rendered++;
			}
		}
		this.padRows(lines, width, rendered, this.sessions.length);
		lines.push(border());
		lines.push(
			padVisible(
				dim("↑↓/<C-p>/<C-n>") +
					muted(" move · ") +
					dim("<enter>") +
					muted(" resume · ") +
					dim("<esc>") +
					muted(" back"),
				width,
			),
		);
		return lines;
	}

	invalidate(): void {
		this.filterInput.invalidate();
	}

	dispose(): void {}
}

class ForkSelector {
	private readonly selector: any;
	private readonly requestRender: () => void;

	constructor(
		messages: ForkMessage[],
		onSelect: (entryId: string | null) => void,
		requestRender: () => void,
	) {
		this.requestRender = requestRender;
		const initialSelectedId =
			messages.length > 0 ? messages[messages.length - 1]!.id : undefined;
		// Reuse Pi's original fork point selection menu component.
		this.selector = new UserMessageSelectorComponent(
			messages,
			(entryId: string) => onSelect(entryId),
			() => onSelect(null),
			initialSelectedId,
		);
	}

	render(width: number): string[] {
		return this.selector.render(width);
	}

	invalidate(): void {
		this.selector.invalidate?.();
	}

	handleInput(data: string): void {
		this.selector.getMessageList()?.handleInput(data);
		this.requestRender();
	}
}

class SessionsView {
	private sessions: SessionInfo[] = [];
	private selected = 0;
	private loading = true;
	private error: string | null = null;
	private closed = false;
	private initialSelectionSet = false;
	private nameWidth = 30;
	private readonly filterInput = new Input();
	private readonly theme: any;
	private readonly done: () => void;
	private readonly actions: SessionsActions;
	private readonly requestRender: () => void;
	private folderExplorer: FileExplorer | null = null;
	private resumePicker: ResumeSessionPicker | null = null;
	private forkSelector: ForkSelector | null = null;
	private timer: NodeJS.Timeout | null = null;

	constructor(
		theme: any,
		done: () => void,
		actions: SessionsActions,
		requestRender: () => void,
	) {
		this.theme = theme;
		this.done = done;
		this.actions = actions;
		this.requestRender = requestRender;
		this.filterInput.focused = true;
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 1200);
	}

	get focused(): boolean {
		return true;
	}

	set focused(_value: boolean) {}

	private async refresh(): Promise<void> {
		try {
			this.error = null;
			this.sessions = await this.actions.getSessions();
			computeShortNames(this.sessions);
			// Sort: working (non-current) first, then rest, current last
			{
				const attached = this.actions.getAttached();
				const current: SessionInfo[] = [];
				const working: SessionInfo[] = [];
				const rest: SessionInfo[] = [];
				for (const s of this.sessions) {
					const isCurrent =
						s.id === PARENT_SESSION_ID
							? !attached || attached === PARENT_SESSION_ID
							: attached === s.name || attached === s.id;
					if (isCurrent) {
						current.push(s);
						continue;
					}
					((s.agentStatus || "idle") === "working" ? working : rest).push(s);
				}
				this.sessions = [...working, ...rest, ...current];
			}
			if (!this.initialSelectionSet) {
				this.updateNameWidth();
				this.selected = this.firstNonCurrentIndex();
				this.initialSelectionSet = true;
			}
			this.clampSelection();
		} catch (error) {
			this.error = String(error);
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private filteredSessions(): SessionInfo[] {
		const query = this.filterInput.getValue().trim();
		return fuzzyFilter(this.sessions, query, (session) =>
			[
				session.shortName,
				session.name,
				session.cwd,
				session.transcript,
				session.state,
			]
				.filter(Boolean)
				.join(" "),
		);
	}

	private selectedSession(): SessionInfo | null {
		return this.filteredSessions()[this.selected] || null;
	}

	private isCurrent(session: SessionInfo): boolean {
		const attached = this.actions.getAttached();
		if (session.id === PARENT_SESSION_ID)
			return !attached || attached === PARENT_SESSION_ID;
		return attached === session.name || attached === session.id;
	}

	private firstNonCurrentIndex(): number {
		const sessions = this.filteredSessions();
		const index = sessions.findIndex((session) => !this.isCurrent(session));
		return index >= 0 ? index : 0;
	}

	private clampSelection(): void {
		const max = Math.max(0, this.filteredSessions().length - 1);
		this.selected = Math.max(0, Math.min(this.selected, max));
	}

	private updateNameWidth(): void {
		const attached = this.actions.getAttached();
		let maxW = 0;
		for (const s of this.sessions) {
			const isAttached =
				s.id === PARENT_SESSION_ID
					? !attached || attached === PARENT_SESSION_ID
					: attached === s.name || attached === s.id;
			const base = s.shortName || s.name;
			const current = isAttached ? " (current)" : "";
			const w = visibleWidth(`\u203a ${base}${current}`);
			if (w > maxW) maxW = w;
		}
		this.nameWidth = Math.min(Math.max(maxW + 2, 10), 60);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.done();
	}

	handleInput(data: string): void {
		if (this.folderExplorer) {
			this.folderExplorer.handleInput(data);
			return;
		}
		if (this.resumePicker) {
			this.resumePicker.handleInput(data);
			return;
		}
		if (this.forkSelector) {
			this.forkSelector.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		if (isCtrl(data, "o")) {
			this.folderExplorer = new FileExplorer(
				this.actions.getCwd(),
				this.theme,
				(cwd: string | null) => {
					this.folderExplorer = null;
					if (cwd) {
						void this.actions.newSessionInFolder(cwd).then(() => this.close());
					} else {
						this.requestRender();
					}
				},
				this.requestRender,
			);
			this.requestRender();
			return;
		}
		if (isCtrl(data, "r")) {
			if (!this.actions.getResumeSessions) {
				void this.actions.resumeSession().then(() => this.close());
				return;
			}
			this.resumePicker = new ResumeSessionPicker(
				this.theme,
				this.actions.getResumeSessions,
				(sessionPath: string | null) => {
					this.resumePicker = null;
					if (sessionPath) {
						void this.actions
							.resumeSession(sessionPath)
							.then(() => this.close());
					} else {
						this.requestRender();
					}
				},
				this.requestRender,
			);
			this.requestRender();
			return;
		}
		if (isCtrl(data, "c")) {
			// Clone the current (attached) session, mirroring regular Pi /clone,
			// opened as a new parallel session via the extension.
			void this.actions
				.cloneSession()
				.then(() => this.close())
				.catch((error: unknown) => {
					this.actions.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
					this.requestRender();
				});
			return;
		}
		if (isCtrl(data, "f")) {
			// Fork the current (attached) session at a selected user message,
			// using Pi's original fork point selection menu. The fork opens as
			// a new parallel session; the original keeps running.
			let messages: ForkMessage[] = [];
			try {
				messages = this.actions.getForkMessages();
			} catch (error) {
				this.actions.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
				this.requestRender();
				return;
			}
			if (messages.length === 0) {
				this.actions.notify("No messages to fork from", "warning");
				return;
		}
			this.forkSelector = new ForkSelector(
				messages,
				(entryId: string | null) => {
					this.forkSelector = null;
					if (entryId) {
						void this.actions
							.forkSessionAt(entryId)
							.then(() => this.close())
							.catch((error: unknown) => {
								this.actions.notify(
									error instanceof Error ? error.message : String(error),
									"warning",
								);
								this.requestRender();
							});
					} else {
						this.requestRender();
					}
				},
				this.requestRender,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "up") || isCtrl(data, "p")) {
			this.selected = Math.max(0, this.selected - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || isCtrl(data, "n")) {
			this.selected = Math.min(
				Math.max(0, this.filteredSessions().length - 1),
				this.selected + 1,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const session = this.selectedSession();
			if (!session) return;
			void this.actions.switchTo(session.id).then(() => this.close());
			return;
		}
		if (isCtrl(data, "k")) {
			const session = this.selectedSession();
			if (!session) return;
			if (session.id === PARENT_SESSION_ID) {
				this.actions.notify("Cannot kill parent session.", "warning");
				return;
			}
			void this.actions.killSession(session.id).then(() => this.close());
			return;
		}

		const before = this.filterInput.getValue();
		this.filterInput.handleInput(data);
		if (this.filterInput.getValue() !== before) this.selected = 0;
		this.clampSelection();
		this.requestRender();
	}

	private visibleStart(total: number): number {
		if (total <= SESSIONS_MAX_VISIBLE) return 0;
		const half = Math.floor(SESSIONS_MAX_VISIBLE / 2);
		return Math.min(
			Math.max(0, this.selected - half),
			total - SESSIONS_MAX_VISIBLE,
		);
	}

	private padRows(
		lines: string[],
		width: number,
		rendered: number,
		totalItems: number,
	): void {
		const target = Math.min(
			Math.max(totalItems, rendered),
			SESSIONS_MAX_VISIBLE,
		);
		for (let i = rendered; i < target; i++) {
			lines.push(" ".repeat(Math.max(0, width)));
		}
	}

	private activity(session: SessionInfo): string {
		return session.agentStatus || "idle";
	}

	render(width: number): string[] {
		if (this.folderExplorer) return this.folderExplorer.render(width);
		if (this.resumePicker) return this.resumePicker.render(width);
		if (this.forkSelector) return this.forkSelector.render(width);

		const th = this.theme;
		const border = (color: "accent" | "dim" = "accent") =>
			th.fg(color, "─".repeat(Math.max(0, width)));
		const accent = (s: string) => th.fg("accent", s);
		const dim = (s: string) => th.fg("dim", s);
		const muted = (s: string) => th.fg("muted", s);
		const success = (s: string) => th.fg("success", s);
		const error = (s: string) => th.fg("error", s);
		const lines: string[] = [];
		const attached = this.actions.getAttached();
		const visibleSessions = this.filteredSessions();
		const total = Math.max(1, visibleSessions.length);
		const index = Math.min(this.selected + 1, total);
		const prefix = `${index}/${total}\tSessions: `;
		const renderedInput = renderInputChild(
			this.filterInput,
			width - visibleWidth(prefix),
		);

		lines.push(border());
		lines.push(accent(fits(width, `${prefix}${renderedInput}`)));
		lines.push(border("dim"));

		const startIdx = this.visibleStart(visibleSessions.length);
		const endIdx = Math.min(
			visibleSessions.length,
			startIdx + SESSIONS_MAX_VISIBLE,
		);
		let rendered = 0;
		if (this.error) {
			lines.push(padVisible(`  ${error("error")} ${this.error}`, width));
			rendered = 1;
		} else if (visibleSessions.length === 0) {
			lines.push(
				padVisible(
					`  ${dim(this.loading ? "Loading…" : "No sessions")}`,
					width,
				),
			);
			rendered = 1;
		} else {
			const nameW = this.nameWidth;
			const stateW = 9;
			for (let i = startIdx; i < endIdx; i++) {
				const session = visibleSessions[i]!;
				const selected = i === this.selected;
				const isAttached =
					session.id === PARENT_SESSION_ID
						? !attached || attached === PARENT_SESSION_ID
						: attached === session.name || attached === session.id;
				const marker = selected ? "›" : " ";
				const base = session.shortName || session.name;
				const current = isAttached ? " (current)" : "";
				const leftPlain = `${marker} ${base}${current}`;
				const tmp = selected
					? accent(`${marker} ${base}`)
					: `${marker} ${base}`;
				const styledBase = `${tmp}${dim(current)}`;
				const styledLeft = padVisible(styledBase, nameW);
				const state = this.activity(session);
				const styledState = muted(padVisible(state, stateW));
				const cwdText = session.cwd || "";
				const cwdWidth = visibleWidth(cwdText);
				const cwd = muted(cwdText);
				const transcript = muted(
					truncateToWidth(
						session.transcript || "",
						Math.max(0, width - nameW - stateW - cwdWidth - 2),
						"…",
					),
				);
				lines.push(
					padVisible(`${styledLeft}${styledState}${cwd}  ${transcript}`, width),
				);
				rendered++;
			}
		}
		this.padRows(lines, width, rendered, this.sessions.length);
		lines.push(border());
		lines.push(
			padVisible(
				dim("↑↓/<C-p>/<C-n>") +
					muted(" move · ") +
					dim("<enter>") +
					muted(" switch · ") +
					dim("<C-o>") +
					muted(" new in folder · ") +
					dim("<C-r>") +
					muted(" resume · ") +
					dim("<C-k>") +
					muted(" kill · ") +
						dim("<C-c>") +
					muted(" clone · ") +
					dim("<C-f>") +
					muted(" fork · ") +
					dim("<esc>") +
					muted(" close"),
				width,
			),
		);
		return lines;
	}

	invalidate(): void {
		this.filterInput.invalidate();
		this.folderExplorer?.invalidate();
		this.resumePicker?.invalidate();
		this.forkSelector?.invalidate();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
	}
}

export async function showSessionsView(
	ctx: any,
	actions: SessionsActions,
): Promise<void> {
	await ctx.ui.custom(
		(tui: any, theme: any, _keybindings: any, done: () => void) =>
			new SessionsView(theme, done, actions, () => tui.requestRender()),
	);
}
