"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/sessionRegistry.ts
var sessionRegistry_exports = {};
__export(sessionRegistry_exports, {
  parseRegistryRow: () => parseRegistryRow,
  readRegistry: () => readRegistry,
  resolveSessionsDir: () => resolveSessionsDir
});
module.exports = __toCommonJS(sessionRegistry_exports);
var import_child_process = require("child_process");
var import_fs = require("fs");
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var PID_JSON_RE = /^\d+\.json$/;
function resolveSessionsDir(env = process.env, home = os.homedir()) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "sessions");
}
function parseRegistryRow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw;
  if (typeof row.pid !== "number" || !Number.isSafeInteger(row.pid) || row.pid <= 0) return null;
  if (typeof row.sessionId !== "string" || !SESSION_ID_RE.test(row.sessionId)) return null;
  if (row.kind !== void 0 && row.kind !== "interactive") return null;
  return {
    pid: row.pid,
    sessionId: row.sessionId,
    kind: "interactive",
    ...typeof row.cwd === "string" ? { cwd: row.cwd } : {},
    ...typeof row.name === "string" ? { name: row.name } : {},
    ...typeof row.status === "string" ? { status: row.status } : {}
  };
}
function runAgents() {
  return new Promise((resolve, reject) => {
    (0, import_child_process.execFile)(
      "claude",
      ["agents", "--json"],
      { encoding: "utf8", timeout: 5e3, shell: false },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}
async function readRegistryFiles(sessionsDir) {
  let files;
  try {
    files = await import_fs.promises.readdir(sessionsDir);
  } catch {
    return [];
  }
  const rows = await Promise.all(files.filter((file) => PID_JSON_RE.test(file)).map(async (file) => {
    try {
      const raw = JSON.parse(await import_fs.promises.readFile(path.join(sessionsDir, file), "utf8"));
      return parseRegistryRow(raw);
    } catch {
      return null;
    }
  }));
  return rows.filter((row) => row !== null);
}
async function readRegistry(opts = {}) {
  try {
    const output = await (opts.runAgents ?? runAgents)();
    const raw = JSON.parse(output);
    if (Array.isArray(raw)) {
      const rows = raw.map(parseRegistryRow).filter((row) => row !== null);
      if (rows.length > 0) return rows;
    }
  } catch {
  }
  return readRegistryFiles(opts.sessionsDir ?? resolveSessionsDir());
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseRegistryRow,
  readRegistry,
  resolveSessionsDir
});
