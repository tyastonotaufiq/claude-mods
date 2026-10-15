# claude-mods

Claude Code mods that add a working pane to Claude Code, plus a skill so you can also just ask Claude.

| Mod | Command | What it does |
| --- | --- | --- |
| [ADB Explorer](./adb-explorer) | `/adb-explorer` | Browse files on an Android phone over `adb`: folder sizes, copy to and from your Mac, delete with confirmation (moves to a device-side trash by default). |
| [Mac Cleaner](./mac-cleaner) | `/mac-cleaner` | See what's using space on your Mac (caches, logs, Xcode, Gradle, emulators, npm…), mark what to remove, and move it to the Trash. Claude can dig deeper and add its findings to the pane. |

## Install

In a Claude Code terminal session:

```
/plugin install adb-explorer --marketplace tyastonotaufiq/claude-mods
/plugin install mac-cleaner --marketplace tyastonotaufiq/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. The mod is active right away.

From a shell:

```bash
claude plugin install adb-explorer --marketplace tyastonotaufiq/claude-mods
claude plugin install mac-cleaner --marketplace tyastonotaufiq/claude-mods
```

In the Claude Desktop app: click **+** next to the prompt box, then **Plugins › Add marketplace** with `tyastonotaufiq/claude-mods`, then **Add plugin**. A mod installed from a terminal at the user scope also loads in the Desktop app's Code tab.

To run a mod in the Desktop app, open the **Code** tab, start a session, and type `/adb-explorer` or `/mac-cleaner` in the prompt box. Mods don't run in regular chats. Each mod's README has the Desktop details.

## Requirements

- Claude Code v2.1.287 or later (terminal, or the Code tab of the Desktop app v2.1.286+)
- ADB Explorer: `adb` from Android Studio's SDK (found automatically), or `brew install android-platform-tools` without Android Studio; and USB debugging on the phone
- Mac Cleaner: macOS

## Safety

Mods run inside Claude Code with your permissions and aren't sandboxed. Both mods are small and readable; check `hooks/` in each before installing.

- **ADB Explorer** deletes only inside `/sdcard`, always asks first, and defaults to moving files to `/sdcard/_adb_trash/` instead of erasing them.
- **Mac Cleaner** never deletes: it moves what you confirm to the Trash (Put Back works), and always refuses iCloud Drive, Mail, Photos, Keychains, `~/.ssh` and app containers.

## Develop

```bash
claude --plugin-dir ./adb-explorer      # load from the folder; reloads on save
claude plugin validate ./adb-explorer
claude plugin test ./adb-explorer
```

## License

[MIT](./LICENSE)
