---
name: mac-storage
description: Find what's using disk space on the user's Mac and propose what to clean up - large or old files, caches, build output, old projects' dependencies, simulators and emulators. Use when the user asks why their disk is full, how to free space, what's taking space, or refers to the /mac-cleaner pane ("these", "the marked items").
---

# Mac storage

You find what's using space on the user's Mac and explain what can go. You **propose**; the user **decides** in the `/mac-cleaner` pane, which moves what they mark to the Trash. You don't delete anything yourself.

This is for macOS only. On Windows or Linux, `/mac-cleaner` only replies that it needs macOS: don't mention the pane or findings.json; just help directly with that system's own tools.

## How you and the pane work together

- The pane runs its own quick scan of well-known caches (app caches, logs, Xcode, Gradle, emulators, npm, CocoaPods, `.hprof` heap dumps directly in `~`). Don't repeat that work; look for what it can't judge.
- You add findings by writing **`~/.claude/mac-cleaner/findings.json`**. When your turn ends, an open pane picks them up and lists them with your reason.
- Call `mcp__mac-cleaner__mac_cleaner_state` to see whether the pane is open, what it lists and what the user marked. If it's closed, tell the user to run `/mac-cleaner` to review your findings. Don't say it's open when it isn't. A row whose `path` starts with `small:` is a summary of many items under 10 MB in one category; its `members` are the real paths.

### findings.json

Write the whole file each time (it replaces your earlier findings):

```json
{
  "generatedAt": "2026-10-15T15:30:00+07:00",
  "items": [
    {
      "path": "~/Downloads/Xcode_15.2.xip",
      "sizeBytes": 7340032000,
      "category": "Downloads",
      "risk": "safe",
      "reason": "Xcode installer from Jan 2024; Xcode 16 is installed"
    }
  ]
}
```

- `path`: absolute or `~/...`. One file or folder per item. Don't list a folder and also something inside it.
- `sizeBytes`: from `du -sk` × 1024.
- `risk`: `safe` only when it's regenerated automatically or clearly a duplicate/installer; otherwise `review`.
- `reason`: one line the user can judge from: what it is, how old, why it can go.

The pane silently drops anything outside the home folder, folders and hidden files directly in home, and protected places (iCloud Drive, Mail, Messages, Photos library, Keychains, `~/Library/Containers`, `~/.ssh`). Don't propose those.

## Where to look

Start broad, then drill into the biggest:

```bash
df -h ~                                                   # how full the disk is
du -sh ~/* ~/.[!.]* 2>/dev/null | sort -rh | head -20     # biggest things in home
du -sh ~/Library/* 2>/dev/null | sort -rh | head -15
```

Then check, in rough order of payoff:

| Look for | Command | Usually |
| --- | --- | --- |
| Large files anywhere in home | `find ~ -xdev -type f -size +1G 2>/dev/null` (skip `~/Library/Mobile Documents`) | review |
| Old downloads | `find ~/Downloads -maxdepth 1 -mtime +90` then `du -sh` each | installers (`.dmg`, `.pkg`, `.xip`, `.zip`) safe if the app is installed; else review |
| `node_modules` in projects untouched for 90+ days | `find ~ -xdev -type d -name node_modules -prune -mtime +90 2>/dev/null` | safe (restored by `npm install`) |
| Android `build/` folders in old projects | `find ~ -xdev -type d -name build -path '*/app/build' -prune 2>/dev/null` | safe (rebuilt) |
| iOS simulators no longer available | `xcrun simctl list devices unavailable` | suggest `xcrun simctl delete unavailable` |
| Homebrew leftovers | `brew cleanup --dry-run` | suggest running `brew cleanup` |
| Docker | `docker system df` | suggest `docker system prune` (never trash Docker's data folder) |
| iPhone backups | `du -sh ~/Library/Application\ Support/MobileSync/Backup/*` | review; tell the user to manage them in Finder, don't list them |
| Large mail attachments, Photos | | out of scope; mention the app's own tools |

Some folders need **Full Disk Access**. If `du` reports "Operation not permitted", tell the user they can grant it to their terminal app (or Claude) in System Settings › Privacy & Security › Full Disk Access, rather than retrying.

## Commands, not files

For things a tool cleans better than the Trash (`brew cleanup`, `xcrun simctl delete unavailable`, `docker system prune`, `npm cache clean`), don't add them to findings.json. Say what the command does and how much it should free, and run it only after the user says yes.

## Rules

1. Never run `rm`, `trash`, `mv` to the Trash, or any other delete yourself. The pane does that after the user confirms.
2. Never propose anything in the user's own documents, projects' source, photos, or cloud folders as `safe`. If a large personal file stands out, list it as `review` with a factual reason, or just mention it.
3. Report sizes in GB/MB and give a total of what your findings would free.
4. Remind the user that the space comes back only when they empty the Trash.
