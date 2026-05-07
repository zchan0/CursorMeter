import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const TOKEN_DB_KEY = "WorkosCursorSessionToken";
const MAX_RAW_DB_SCAN_BYTES = 128 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function resolveToken(
  log: vscode.OutputChannel,
): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("cursorMeter");
  const legacyConfig = vscode.workspace.getConfiguration("cursorUsage");

  const manualCurrent = config.get<string>("sessionToken")?.trim();
  const manualLegacy = legacyConfig.get<string>("sessionToken")?.trim();
  const manual = manualCurrent || manualLegacy;
  if (manual) {
    const usingLegacyManual = !manualCurrent && !!manualLegacy;
    if (usingLegacyManual) {
      log.appendLine("[auth] Using legacy cursorUsage.sessionToken");
    } else {
      log.appendLine("[auth] Using manually configured token");
    }
    return manual;
  }

  const currentAutoRead = config.inspect<boolean>("autoReadToken");
  const legacyAutoRead = legacyConfig.inspect<boolean>("autoReadToken");
  const autoRead =
    currentAutoRead?.workspaceValue ??
    currentAutoRead?.globalValue ??
    legacyAutoRead?.workspaceValue ??
    legacyAutoRead?.globalValue ??
    true;
  if (!autoRead) {
    log.appendLine("[auth] Auto-read disabled and no manual token");
    return undefined;
  }

  return readTokenFromDb(log);
}

async function readTokenFromDb(
  log: vscode.OutputChannel,
): Promise<string | undefined> {
  const dbPath = getCursorDbPath();
  if (!dbPath) {
    log.appendLine("[auth] Unsupported platform for auto-read");
    return undefined;
  }

  if (!fs.existsSync(dbPath)) {
    log.appendLine("[auth] Cursor DB not found at expected path");
    return undefined;
  }

  try {
    const token = await queryTokenFromSqlite(dbPath, log);
    if (token) {
      log.appendLine("[auth] Token read from local Cursor database");
      return token;
    }
    log.appendLine("[auth] Token key not found in database");
    return undefined;
  } catch (err: unknown) {
    log.appendLine(`[auth] Failed to read DB: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function getCursorDbPath(): string | undefined {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(
      process.env.HOME ?? "",
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
  }
  if (platform === "win32") {
    return path.join(
      process.env.APPDATA ?? "",
      "Cursor/User/globalStorage/state.vscdb",
    );
  }
  if (platform === "linux") {
    return path.join(
      process.env.HOME ?? "",
      ".config/Cursor/User/globalStorage/state.vscdb",
    );
  }
  return undefined;
}

async function queryTokenFromSqlite(
  dbPath: string,
  log: vscode.OutputChannel,
): Promise<string | undefined> {
  const sqliteToken = await queryTokenWithSqliteCli(dbPath, log);
  if (sqliteToken) {
    return sqliteToken;
  }

  const stat = await fs.promises.stat(dbPath);
  if (stat.size > MAX_RAW_DB_SCAN_BYTES) {
    log.appendLine("[auth] Cursor DB too large for raw scan fallback");
    return undefined;
  }

  const buf = await fs.promises.readFile(dbPath);
  const content = buf.toString("utf-8");

  const keyIndex = content.indexOf(TOKEN_DB_KEY);
  if (keyIndex === -1) {
    return undefined;
  }

  // The token value follows the key in the SQLite page.
  // Look for the characteristic "user_" prefix that starts the token.
  const searchStart = keyIndex + TOKEN_DB_KEY.length;
  const tokenMatch = content.substring(searchStart, searchStart + 2000).match(
    /user_[A-Za-z0-9_\-:.]{20,}/,
  );
  return tokenMatch ? tokenMatch[0] : undefined;
}

async function queryTokenWithSqliteCli(
  dbPath: string,
  log: vscode.OutputChannel,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        dbPath,
        `SELECT value FROM itemTable WHERE key='${TOKEN_DB_KEY}' LIMIT 1;`,
      ],
      { timeout: 5_000, maxBuffer: 20_000 },
    );
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch (err) {
    log.appendLine(
      `[auth] sqlite3 token query unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
