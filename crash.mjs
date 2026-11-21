// A client for core dumps on a Linux machine with systemd-coredump: the crash list, one crash with its
// stack, the package that owns the module at fault, what the journal and pacman.log say around it, and
// a symbolized backtrace through gdb in batch mode.
//
// Three checks. Nothing here changes the system unless the caller asked for a change (`act`); a core is
// a copy of a process's memory, so only backtraces, signal, module and package names leave this file
// (never memory, never the environment, never strings), and command lines, journal lines and gdb output
// pass through `mask`; every program runs with execFile, a timeout and a fixed argument list.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const notInThisAsk = (what) => {
  throw new Error(`not in this ask: ${what} changes things, and the caller did not ask for a change (act: true), so nothing was done. Answer what you can, and say that this needs \`ask\` with act: true. Do not look for another way to do it.`);
};

const COREDUMP_ID = "fc2e22bc6ee647b6b90729ab34a250b1";
const SIGNALS = {
  4: ["SIGILL", "illegal instruction: the CPU met bytes it cannot run (corrupt code, a build for another CPU, or a jump into data)"],
  5: ["SIGTRAP", "trap: the program stopped itself on a breakpoint or a failed internal check (Chromium CHECK failures end this way)"],
  6: ["SIGABRT", "abort: the program or a library called abort() after an assertion, an uncaught exception or a fatal error it detected itself"],
  7: ["SIGBUS", "bus error: access to memory that is not backed (a truncated mapped file, bad alignment)"],
  8: ["SIGFPE", "arithmetic error: an integer division by zero or an overflow trap"],
  11: ["SIGSEGV", "segmentation fault: the program touched memory it may not (null or dangling pointer, use after free, stack overflow)"],
  31: ["SIGSYS", "bad system call, usually blocked by a seccomp sandbox"],
};
const GPU = /nvidia|nouveau|radeonsi|amdgpu|libvulkan|vulkan_|libgallium|_dri\.so|libGLX|libEGL|libGL\.|libGLdispatch|libcuda|libdrm|mesa|iris_dri|zink|libgbm|dri_gbm|libamdvlk|libva|libvdpau|swrast/i;
const COMPOSITOR = /hyprland|aquamarine|hyprutils|hyprlang|hyprcursor|libwayland|wlroots|libxkbcommon|libinput|libseat|libliftoff|xwayland/i;
const LIBC = /^(libc\.so|libc-|ld-linux|libpthread|libm\.so|ld\.so)/;
const ABORT_CHAIN = /^(raise|abort|gsignal|pthread_kill|__pthread_kill\w*|__GI_raise|__GI_abort|_IO_new_)/;

/** Remove what looks like a credential from a line of text: URL passwords, secret-named options and variables, known token shapes, long opaque strings. */
export function mask(s) {
  return String(s ?? "")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1***@")
    .replace(/(authorization:\s*)(bearer|basic)\s+\S+/gi, "$1$2 ***")
    .replace(/(--?[\w-]*(?:pass(?:word|wd)?|token|secret|apikey|api-key|key|auth|cookie|bearer|credential)[\w-]*)([=\s]+)(\S+)/gi, "$1$2***")
    .replace(/\b([A-Za-z_][\w]*(?:PASS(?:WORD)?|TOKEN|SECRET|KEY|AUTH|COOKIE|CREDENTIAL)[\w]*)=\S+/gi, "$1=***")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA|AIza|eyJ|glpat-)[A-Za-z0-9_\-.]{8,}/g, "***")
    .replace(/(?<![\w/.-])[A-Za-z0-9+/_=-]{40,}(?![\w/.-])/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "***" : m));
}
const clip = (s, n = 200) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

const pad = (n) => String(n).padStart(2, "0");
/** Local time with its UTC offset, e.g. 2026-11-08 12:44:12 +01:00. */
export function fmt(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// The CRASH_TOOLS_DIR setting: a folder searched before PATH for the programs this file runs (recorded output for tests).
let toolsDir = null;
function exec(cmd, args, { timeoutMs = 30_000, env, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer, encoding: "utf8", env: { ...process.env, ...(toolsDir ? { PATH: `${toolsDir}:${process.env.PATH ?? ""}` } : {}), LC_ALL: "C", NO_COLOR: "1", ...env } }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") resolve({ code: 127, out: "", err: `${cmd} is not installed`, missing: true });
      else resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout ?? "", err: String(stderr ?? "").slice(0, 3000), ...(err?.killed ? { timedOut: true } : {}) });
    });
  });
}

const safeArg = (v, what) => {
  const s = String(v);
  if (s.startsWith("-") && !/^-\d+\s*(s|sec|min|m|h|hours?|d|days?|w|weeks?)$/i.test(s)) throw new Error(`${what} must not start with "-": ${s}`);
  if (/[\0\n]/.test(s)) throw new Error(`${what} holds a control character`);
  return s;
};

