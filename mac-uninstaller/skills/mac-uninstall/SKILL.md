---
name: mac-uninstall
description: Uninstall a Mac app completely, including the files it leaves in ~/Library and elsewhere, or clean up what already-removed apps left behind. Use when the user asks to uninstall or fully remove an app, asks what an app left behind, wants to reset an app, or refers to the /mac-uninstaller pane ("these", "the marked items").
---

# Mac uninstall

You help the user remove an app and everything it left behind. You **find and explain**; the user **decides** in the `/mac-uninstaller` pane, which moves what they mark to the Trash. You don't delete anything yourself.

## How you and the pane work together

- `/mac-uninstaller` lists installed apps. Picking one shows the app and its files in the usual `~/Library` places (Application Support, Caches, Preferences, Containers, Saved Application State, HTTPStorages, WebKit, LaunchAgents…). It marks files named after the app's bundle ID, and lists name matches and shared group containers unmarked. `/mac-uninstaller <app name>` opens that app directly.
- **Leftovers of removed apps** (`o` in the pane) lists files whose app is no longer on the Mac, one row per bundle ID.
- Call `mcp__mac-uninstaller__mac_uninstaller_state` to see whether the pane is open, which app it shows (name, bundle ID, path), what it lists and what the user marked. If it's closed, tell the user to run `/mac-uninstaller <app>`. Don't say it's open when it isn't.
- You add what the pane can't find by writing **`~/.claude/mac-uninstaller/findings.json`**. When your turn ends, the pane picks it up if it shows that app, and lists your items unmarked with your reason.

### findings.json

Write the whole file each time (it replaces your earlier findings):

```json
{
  "app": "com.microsoft.VSCode",
  "items": [
    { "path": "~/.vscode", "sizeBytes": 734003200, "reason": "Extensions and settings for VS Code" }
  ]
}
```

- `app`: the bundle ID of the app the pane shows. Findings for another app are ignored.
- `path`: absolute or `~/...`, one file or folder per item.
- `sizeBytes`: from `du -sk` × 1024.
- `reason`: one line the user can judge from.

The pane drops anything it may not move. It accepts only:
- items directly inside the `~/Library` places above
- a dotfolder or dotfile in home (`~/.vscode`)
- items directly in `~/.config`, `~/.local/share` or `~/.cache`

It never accepts `~/.ssh`, `~/.gnupg`, `~/.aws`, shell startup files, `~/.claude`, or another app's container. Don't propose those.

## Where to look beyond the pane

Get the bundle ID and name from the state tool, then:

| Look for | Command |
| --- | --- |
| Anything else named after the app | `mdfind -onlyin ~ "kMDItemFSName == '*<Name>*'c"` and `find ~ -maxdepth 3 -iname '*<name>*' -not -path '*/Library/Mobile Documents/*' 2>/dev/null` |
| Dotfolders and CLI config | `ls -d ~/.<name>* ~/.config/<name>* ~/.local/share/<name>* 2>/dev/null` |
| Login and background items | `ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons | grep -i <name>`, and `launchctl list | grep -i <id>` |
| What its installer put down | `pkgutil --pkgs | grep -i <name>`, then `pkgutil --files <pkg-id>` |
| System-wide support files | `ls /Library/Application\ Support /Library/PrivilegedHelperTools /Library/Preferences | grep -i <name>` |

Some folders need **Full Disk Access**. If `du` or `find` reports "Operation not permitted", tell the user they can grant it to their terminal app (or Claude) in System Settings › Privacy & Security › Full Disk Access, rather than retrying.

## System-wide files need the user, not the pane

The pane only moves what's in the home folder, `/Applications` and `~/Applications`. For leftovers under `/Library` (launch daemons, privileged helpers, kernel or system extensions, installer receipts), don't write them to findings.json. List them with sizes, and explain what each is. Then give the exact commands for the user to run:
- `launchctl bootout` for a running daemon
- `sudo rm` for the file
- `sudo pkgutil --forget` for the receipt

Run any of these only after the user says yes, and say that they need the user's password.

If the app ships its own uninstaller (many VPNs, Adobe, Microsoft AutoUpdate, Docker), recommend running that first. It also removes system extensions and network settings that moving files can't undo.

## Rules

1. Never run `rm`, `trash`, `mv` to the Trash, or any other delete yourself in the home folder. The pane does that after the user confirms.
2. Never propose the user's own documents, projects or cloud folders, even when an app created them (a `~/Documents/<App>` folder may hold the user's work). Mention them instead.
3. When it's unclear whether a file belongs to this app or a sibling from the same developer (Office apps share containers), say so in `reason`.
4. Remind the user to quit the app first, and that the space comes back only when they empty the Trash.
