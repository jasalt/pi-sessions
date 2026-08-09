# pi-sessions

`pi-sessions` turns one Pi process into an in-process live-session multiplexer.

Multiple Pi sessions can stay alive concurrently. Exactly one session owns the terminal at a time. Switching away stops only the inactive TUI, with its agent runtime still running in background.

![pi-sessions switcher UI](screenshot.png)

## Install

```bash
pi install npm:pi-parallel-sessions
```

Or install directly from GitHub:

```bash
pi install git:github.com/liushihao456/pi-sessions
```

## Command

Only one slash command is exposed:

- `/sessions` — open the session switcher.

Shortcut:

- `Ctrl-R` — open the same session switcher without typing `/sessions`.

All session operations happen inside that switcher.

## Switcher keys

- type normally — filter live sessions.
- `↑` / `↓` or `Ctrl-P` / `Ctrl-N` — move selection.
- `Enter` — switch to selected live session. Selecting `parent` switches back to parent.
- `Ctrl-O` — open `FileExplorer`; selecting a folder creates a new child session in that folder and switches to it.
- `Ctrl-R` — open a one-off resume flow; selecting a saved Pi session opens it as a live child and switches to it.
- `Ctrl-K` — stop selected live child session.
- `Ctrl-C` — clone the current (attached) session, mirroring regular Pi `/clone`
  (fork at the current position) but opened as a new live child session; the
  original session keeps running.
- `Ctrl-F` — fork the current (attached) session using Pi's original fork point
  selection menu: pick a user message and the active path up to that point is
  copied into a new live child session (the original keeps running), with the
  selected message's text pre-filled in the new session's editor — the same
  behavior as Pi's native `/fork`.
- `Esc` — close switcher.

## Runtime model

```text
parent Pi process
  └─ pi-sessions live-session multiplexer
      ├─ parent: existing InteractiveMode
      ├─ child A: AgentSessionRuntime + InteractiveMode
      ├─ child B: AgentSessionRuntime + InteractiveMode
      └─ child C: AgentSessionRuntime + InteractiveMode
```

Child sessions are real native `InteractiveMode` instances, not embedded panels. When active, child UI is full-screen and native Pi slash-command UI works as usual.

Child sessions load the same extensions as the parent (command-line `-e`
paths are re-fed into each child's resource loader), so the switcher shortcut,
`/sessions`, and the widget work from inside a child session too.

`/quit` keeps native behavior and exits the whole Pi process.

## Path locks

All live sessions share one in-process lock manager. Before write/edit/mutating shell tools run, `pi-sessions` checks for conflicting path locks and blocks conflicting writes.

This prevents two live sessions from editing the same path tree at once.

## Resume / re-attach

The set of live sessions is persisted to `~/.pi/agent/pi-sessions-state-<parentSessionId>.json` whenever the live set changes and on exit (C-c C-c). After quitting with C-c C-c, resume the parent session normally:

```bash
pi --session <parent-session-id>
```

All parallel sessions that were running before the exit are re-attached automatically as suspended live sessions — they reappear in the widget and switcher, and switching to one starts its runtime exactly like any other session. Resuming any former child session id works too: that session becomes the main session and all siblings (including the old parent) are re-attached alongside it.

A fresh `pi` (no `--session`) never restores anything, and the state file is removed again once no parallel sessions remain.