/** Parse the stack text systemd-coredump puts in the journal message (and `coredumpctl info` prints). */
export function parseStacks(message) {
  const threads = [];
  let cur = null;
  for (const raw of String(message ?? "").split("\n")) {
    const l = raw.trim();
    const t = l.match(/^Stack trace of thread (\d+):/);
    if (t) {
      cur = { tid: +t[1], frames: [] };
      threads.push(cur);
      continue;
    }
    const f = l.match(/^#(\d+)\s+0x([0-9a-f]+)\s+(\S+)\s+\((.*)\)$/);
    if (f && cur) {
      const [mod, off] = f[4].split(/ \+ /);
      cur.frames.push({ n: +f[1], addr: "0x" + f[2], symbol: f[3], module: mod, off: off ?? null });
    }
  }
  return threads;
}

const demangle = async (names) => {
  const mangled = names.filter((n) => /^_Z/.test(n));
  if (!mangled.length) return {};
  return new Promise((resolve) => {
    const child = execFile("c++filt", [], { timeout: 10_000, encoding: "utf8" }, (err, stdout) => {
      if (err) return resolve({});
      const out = stdout.split("\n");
      resolve(Object.fromEntries(mangled.map((m, i) => [m, out[i]])));
    });
    child.on("error", () => resolve({}));
    child.stdin.on("error", () => {});
    child.stdin.end(mangled.join("\n") + "\n");
  });
};

export const isLibc = (f) => LIBC.test(f.module ?? "");

/**
 * Where the fault is, from a stack with the crashing frame first. Skips what only reports the crash:
 * raise/abort/pthread_kill, and a program's own crash handler that re-raises the signal (the frame
 * after the signal trampoline is then the real one).
 */
export function faultingFrame(frames, signo, signalHandlerAt) {
  if (!frames.length) return { index: null, via: "no frames" };
  if (signalHandlerAt != null) return { index: Math.min(signalHandlerAt + 1, frames.length - 1), via: "after the frame gdb marks as a signal handler" };
  const head = frames.slice(0, 4);
  const reraise = head.some((f) => isLibc(f) && ABORT_CHAIN.test(f.symbol));
  const viaPthreadKill = isLibc(frames[0]) && frames[0].symbol === "n/a" && frames[1] && ABORT_CHAIN.test(frames[1].symbol);
  if (reraise || viaPthreadKill) {
    const skippable = (f) => (isLibc(f) || /^(libstdc\+\+|libgcc_s)/.test(f.module ?? "")) && (f.symbol === "n/a" || /abort|raise|gsignal|pthread_kill|assert|terminate|__cxa_|_Unwind|malloc_printerr|libc_message|chk_fail|fortify/i.test(f.symbol));
    let i = 0;
    const via = [];
    while (i < frames.length && skippable(frames[i])) {
      if (frames[i].symbol !== "n/a" && !/^(raise|abort|gsignal|pthread_kill|__pthread_kill\w*|__GI_raise|__GI_abort)$/.test(frames[i].symbol) && !via.includes(frames[i].symbol)) via.push(frames[i].symbol);
      i++;
    }
    if (signo === 6 || signo === 5) return { index: Math.min(i, frames.length - 1), via: "caller of the abort chain", abortCaller: true, abortVia: via };
    // A synchronous signal that shows raise() on top: the program's handler re-raised it. The libc frame without a name after the handler is the signal trampoline.
    i = 0;
    while (i < frames.length && isLibc(frames[i]) && (ABORT_CHAIN.test(frames[i].symbol) || (frames[i].symbol === "n/a" && i <= 1))) i++;
    for (let j = i + 1; j <= Math.min(i + 3, frames.length - 1); j++) {
      if (isLibc(frames[j]) && frames[j].symbol === "n/a") return { index: Math.min(j + 1, frames.length - 1), via: "after the signal trampoline (the program's own crash handler re-raised the signal)", handlerReraise: true, handlerFrame: frames[i] };
    }
    return { index: Math.min(i, frames.length - 1), via: "after raise/abort", abortCaller: true, abortVia: via };
  }
  return { index: 0, via: "top frame" };
}

export function make({ settings, push, cwd, act }) {
  const dir = settings?.CRASH_TOOLS_DIR || process.env.CRASH_TOOLS_DIR;
  if (dir) toolsDir = path.resolve(cwd ?? process.cwd(), dir.replace(/^~(?=\/|$)/, os.homedir()));
  return makeCrash({ push, act: !!act, cwd });
}

export function makeCrash({ push = () => {}, act = false, cwd = process.cwd() } = {}) {
  const note = (detail, started, r) => push({ kind: "crash", detail: clip(detail, 200), ms: Date.now() - started, code: r?.code, size: r?.out?.length });
  const run = async (cmd, args, o) => {
    const started = Date.now();
    const r = await exec(cmd, args, o);
    note(`${cmd} ${args.join(" ")}`, started, r);
    return r;
  };
  const have = {};
  const has = async (cmd) => (have[cmd] ??= !(await exec(cmd, ["--version"], { timeoutMs: 5000 })).missing);

  // ---- the crash table ---------------------------------------------------------------------------

  async function sinceMs(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v;
    const s = safeArg(v, "a time");
    const iso = Date.parse(s);
    if (!Number.isNaN(iso) && /^\d{4}-\d\d-\d\d/.test(s)) return iso;
    const r = await exec("date", ["-d", s.replace(/^-(\d+)\s*(\w+)$/, "$1 $2 ago"), "+%s"], { timeoutMs: 5000 });
    if (r.code !== 0) throw new Error(`cannot read the time "${s}": use "2026-11-18", "3 days ago", "yesterday"`);
    return +r.out.trim() * 1000;
  }

  let table = null;
  /** Every stored crash, oldest first: pid, time (ms), signal, exe, unit, core state, and the stack text. */
  async function all() {
    if (table) return table;
    const started = Date.now();
    const [l, j] = await Promise.all([
      exec("coredumpctl", ["list", "--no-pager", "--json=short", "-q"], { timeoutMs: 60_000 }),
      exec("journalctl", ["MESSAGE_ID=" + COREDUMP_ID, "-o", "json", "--no-pager", "-q",
        "--output-fields=COREDUMP_PID,COREDUMP_TID,COREDUMP_UNIT,COREDUMP_USER_UNIT,COREDUMP_SIGNAL,COREDUMP_SIGNAL_NAME,COREDUMP_EXE,COREDUMP_COMM,COREDUMP_CMDLINE,COREDUMP_TIMESTAMP,COREDUMP_FILENAME,MESSAGE"], { timeoutMs: 60_000 }),
    ]);
    push({ kind: "crash", detail: "coredumpctl list + journalctl (coredump messages)", ms: Date.now() - started, code: l.code });
    if (l.missing) throw new Error("coredumpctl is not installed: this machine has no systemd-coredump to read");
    let rows = [];
    try {
      rows = l.out.trim() ? JSON.parse(l.out) : [];
    } catch {
      rows = [];
    }
    const jr = new Map();
    for (const line of j.out.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        jr.set(`${o.COREDUMP_PID}@${Math.round(+o.__REALTIME_TIMESTAMP / 1000)}`, o);
      } catch {}
    }
    const byPid = new Map();
    for (const o of jr.values()) (byPid.get(String(o.COREDUMP_PID)) ?? byPid.set(String(o.COREDUMP_PID), []).get(String(o.COREDUMP_PID))).push(o);
    table = rows.map((r) => {
      const rec = Math.round(r.time / 1000);
      const o = jr.get(`${r.pid}@${rec}`) ?? (byPid.get(String(r.pid)) ?? []).sort((a, b) => Math.abs(+a.__REALTIME_TIMESTAMP / 1000 - rec) - Math.abs(+b.__REALTIME_TIMESTAMP / 1000 - rec))[0];
      const sig = r.sig ?? (o ? +o.COREDUMP_SIGNAL : null);
      const when = o?.COREDUMP_TIMESTAMP ? Math.round(+o.COREDUMP_TIMESTAMP / 1000) : rec;
      return {
        pid: r.pid, when, recorded: rec, uid: r.uid, signo: sig, signal: SIGNALS[sig]?.[0] ?? o?.COREDUMP_SIGNAL_NAME ?? `signal ${sig}`,
        exe: r.exe ?? o?.COREDUMP_EXE ?? null, comm: o?.COREDUMP_COMM ?? null, core: r.corefile, size: r.size,
        unit: o?.COREDUMP_USER_UNIT || o?.COREDUMP_UNIT || null, tid: o?.COREDUMP_TID ? +o.COREDUMP_TID : null,
        cmdline: o?.COREDUMP_CMDLINE ? mask(o.COREDUMP_CMDLINE) : null, file: o?.COREDUMP_FILENAME ?? null, message: typeof o?.MESSAGE === "string" ? o.MESSAGE : null,
      };
    }).sort((a, b) => a.when - b.when);
    return table;
  }

  /** Crashes in a window, oldest first. o: since, until, exe (path or program name), signal (name or number), unit. */
  async function list(o = {}) {
    const [s, u] = [await sinceMs(o.since), await sinceMs(o.until)];
    const base = (p) => String(p ?? "").split("/").pop();
    return (await all()).filter((c) =>
      (s == null || c.when >= s) && (u == null || c.when <= u) &&
      (!o.exe || c.exe === o.exe || base(c.exe) === base(o.exe) || c.comm === o.exe) &&
      (!o.signal || c.signal === String(o.signal).toUpperCase() || String(c.signo) === String(o.signal)) &&
      (!o.unit || (c.unit ?? "").includes(o.unit)));
  }

  /** Pick one crash: a pid, "last" or "" (the newest), or a program name or path (its newest). */
  async function pick(sel, o = {}) {
    const rows = await all();
    if (!rows.length) throw new Error("no crashes are stored on this machine");
    let r;
    if (sel == null || sel === "" || sel === "last" || sel === "latest") r = (o.exe ? await list({ exe: o.exe }) : rows).at(-1);
    else if (typeof sel === "number" || /^\d+$/.test(String(sel))) r = rows.filter((c) => c.pid === +sel).at(-1);
    else r = (await list({ exe: String(sel) })).at(-1);
    if (!r) throw new Error(`no stored crash matches ${JSON.stringify(sel)}; \`crash.list()\` shows what exists`);
    return r;
  }

  const stackOf = async (c) => {
    const threads = parseStacks(c.message);
    const names = threads.flatMap((t) => t.frames.map((f) => f.symbol));
    const dm = await demangle(names);
    for (const t of threads) for (const f of t.frames) if (dm[f.symbol]) f.symbol = dm[f.symbol].replace(/\(.*$/, "");
    return threads;
  };

  // ---- packages ----------------------------------------------------------------------------------

  let ldcache = null;
  const libPath = async (name) => {
    if (!ldcache) {
      ldcache = {};
      const r = await run("ldconfig", ["-p"]);
      for (const l of r.out.split("\n")) {
        const m = l.match(/^\s+(\S+) \(.*\) => (\S+)/);
        if (m && !ldcache[m[1]]) ldcache[m[1]] = m[2];
      }
    }
    return ldcache[name] ?? null;
  };
  let foreign = null;
  /** Owner of each file: {path: {pkg, version, foreign}}. A file no package owns maps to null. */
  async function owners(paths) {
    const out = {};
    const uniq = [...new Set(paths.filter(Boolean).map((p) => path.resolve(p)))];
    if (!uniq.length) return out;
    if (!(await has("pacman"))) return Object.fromEntries(uniq.map((p) => [p, null]));
    if (!foreign) foreign = new Set((await run("pacman", ["-Qmq"])).out.split("\n").filter(Boolean));
    for (const p of uniq) out[p] = null;
    const r = await run("pacman", ["-Qo", ...uniq]);
    for (const l of (r.out + "\n" + r.err).split("\n")) {
      const m = l.match(/^(\S+) is owned by (\S+) (\S+)$/);
      if (m) out[m[1]] = { pkg: m[2], version: m[3], foreign: foreign.has(m[2]) };
    }
    return out;
  }

  let plog = null;
  /** pacman.log as events, oldest first: {t, action, pkg, from, to}. */
  async function pacmanLog() {
    if (plog) return plog;
    plog = [];
    let text = "";
    try {
      text = fs.readFileSync("/var/log/pacman.log", "utf8");
    } catch {
      return plog;
    }
    for (const l of text.split("\n")) {
      const m = l.match(/^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)([+-]\d\d)(\d\d)\] \[ALPM\] (upgraded|installed|removed|downgraded|reinstalled) (\S+) \((.*)\)$/);
      if (!m) continue;
      const [from, to] = m[6].includes(" -> ") ? m[6].split(" -> ") : [null, m[6]];
      plog.push({ t: Date.parse(`${m[1]}${m[2]}:${m[3]}`), action: m[4], pkg: m[5], from, to });
    }
    return plog;
  }
  /** The version a package had at a time, from pacman.log (null when the log does not say). */
  async function versionAt(pkg, ms) {
    let v = null;
    for (const e of await pacmanLog()) {
      if (e.pkg !== pkg || e.t > ms) continue;
      v = e.action === "removed" ? null : e.to;
    }
    return v;
  }
  /** Package changes between two times: {when, action, pkg, from, to}. */
  async function upgrades(fromMs, toMs) {
    return (await pacmanLog()).filter((e) => e.t >= fromMs && e.t <= toMs).map((e) => ({ when: fmt(e.t), action: e.action, pkg: e.pkg, from: e.from, to: e.to }));
  }

  // ---- the journal around a crash ----------------------------------------------------------------

  async function around(c, { beforeSec = 60, afterSec = 3, max = 12 } = {}) {
    const s = Math.floor(c.when / 1000) - beforeSec;
    const u = Math.floor(c.when / 1000) + afterSec;
    const r = await run("journalctl", ["--no-pager", "-q", "-o", "json", `--since=@${s}`, `--until=@${u}`,
      "--output-fields=PRIORITY,_PID,_COMM,SYSLOG_IDENTIFIER,MESSAGE,_SYSTEMD_UNIT,_SYSTEMD_USER_UNIT"], { timeoutMs: 60_000 });
    const comm = (c.comm ?? path.basename(c.exe ?? "")).slice(0, 15);
    const lines = [];
    for (const line of r.out.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof o.MESSAGE !== "string" || /^systemd-coredump|^\(sd-coredump\)/.test(o.SYSLOG_IDENTIFIER ?? "") || o._COMM === "systemd-coredum" || /dumped core\.\s*$/m.test(o.MESSAGE.split("\n")[0]) || /UFW (BLOCK|ALLOW)/.test(o.MESSAGE)) continue;
      const mine = +o._PID === c.pid || o._COMM === comm || o.SYSLOG_IDENTIFIER === comm || o.SYSLOG_IDENTIFIER === path.basename(c.exe ?? "") || o.MESSAGE.includes(path.basename(c.exe ?? "\0"));
      if (+o.PRIORITY <= 3 || mine) lines.push({ t: Math.round(+o.__REALTIME_TIMESTAMP / 1000), who: o.SYSLOG_IDENTIFIER ?? o._COMM, pri: +o.PRIORITY, mine, text: o.MESSAGE.split("\n")[0] });
    }
    const kept = lines.slice(-max);
    return {
      lines: kept.map((x) => `${fmt(x.t).slice(11, 19)} ${x.who}${x.pri <= 3 ? " [err]" : x.pri === 4 ? " [warn]" : ""}: ${clip(mask(x.text), 150)}`),
      cut: Math.max(0, lines.length - kept.length),
    };
  }

  /** Kernel lines near the crash that bear on its cause: traps/segfault records (with the module and ip), GPU resets, out-of-memory kills. */
  async function kernelNear(c) {
    const s = Math.floor(c.when / 1000);
    const r = await run("journalctl", ["-k", "--no-pager", "-q", "-o", "short-iso", `--since=@${s - 300}`, `--until=@${s + 10}`, "-g", "traps:|segfault|general protection|amdgpu|nvidia|nouveau|i915|\\bxe\\b|Xid|GPU HANG|gpu reset|oom-kill|out of memory|killed process|memory cgroup"], { timeoutMs: 30_000 });
    const lines = r.out.split("\n").filter((l) => l.trim() && !/^-- /.test(l));
    const about = lines.filter((l) => !/\[\d+\]/.test(l) || l.includes(`[${c.pid}]`));
    return { lines: about.slice(-12).map((l) => clip(mask(l), 240)), cut: Math.max(0, about.length - 12) };
  }

  // ---- one crash, analysed ----------------------------------------------------------------------

  const baseOf = (p) => String(p ?? "").split("/").pop();
  const frameView = (f) => ({ n: f.n, symbol: f.symbol === "n/a" ? null : f.symbol, module: f.module, offset: f.off });

  /** Where in the stack the fault is and what that module is: the program, a library, the GPU stack, the compositor or libc. */
  async function analyse(sel, o = {}) {
    const c = await pick(sel, o);
    const threads = await stackOf(c);
    const t0 = threads[0] ?? null;
    const frames = t0?.frames ?? [];
    const ff = faultingFrame(frames, c.signo, o.signalHandlerAt);
    const fault = ff.index != null ? frames[ff.index] : null;
    const exeBase = baseOf(c.exe);
    const modPaths = {};
    for (const f of frames.slice(0, 40)) if (f.module && !modPaths[f.module]) modPaths[f.module] = f.module === exeBase || f.module === c.comm ? c.exe : await libPath(f.module);
    const own = await owners([c.exe, ...Object.values(modPaths)]);
    const pkgOfModule = (m) => (modPaths[m] ? own[path.resolve(modPaths[m])] ?? null : null);
    const exePkg = c.exe ? own[path.resolve(c.exe)] ?? null : null;
    let faultMod = fault?.module ?? null;
    const faultPkg = faultMod ? pkgOfModule(faultMod) : null;
    // a library frame above (nearer the fault than) the first frame in the program: the caller
    const firstProgram = frames.find((f) => f.module === exeBase);
    let kind = "unknown";
    let why = "the stack is not stored (the journal entry holds no frames), so the fault cannot be placed";
    if (fault) {
      if (GPU.test(faultMod ?? "")) [kind, why] = ["gpu-driver", `the faulting frame is in ${faultMod}, part of the graphics stack (driver or GL/Vulkan library)`];
      else if (COMPOSITOR.test(faultMod ?? "") || COMPOSITOR.test(c.exe ?? "")) [kind, why] = ["compositor", `the faulting frame is in ${faultMod}, a compositor or Wayland protocol library`];
      else if (faultMod === exeBase) [kind, why] = ["program", `the faulting frame is in the program's own code (${exeBase})`];
      else if (isLibc(fault) && !ff.abortCaller) [kind, why] = ["libc", `the faulting frame is inside libc (${fault.symbol === "n/a" ? "an unnamed function" : fault.symbol}), called with bad arguments by the next frame down`];
      else [kind, why] = ["library", `the faulting frame is in ${faultMod}${faultPkg ? ` (package ${faultPkg.pkg} ${faultPkg.version})` : ""}, not in ${exeBase}`];
      if (ff.abortCaller) why = `${faultMod}${fault.symbol !== "n/a" ? ` (${fault.symbol})` : ""} called abort()${ff.abortVia?.length ? ` through ${ff.abortVia.join(", ")}` : ""}: a fatal condition it detected itself (assertion, uncaught exception or failed check); the cause is the message logged just before it, and ${kind === "program" ? "the program's own code" : kind === "library" || kind === "gpu-driver" || kind === "compositor" ? `the library ${faultMod}` : "libc"} is where it gave up.`;
      if (ff.handlerReraise) why += `; ${exeBase} has its own crash handler (${ff.handlerFrame ? `${ff.handlerFrame.module} + ${ff.handlerFrame.off}` : "its code"}) that re-raised the signal, so the frames above it are the handler, not the cause`;
    }
    const gpuInStack = frames.slice(0, 30).filter((f) => GPU.test(f.module ?? "")).map((f) => f.module);
    const compInStack = frames.slice(0, 30).filter((f) => COMPOSITOR.test(f.module ?? "")).map((f) => f.module);
    const omarchyEv = [];
    for (const p of new Set([exePkg?.pkg, faultPkg?.pkg, ...Object.values(modPaths).map((m) => (m ? own[path.resolve(m)]?.pkg : null))])) if (p && /^omarchy/.test(p)) omarchyEv.push(`package ${p} is in the stack or owns the program`);
    if (/\/omarchy\b|\.config\/omarchy|omarchy-/.test(c.cmdline ?? "")) omarchyEv.push("the command line runs a file Omarchy ships");
    if (/\/omarchy\b|omarchy-/.test(c.exe ?? "")) omarchyEv.push("the executable is an Omarchy program");
    return { c, threads, frames, faultIndex: ff.index, ff, fault, kind, why, exePkg, faultPkg, modPaths, own, pkgOfModule, firstProgram, gpuInStack, compInStack, omarchyEv };
  }

  const sigLine = (c) => `${c.signal}${c.signo ? ` (${c.signo})` : ""}`;
  const signature = (frames, from, n = 5) => frames.slice(from ?? 0, (from ?? 0) + n).map((f) => (f.symbol !== "n/a" ? f.symbol : `${f.module}`)).join(" < ");

  /** Earlier crashes of the same program, and those with the same top frames. */
  async function history(a) {
    const same = [];
    const similar = [];
    const mine = signature(a.frames, a.faultIndex, 5);
    const mine2 = signature(a.frames, a.faultIndex, 1);
    const sameExe = (await all()).filter((x) => x.exe === a.c.exe);
    for (const x of sameExe) {
      if (x.pid === a.c.pid && x.when === a.c.when) continue;
      const th = (await stackOf(x))[0];
      if (!th) continue;
      const fi = faultingFrame(th.frames, x.signo).index;
      if (signature(th.frames, fi, 5) === mine) same.push(x);
      else if (signature(th.frames, fi, 1) === mine2 && mine2) similar.push(x);
    }
    return { sameExe: sameExe.length, same, similar, signature: mine };
  }

  const crashRow = (c) => ({ pid: c.pid, when: fmt(c.when), signal: c.signal, core: c.core, size: c.size });

  // ---- gdb in batch mode on a stored core ---------------------------------------------------------

  const GDB_DENY = /(^|\s)(shell|!|python|py|python-interactive|pi|source|pipe|\|\||define|document|guile|gu|attach|run|start|starti|continue|c|next|step|call|set\s+var|set\s+\{|set\s+logging|dump|restore|generate-core-file|gcore|file|exec-file|symbol-file|target|x\/\d*s|x\/s|find|output|printf|echo|print|p|inspect|info\s+(proc|files|auxv|os)|monitor|tty|handle|signal|kill|jump|return|compile|directory|cd|add-auto-load)\b/i;

  async function withCore(c, fn, o = {}) {
    if (!(await has("gdb"))) throw new Error("gdb is not installed");
    if (c.core !== "present") throw new Error(`the core of pid ${c.pid} is ${c.core}: gdb cannot read it (the journal still holds the stack that coredumpctl info prints)`);
    const base = o.tmp ?? process.env.CRASH_TMPDIR ?? os.tmpdir();
    let free = Infinity;
    try {
      const st = fs.statfsSync(base);
      free = st.bavail * st.bsize;
    } catch {}
    if (free < (c.size ?? 0) * 25) throw new Error(`not enough free space in ${base} to unpack the core (${Math.round((c.size ?? 0) * 25 / 1e6)} MB estimated); set CRASH_TMPDIR to a bigger folder`);
    const dir = fs.mkdtempSync(path.join(base, "crash-"));
    fs.chmodSync(dir, 0o700);
    const core = path.join(dir, "core");
    try {
      const d = await run("coredumpctl", ["dump", String(c.pid), `--output=${core}`, "-q"], { timeoutMs: 180_000, maxBuffer: 1 << 20 });
      if (d.code !== 0 || !fs.existsSync(core)) throw new Error(`coredumpctl dump failed: ${clip(mask(d.err), 300)} (reading a core usually needs the same user or root; \`coredumpctl info\` still works)`);
      return await fn(core);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function gdbOn(c, core, cmds, { symbols = false, timeoutMs = 120_000 } = {}) {
    const urls = process.env.DEBUGINFOD_URLS || "https://debuginfod.archlinux.org";
    const args = ["-nx", "-q", "-batch", "-iex", "set auto-load no", "-iex", "set pagination off", "-iex", "set confirm off", "-iex", "set style enabled off",
      "-iex", "set print frame-arguments none", "-iex", "set print frame-info location-and-address", "-iex", `set debuginfod enabled ${symbols ? "on" : "off"}`, "-iex", "set debuginfod verbose 0",
      ...cmds.flatMap((x) => ["-ex", x]), c.exe, core];
    const r = await run("gdb", args, { timeoutMs, env: { DEBUGINFOD_URLS: symbols ? urls : "", HOME: process.env.HOME } });
    return { ...r, out: r.out, err: r.err };
  }

  function parseGdbFrames(text, exeBase) {
    let frames = [];
    let handlerAt = null;
    for (const l of text.split("\n")) {
      if (/^#0\s/.test(l)) frames = [];
      const h = l.match(/^#(\d+)\s+<signal handler called>/);
      if (h) {
        handlerAt = +h[1];
        frames.push({ n: +h[1], symbol: "<signal handler called>", module: null, off: null, handler: true });
        continue;
      }
      const m = l.match(/^#(\d+)\s+(?:(0x[0-9a-f]+) in )?(.+?)(?: \((?:\.\.\.)?\))?(?: from (\S+)| at (\S+))?$/);
      if (!m) continue;
      let sym = m[3];
      frames.push({ n: +m[1], addr: m[2] ?? null, symbol: sym === "??" ? "n/a" : clip(sym.replace(/ \(\)$/, "").replace(/ \((?:\w+=\.\.\.(?:, )?)+\)$/, ""), 160), module: m[4] ? path.basename(path.resolve(m[4])) : null, path: m[4] ? path.resolve(m[4]) : null, source: m[5] ?? null });
    }
    return { frames, handlerAt };
  }

  /**
   * The crashing thread's stack through gdb (cap `max` frames), a summary of every thread, and for the faulting frame
   * the instruction, a few registers and the fault address. Only a fixed set of gdb commands runs.
   */
  async function backtrace(sel, o = {}) {
    const c = await pick(sel, o);
    const max = Math.min(o.max ?? 25, 200);
    const symbols = !!o.symbols;
    const notes = [];
    if (!(await has("gdb"))) {
      const info = (await stackOf(c))[0];
      return { crash: crashRow(c), source: "journal (coredumpctl info)", note: "gdb is not installed; frames are the stack systemd-coredump recorded", frames: (info?.frames ?? []).slice(0, max).map(frameView) };
    }
    try {
      return await withCore(c, async (core) => {
        const first = await gdbOn(c, core, [`bt ${max}`, "info threads", "info sharedlibrary", "p $_siginfo.si_code", "p $_siginfo._sifields._sigfault.si_addr"], { symbols, timeoutMs: symbols ? 300_000 : 120_000 });
        const { frames, handlerAt } = parseGdbFrames(first.out);
        const ranges = [];
        for (const l of first.out.split("\n")) {
          const m = l.match(/^(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(?:Yes|No)(?: \(\*\))?\s+(\/\S+)/);
          if (m) ranges.push([BigInt(m[1]), BigInt(m[2]), path.resolve(m[3])]);
        }
        for (const f of frames) {
          if (f.handler || f.path || !f.addr) continue;
          const hit = ranges.find(([lo, hi]) => BigInt(f.addr) >= lo && BigInt(f.addr) < hi);
          if (hit) [f.path, f.module] = [hit[2], path.basename(hit[2])];
          else f.module = path.basename(c.exe ?? "");
        }
        const ff = faultingFrame(frames.filter((f) => !f.handler), c.signo, handlerAt);
        const fidx = handlerAt != null ? handlerAt + 1 : ff.index;
        const threadsLine = (first.out.match(/^\*?\s+\d+\s+Thread .*$/gm) ?? []);
        const code = first.out.match(/\$\d+ = (-?\d+)\n/);
        const addr = first.out.match(/\$\d+ = \(void \*\) (0x[0-9a-f]+)/);
        const more = await gdbOn(c, core, ["thread apply all bt 4"], { symbols, timeoutMs: symbols ? 300_000 : 120_000 });
        const th = [];
        let cur = null;
        for (const l of more.out.split("\n")) {
          const t = l.match(/^Thread (\d+) \((.*)\):/);
          if (t) th.push((cur = { thread: +t[1], id: clip(t[2], 80), top: [] }));
          else if (cur && /^#\d+/.test(l)) {
            const fr = parseGdbFrames(l).frames[0];
            if (fr) cur.top.push(`${fr.symbol === "n/a" ? "(no symbol)" : clip(fr.symbol, 90)}${fr.module ? ` (${fr.module})` : ""}`);
          }
        }
        let regs = null;
        if (o.registers !== false && fidx != null) {
          const r2 = await gdbOn(c, core, [`frame ${fidx}`, "info registers rip rsp eflags", "x/2i $pc"], { symbols });
          regs = r2.out.split("\n").filter((l) => /^(rip|rsp|eflags)\s|^=>|^\s+0x[0-9a-f]+:/.test(l)).map((l) => l.replace(/\s+/g, " ").trim()).slice(0, 6);
        }
        const unresolved = frames.filter((f) => !f.handler && f.symbol === "n/a").length;
        const warnings = [...new Set(first.out.split("\n").filter((l) => /build-id|differs|is newer|no such file|Failed to read|not match/i.test(l)))].slice(0, 5).map((l) => clip(mask(l), 200));
        if (warnings.length) notes.push("gdb warned the program or a library on disk differs from the one that crashed; symbols may be wrong");
        if (unresolved && !symbols) notes.push(`${unresolved} of ${frames.length} frames have no name: stripped binaries. Run again with symbols: true to look up debug info on the Arch debuginfod server (sends build ids, saves to the debuginfod cache), or install the matching <package>-debug package (not done here)`);
        if (unresolved && symbols) notes.push(`${unresolved} frames stay unresolved even with debuginfod: the server has no debug info for them`);
        if (first.timedOut) notes.push("gdb hit its timeout; the result may be partial");
        const mapp = frames.filter((f) => f.path);
        const own = await owners(mapp.map((f) => f.path));
        for (const f of frames) if (f.path) f.package = own[f.path] ? `${own[f.path].pkg} ${own[f.path].version}` : null;
        return {
          crash: crashRow(c), source: `gdb batch on the stored core${symbols ? " with debuginfod" : ""}`,
          signal: sigLine(c), siCode: code ? +code[1] : null,
          faultAddress: code && +code[1] > 0 && addr ? addr[1] : null, faultAddressNote: code && +code[1] <= 0 ? "the signal was sent by raise/tkill/kill (si_code <= 0): it carries no fault address; the program's crash handler re-raised it, or it was sent from outside" : null,
          faultingFrameIndex: fidx, signalHandlerAt: handlerAt,
          frames: frames.map((f) => `#${f.n} ${f.handler ? "<signal handler called>" : f.symbol === "n/a" ? "(no symbol)" : clip(f.symbol, 110)}${f.handler ? "" : ` [${f.module ?? "?"}${f.package ? ", " + f.package : ""}]`}${f.source ? " at " + f.source : ""}`),
          framesUnresolved: unresolved, registers: regs, threadCount: threadsLine.length || th.length,
          threads: th.slice(0, 12), threadsCut: Math.max(0, th.length - 12), notes, warnings,
        };
      });
    } catch (e) {
      const info = (await stackOf(c))[0];
      return { crash: crashRow(c), source: "journal (coredumpctl info)", gdbFailed: clip(String(e.message), 400), frames: (info?.frames ?? []).slice(0, max).map(frameView) };
    }
  }

  const api = {
    cwd,
    act,
    mask,
    fmt,
    all,
    list,
    pick,
    analyse,
    history,
    around,
    kernelNear,
    owners,
    versionAt,
    upgrades,
    pacmanLog,
    backtrace,
    signature,
    sigLine,
    crashRow,
    stackOf,
    frameView,
    has,
    signalInfo: (n) => SIGNALS[n] ?? null,

    /** An installed package's own words: version, upstream URL, packager, install date. Null when pacman does not know it. */
    async pkgInfo(name) {
      if (!(await has("pacman"))) return null;
      const r = await run("pacman", ["-Qi", safeArg(name, "a package name")]);
      if (r.code !== 0) return null;
      const f = (k) => r.out.match(new RegExp(`^${k}\\s*:\\s*(.*)$`, "m"))?.[1]?.trim() ?? null;
      if (!foreign) foreign = new Set((await run("pacman", ["-Qmq"])).out.split("\n").filter(Boolean));
      return { name: f("Name"), version: f("Version"), url: f("URL"), packager: f("Packager"), installed: f("Install Date"), foreign: foreign.has(name) };
    },

    /** One-line system facts for a report: kernel, Omarchy version, installed packages' versions. */
    async system(pkgs = []) {
      const out = { kernel: os.release(), arch: os.arch() };
      const om = await exec("omarchy", ["version"], { timeoutMs: 8000 });
      out.omarchy = om.code === 0 ? om.out.trim().split("\n")[0] : null;
      if (pkgs.length && (await has("pacman"))) {
        const r = await run("pacman", ["-Q", ...pkgs]);
        out.packages = Object.fromEntries(r.out.split("\n").filter(Boolean).map((l) => l.split(" ")));
      }
      return out;
    },

    /** Run gdb commands of your own on a stored core. Needs act: it unpacks the core and can print memory. */
    async gdb(sel, commands) {
      if (!act) notInThisAsk("crash.gdb (arbitrary gdb commands on a core)");
      const cmds = [].concat(commands).map(String);
      for (const x of cmds) if (GDB_DENY.test(x) || /[\n;]/.test(x)) throw new Error(`gdb command refused: ${clip(x, 80)} (shell, python, source, running, writing and printing memory are not allowed)`);
      const c = await pick(sel);
      return withCore(c, async (core) => {
        const r = await gdbOn(c, core, cmds);
        return clip(mask(r.out), 12000);
      });
    },

    /** Write text to a new file (a bug report). Needs act; refuses an existing file. */
    writeFile(file, text) {
      if (!act) notInThisAsk("crash.writeFile");
      const p = path.resolve(cwd, String(file).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      if (fs.existsSync(p)) throw new Error(`${p} exists; choose another name`);
      fs.writeFileSync(p, text, { mode: 0o600, flag: "wx" });
      return p;
    },
  };
  return api;
}
