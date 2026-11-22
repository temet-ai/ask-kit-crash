export const meta = {
  purpose:
    "Why one crash happened, in one call: signal and what it means, the command line (secrets masked), the crashing thread's top frames, the frame that really faulted (past raise/abort and past a program's own crash handler), the shared library or module there with the package that owns it and its version, a one-line classification of where the fault lies (program, library, libc, GPU driver, compositor) with its evidence, kernel lines and out-of-memory kills near the time, what the journal said just before, and how many earlier crashes have the same stack. It reads the stack systemd-coredump recorded, so it needs no core and no gdb.",
  params: {
    crash: "a pid, 'last' (default), or a program name or path (its newest crash)",
    exe: "with crash 'last': the newest crash of this program",
    frames: "how many frames of the stack to show from the faulting frame, default 10",
  },
  returns: "{crash:{pid, when, signal, meaning, exe, unit, cmdline, core, size}, fault:{frame, module, package, version, packageSource}, where:{kind, evidence}, program:{package, version}, stack:{faultingFrameIndex, via, total, unresolved, frames:['#4 function or (no symbol) +offset [module, package]']}, omarchy:{evidence}, kernel, oom, journalBefore, earlier:{sameProgram, sameStack, firstSameStack}, notes}",
  example: 'await scripts.run("why", { crash: "last" })',
};

export default async function ({ crash }, { crash: sel = "last", exe, frames = 10 } = {}) {
  const a = await crash.analyse(sel, { exe });
  const c = a.c;
  const nowPkg = a.faultPkg;
  const [j, k, hist, atCrash] = await Promise.all([crash.around(c), crash.kernelNear(c), crash.history(a), nowPkg ? crash.versionAt(nowPkg.pkg, c.when) : null]);
  const oom = k.lines.filter((l) => /oom|out of memory|killed process|memory cgroup/i.test(l));
  const unresolved = a.frames.filter((f) => f.symbol === "n/a").length;
  const notes = [];
  if (!a.frames.length) notes.push("the journal entry holds no stack (usual for a core owned by another user, or a crash before systemd-coredump could read the process)");
  if (unresolved) notes.push(`${unresolved} of ${a.frames.length} frames have no function name (stripped libraries or the program itself); \`backtrace\` with symbols: true asks debuginfod, and a matching <package>-debug package would also do (neither is installed or done here)`);
  if (nowPkg && atCrash && atCrash !== nowPkg.version) notes.push(`${nowPkg.pkg} was ${atCrash} when this crash happened and is ${nowPkg.version} now (pacman.log)`);
  if (a.exePkg?.foreign) notes.push(`${a.exePkg.pkg} is not from the official repositories (AUR or a local build): report to its own maintainer or upstream, not to Arch`);
  if (!a.frames.length && j.lines.some((l) => /: #\d+\s+0x[0-9a-f]+ in /.test(l))) notes.push("the program printed its own backtrace into the journal (lines starting #N 0x...): read journalBefore, or `crash.around(c, { beforeSec: 10, max: 60 })` for all of it");
  if (c.core !== "present") notes.push(`the core is ${c.core}: gdb cannot be used; everything here comes from the journal`);
  if (a.gpuInStack.length && a.kind !== "gpu-driver") notes.push(`graphics-stack modules appear lower in the stack (${[...new Set(a.gpuInStack)].slice(0, 3).join(", ")}): the crash may be reached through the GPU path`);
  if (a.compInStack.length && a.kind !== "compositor") notes.push(`compositor or Wayland modules appear in the stack (${[...new Set(a.compInStack)].slice(0, 3).join(", ")})`);
  const sig = crash.signalInfo(c.signo);
  return {
    crash: { pid: c.pid, when: crash.fmt(c.when), signal: crash.sigLine(c), meaning: sig?.[1] ?? null, exe: c.exe, unit: c.unit, cmdline: c.cmdline ? c.cmdline.slice(0, 160) : null, core: c.core, size: c.size },
    fault: a.fault ? { frame: a.faultIndex, symbol: a.fault.symbol === "n/a" ? null : a.fault.symbol, module: a.fault.module, offset: a.fault.off, package: nowPkg?.pkg ?? null, version: nowPkg?.version ?? null, versionAtCrash: atCrash, packageSource: nowPkg ? (nowPkg.foreign ? "foreign (AUR or local build)" : "official repositories") : null } : null,
    where: { kind: a.kind, evidence: a.why },
    program: a.exePkg ? { package: a.exePkg.pkg, version: a.exePkg.version, source: a.exePkg.foreign ? "foreign (AUR or local build)" : "official repositories" } : null,
    stack: {
      faultingFrameIndex: a.faultIndex, via: a.ff.via, total: a.frames.length, unresolved,
      frames: a.frames.slice(a.faultIndex ?? 0, (a.faultIndex ?? 0) + frames).map((f) => `#${f.n} ${f.symbol === "n/a" ? "(no symbol) +" + f.off : f.symbol} [${f.module}${a.pkgOfModule(f.module) ? ", " + a.pkgOfModule(f.module).pkg : ""}]`),
      otherThreads: Math.max(0, a.threads.length - 1),
    },
    omarchy: { evidence: a.omarchyEv, note: a.omarchyEv.length ? "something Omarchy ships is involved; check whether its configuration or packaging is what triggers it before reporting" : "nothing in the stack or command line is an Omarchy package or file" },
    kernel: k.lines,
    oom: oom.length ? oom : "no out-of-memory record within 5 minutes before the crash",
    journalBefore: j.lines,
    journalCut: j.cut,
    earlier: {
      sameProgram: hist.sameExe - 1,
      sameStack: hist.same.length,
      firstSameStack: hist.same.length ? crash.fmt(hist.same[0].when) : null,
      sameFaultModule: hist.similar.length,
    },
    notes,
  };
}
