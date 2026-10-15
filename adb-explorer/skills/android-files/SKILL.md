---
name: android-files
description: Manage files on the user's connected Android device over adb - find, list, measure, copy to or from the Mac, move, and clean up files on the phone. Use when the user asks about files, photos, videos, downloads, storage or folders on their phone, tablet or Android device, or refers to what the /adb-explorer pane shows ("this folder", "the marked files").
---

# ADB Explorer

You manage files on the user's Android device by running `adb` with the Bash tool. The user may also have the `/adb-explorer` pane open, which shows one folder of the device. The pane refreshes itself when your turn ends, so they will see what you changed.

## Start of every task

1. **Know what the user is looking at.** If they say "this folder", "these", "the marked files" or similar, call the `mcp__adb-explorer__adb_explorer_state` tool. It returns `paneOpen`. When `true`, it also gives the device serial, model, the pane's current folder and the paths they marked; treat those paths as the selection. When `false`, the pane is closed: don't say it's open, and suggest `/adb-explorer` if they want to browse.
2. **Pick the device.** Run `adb devices -l`. Use only devices in state `device`.
   - `unauthorized`: ask the user to unlock the phone and tap Allow on the USB debugging prompt.
   - No device: ask them to connect it by USB with USB debugging on.
   - More than one: use the pane's device if the state tool returned one, otherwise ask which.
3. **Always pass `-s <serial>`** to every adb command, so you never act on the wrong device.

**Find adb in this order and use the first that exists:** `$ANDROID_HOME/platform-tools/adb`, `$ANDROID_SDK_ROOT/platform-tools/adb`, `~/Library/Android/sdk/platform-tools/adb`, then `adb` on PATH, `/opt/homebrew/bin/adb`, `/usr/local/bin/adb`. Prefer the Android SDK's copy: a different adb version restarts the adb server and drops Android Studio's connection to the device. Only if none exists, say adb comes with Android Studio, or can be installed alone with `brew install android-platform-tools`. Don't install it yourself.

The examples below write `adb`; use the full path you found.

## Running commands on the device

`adb -s SERIAL shell '<command>'` runs a command in the device's `/system/bin/sh` (toybox). Put the whole remote command in one single-quoted argument, and quote paths inside it, because names often contain spaces:

```bash
adb -s SERIAL shell 'ls -la "/sdcard/DCIM/Camera"'
adb -s SERIAL shell 'du -sh /sdcard/* 2>/dev/null | sort -rh | head -20'
adb -s SERIAL shell 'find /sdcard/Download -type f -size +100M -exec ls -la {} \;'
adb -s SERIAL shell 'find /sdcard/DCIM -type f -mtime +365 | wc -l'
```

Batch work into one shell call where you can; every adb call has some overhead, and `find` over adb is slow, so scope it to a folder rather than all of `/sdcard`.

## Where things live

| What | Path |
| --- | --- |
| Camera photos and videos | `/sdcard/DCIM/Camera` |
| Screenshots | `/sdcard/Pictures/Screenshots` (some phones: `/sdcard/DCIM/Screenshots`) |
| Downloads | `/sdcard/Download` |
| WhatsApp media | `/sdcard/Android/media/com.whatsapp/WhatsApp/Media` |
| Telegram | `/sdcard/Telegram` or `/sdcard/Android/media/org.telegram.messenger` |
| Music, recordings | `/sdcard/Music`, `/sdcard/Recordings` |

On Android 11 and later, `/sdcard/Android/data` and `/sdcard/Android/obb` are usually blocked for adb. A "Permission denied" there is expected; say so instead of retrying.

## Copying

- **Phone to Mac:** `adb -s SERIAL pull -a "<device path>" "<mac folder>/"`. Unless the user names a folder, use `~/Downloads/adb-explorer/<model>/` (the pane's Pull uses the same place). Create it first.
- **Mac to phone:** `adb -s SERIAL push "<mac path>" "<device folder>/"`.
- For many files, pull the folder rather than file by file. Report how many files and how much data moved.

## Deleting and moving: rules

These are not optional.

1. **Only inside user storage.** Never delete, move or overwrite anything outside `/sdcard/` or `/storage/emulated/0/`, and never those folders themselves. Refuse requests that touch `/system`, `/data`, `/vendor` or the root.
2. **Show before you delete.** List what will be affected (count, total size, a sample of names) and get an explicit yes from the user in chat before running any delete or move.
3. **Trash by default.** Move files to `/sdcard/_adb_trash/<YYYY-MM-DD_HH-MM-SS>/` with `mkdir -p` then `mv --`. This is a cheap rename on the same storage and the user can restore it. Use `rm -rf --` only when the user explicitly asks to delete permanently or to empty `/sdcard/_adb_trash`.
4. **Back up first when asked to "clean up" photos or videos.** Offer to pull them to the Mac before removing them from the phone.
5. **Never use wildcards in a delete without listing their expansion first.**

After deleting from media folders, the Gallery app may still show stale thumbnails until it rescans. Tell the user this can take a moment, or a restart of the Gallery app.

## Reporting back

Keep it short: what you found or changed, sizes in human units (MB/GB), and where copied files went. If the pane is open, mention that it now shows the result.
