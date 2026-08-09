# TODO

Known issues and follow-ups, filed while implementing session restore on resume.

## 1. `/sessions` command breaks when the extension is loaded twice

If pi-sessions ends up loaded twice in one process (e.g. listed in `settings.json`
`packages` **and** also passed via `pi -e <path>`), both copies register the
`sessions` command. Pi renames duplicate command names to `sessions:1` /
`sessions:2`, so typing `/sessions` is no longer a valid command and the text is
sent to the model as a regular user message instead of opening the switcher.

The extension is built around a global host singleton (`globalThis` keyed by
`HOST_KEY`), so double-loading also double-registers every event handler
(`session_start`, `session_shutdown`, ...). The widget and switcher still work
(Ctrl-R shortcut), but the documented `/sessions` entry point silently breaks.

Possible fix directions:

- Detect the duplicate registration in the extension's default export and
  refuse to re-register handlers when the host singleton is already set up.
- Register the command under a name that is unlikely to collide, or make the
  switcher reachable through a built-in-safe route.
- At minimum, surface a warning when the extension is loaded twice.

## 2. `ctrl+r` shortcut conflicts with the built-in `app.session.rename`

Pi warns at startup:

```
Extension shortcut conflict: 'ctrl+r' is built-in shortcut for app.session.rename
```

The extension's Ctrl-R (open sessions switcher) and the built-in session rename
share the same key. Whichever wins, the other feature is unreachable via that
key for the user's active keybinding scheme.

Possible fix directions:

- Switch the extension shortcut to a non-conflicting key (e.g. `ctrl+shift+r`),
  or make it configurable.
- Alternatively, leave the shortcut as-is and document the conflict + how to
  rebind either side in `keybindings.json`.

## 3. Sessions menu opened from a child session shows only the parent

Opening the switcher while a **child** session is active (Ctrl-R inside a
child) renders a `1/1` list containing just the parent session — the active
child is missing from its own switcher, and the `(current)` marker sits on the
parent. From the parent, the same menu correctly lists all sessions. The
widget, which reads the same host snapshot, shows all sessions in both cases.

Additionally, when a child session's editor has focus, extension shortcut
keys can fall through to the editor: during testing, keystrokes intended for
the switcher (`C-o`, `C-c`) were delivered as editor input and "sub1"/"work2"
were sent to the model as user messages. Only the parent's editor routes the
extension's `ctrl+r`/`ctrl+o`/`ctrl+c` shortcuts reliably.

Likely related to issue #2: the child mode's keybinding setup / shortcut
registration path differs from the parent's. Worth investigating together
with the shortcut conflict.
