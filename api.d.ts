// A crash is one stored systemd-coredump record. Times are in the machine's own zone with the UTC offset (for example +01:00).
interface Frame { n: number; addr: string; symbol: string; module: string; off: string | null } // symbol is "n/a" when the library has no symbol for it
interface CrashRow { pid: number; when: number; recorded: number; uid: number; signo: number; signal: string; exe: string | null; comm: string | null; core: "present" | "truncated" | "inaccessible" | "missing" | string; size: number | null; unit: string | null; tid: number | null; cmdline: string | null; file: string | null; message: string | null }
interface Owner { pkg: string; version: string; foreign: boolean } // foreign: not in the official repositories (AUR or a local build)

declare const crash: {
  act: boolean; // true when this ask may change things

  // Every stored crash, oldest first. `when` is the crash time in ms (Date); `recorded` is when systemd-coredump finished writing it.
  // cmdline has secrets masked. message holds the stack text the journal recorded.
  all(): Promise<CrashRow[]>;
  // Crashes in a window. since/until: "2026-11-18", "3 days ago", "yesterday". exe: program name or path. signal: "SIGSEGV" or 11. unit: part of a unit name.
  list(o?: { since?: string; until?: string; exe?: string; signal?: string | number; unit?: string }): Promise<CrashRow[]>;
  // One crash: a pid, "last" or "" (newest), or a program name or path (its newest). Throws when none matches.
  pick(sel?: string | number, o?: { exe?: string }): Promise<CrashRow>;

  // One crash analysed from the stack the journal recorded: no core and no gdb needed.
  // threads[0] is the crashing thread. faultIndex is the frame that really faulted (raise/abort and a program's own crash handler skipped).
  // kind: "program" | "library" | "libc" | "gpu-driver" | "compositor" | "unknown"; why is the evidence in a sentence.
  // pkgOfModule("libQt6Qml.so.6") gives the package that owns it. omarchyEv lists Omarchy packages or files involved.
  analyse(sel?: string | number, o?: { exe?: string }): Promise<{ c: CrashRow; threads: { tid: number; frames: Frame[] }[]; frames: Frame[]; faultIndex: number | null;
    ff: { index: number | null; via: string; handlerReraise?: boolean; abortCaller?: boolean }; fault: Frame | null; kind: string; why: string; exePkg: Owner | null; faultPkg: Owner | null;
    pkgOfModule(module: string): Owner | null; gpuInStack: string[]; compInStack: string[]; omarchyEv: string[] }>;
  // Earlier crashes of the same program: same = same top 5 frames (unnamed frames matched by library), similar = same faulting module only.
  history(a: Awaited<ReturnType<typeof crash.analyse>>): Promise<{ sameExe: number; same: CrashRow[]; similar: CrashRow[]; signature: string }>;
  signature(frames: Frame[], from?: number, n?: number): string;

  // Journal lines around a crash (errors, and anything from the crashed program or its pid), UFW and the coredump's own lines left out. {lines:["12:44:07 glass-clock: ..."], cut}
  around(c: CrashRow, o?: { beforeSec?: number; afterSec?: number; max?: number }): Promise<{ lines: string[]; cut: number }>;
  // Kernel lines in the 5 minutes before: traps/segfault records, GPU resets, out-of-memory kills.
  kernelNear(c: CrashRow): Promise<{ lines: string[]; cut: number }>;

  // Package owner of each file (pacman -Qo): {"/usr/lib/libQt6Qml.so.6": {pkg, version, foreign} | null}.
  owners(paths: string[]): Promise<Record<string, Owner | null>>;
  // A package's version at a time, from /var/log/pacman.log (null when the log does not say).
  versionAt(pkg: string, ms: number): Promise<string | null>;
  // Package changes between two times (ms): [{when, action, pkg, from, to}].
  upgrades(fromMs: number, toMs: number): Promise<{ when: string; action: string; pkg: string; from: string | null; to: string | null }[]>;
  pacmanLog(): Promise<{ t: number; action: string; pkg: string; from: string | null; to: string | null }[]>;
  pkgInfo(name: string): Promise<{ name: string; version: string; url: string | null; packager: string | null; installed: string | null; foreign: boolean } | null>;
  system(pkgs?: string[]): Promise<{ kernel: string; arch: string; omarchy: string | null; packages?: Record<string, string> }>;

  // The crashing thread's stack through gdb in batch mode on the stored core (unpacked to a private temp folder, deleted after).
  // Fixed commands only: bt, info threads, thread apply all bt, three registers, two instructions, the fault address. No memory is returned.
  // symbols: true asks the Arch debuginfod server for debug info (network; saves to the debuginfod cache). Falls back to the journal's stack when gdb or the core is unavailable.
  backtrace(sel?: string | number, o?: { max?: number; symbols?: boolean; registers?: boolean }): Promise<any>;

  // Needs act. gdb commands of your own on a stored core; shell, python, source, running and printing memory are refused. Output is masked and cut at 12000 characters.
  gdb(sel: string | number, commands: string | string[]): Promise<string>;
  // Needs act. Writes text to a new file and returns its path; an existing file is refused.
  writeFile(file: string, text: string): string;

  mask(s: string): string;   // removes tokens, passwords and URL credentials from text
  fmt(ms: number): string;   // "2026-11-08 12:44:12 +01:00"
  signalInfo(signo: number): [string, string] | null;
  sigLine(c: CrashRow): string;
  crashRow(c: CrashRow): { pid: number; when: string; signal: string; core: string; size: number | null };
  has(program: string): Promise<boolean>; // is gdb, pacman ... installed
};
