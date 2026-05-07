# Cursor Meter

![Cursor Meter Icon](assets/icon.png)

**Cursor Meter** displays your Cursor account usage directly in the status bar:
Included usage, On-Demand usage, reset date, and a rough daily pace estimate.

## Features

- 📊 **Status Bar Integration**: Real-time display of your Cursor usage in the status bar.
- 🔄 **Auto Token Reading**: By default, it automatically extracts your secure session token from your local Cursor database, requiring zero setup.
- ⏱️ **Customizable Interval**: Configure how often the usage statistics are refreshed.
- ⚡ **Manual Refresh**: Quickly force a usage update via the Command Palette.

## API Compatibility Note

Cursor Meter relies on Cursor's private web APIs. These endpoints and response
fields can change without notice. When Cursor changes billing fields, the
extension may temporarily show inaccurate Included / On-Demand values until the
parsing logic is updated.

As of recent Cursor API changes, Team usage may no longer expose member-level
`spendCents` / `includedSpendCents` in `get-team-spend`. Cursor Meter treats
event kinds such as `USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS` and
`USAGE_EVENT_KIND_USAGE_BASED` differently to avoid counting Included usage as
On-Demand usage.

## Configuration & Usage

For most users, **Cursor Meter works out of the box** in the Cursor editor! The extension will automatically read your local Cursor session.

If you need to configure it manually or want to tweak the settings, you can find the following options in your `settings.json` or by searching for `Cursor Meter` in the Settings UI:

### 1. Auto Read Token (Default: `true`)
**Setting:** `cursorMeter.autoReadToken`
Enable this to automatically read the token from your local Cursor database when no manual token is configured.

### 2. Manual Session Token
**Setting:** `cursorMeter.sessionToken`
If the automatic reading fails or if you are using a different editor environment, you can set your token manually:
1. Open your browser and go to [cursor.com/settings](https://cursor.com/settings) (ensure you are logged in).
2. Open your browser's **Developer Tools** (F12 or `Cmd+Option+I` on Mac).
3. Navigate to the **Application** tab (or **Storage** tab in Firefox).
4. Under **Cookies**, select `https://cursor.com`.
5. Find the cookie named `WorkosCursorSessionToken` and copy its Value.
6. Paste this value into the `cursorMeter.sessionToken` setting in VS Code / Cursor.

### 3. Refresh Interval
**Setting:** `cursorMeter.refreshIntervalMinutes`
Set the auto-refresh interval in minutes (Min: 1, Max: 60, Default: 5).

## Commands

- **`Cursor Meter: Refresh`**: Manually trigger a fetch of the latest token usage from Cursor API. You can run this from the Command Palette (`Cmd/Ctrl+Shift+P`).

## License

MIT
