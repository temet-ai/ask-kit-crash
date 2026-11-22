export const meta = {
  purpose:
    "The facts a bug report about one crash needs, as ready text in the form Omarchy's reporting rules ask for: what happened, system details (Omarchy version, kernel, package versions), the signal and the stack, where the fault lies, earlier occurrences and whether an update came first, whether it falls in Omarchy's sphere or belongs upstream (with the upstream URL pacman records), and the searches to run before filing. Nothing is filed. With write: '<path>' and a caller who asked for a change it writes the text to a new file.",
  params: {
    crash: "a pid, 'last' (default), or a program name",
    write: "path of a new file to write the text to (needs act: true; an existing file is refused)",
    days: "days of pacman.log before the first crash to read, default 7",
  },
  returns: "{text, sections, upstream, inOmarchySphere, searches, wrote}",
  example: 'await scripts.run("report", { crash: "last" })',
};

export default async function ({ crash }, { crash: sel = "last", write, days = 7 } = {}) {
  const a = await crash.analyse(sel);
  const c = a.c;
  const pkgs = [...new Set([a.faultPkg?.pkg, a.exePkg?.pkg].filter(Boolean))];
  const [hist, sys, k, infoAll] = await Promise.all([crash.history(a), crash.system(["linux", "hyprland", "mesa"]), crash.kernelNear(c), Promise.all(pkgs.map((p) => crash.pkgInfo(p)))]);
  const info = infoAll.filter(Boolean);
  const occ = [...hist.same, c].sort((x, y) => x.when - y.when);
  const first = occ[0];
  const changes = (await crash.upgrades(first.when - days * 86400_000, first.when)).filter((e) => pkgs.includes(e.pkg));
  const evidence = a.omarchyEv;
  const inSphere = evidence.length > 0 && !(a.faultPkg && !/^omarchy/.test(a.faultPkg.pkg) && a.kind === "library");
  const top = a.frames.slice(a.faultIndex ?? 0, (a.faultIndex ?? 0) + 10).map((f) => `  #${f.n} ${f.symbol === "n/a" ? "(no symbol)" : f.symbol} (${f.module}${f.off ? " + " + f.off : ""})`);
  const upstream = info.map((p) => ({ package: p.name, version: p.version, url: p.url, source: p.foreign ? "foreign (AUR or local build)" : "official Arch repositories" }));
  const exeName = (c.exe ?? "").split("/").pop();
  const searches = [
    `gh search issues --repo omacom/omarchy "${exeName} crash"`,
    `gh issue list --repo omacom/omarchy --state all --search "${c.signal} ${exeName}"`,
    ...(a.fault?.symbol && a.fault.symbol !== "n/a" ? [`gh search issues --repo omacom/omarchy "${a.fault.symbol.slice(0, 60)}"`] : []),
  ];
  const lines = [
    `Title (draft): ${exeName} crashes with ${c.signal}${a.fault ? ` in ${a.fault.module}` : ""}`,
    "",
    "What happened",
    `${exeName} crashed with ${crash.sigLine(c)} at ${crash.fmt(c.when)}${c.unit ? ` (unit ${c.unit})` : ""}. Command line: ${c.cmdline ?? "not recorded"}.`,
    `Where: ${a.why}`,
    `Core: ${c.core}. Stack as recorded by systemd-coredump (top frames from the faulting one):`,
    ...top,
    "",
    "Expected",
    `${exeName} keeps running.`,
    "",
    "Steps to reproduce",
    occ.length > 1 ? `Not established. The same stack crashed ${occ.length} times, first at ${crash.fmt(first.when)}, last at ${crash.fmt(c.when)}. Add what was being done at those times.` : "Not established: one crash with this stack. Add what was being done at the time.",
    "",
    "System details",
    `Omarchy ${sys.omarchy ?? "(version not available)"}; kernel ${sys.kernel}; ${Object.entries(sys.packages ?? {}).map(([p, v]) => `${p} ${v}`).join("; ")}`,
    ...info.map((p) => `${p.name} ${p.version}: ${p.foreign ? "foreign package" : "official repository"}, upstream ${p.url ?? "unknown"}`),
    changes.length ? `Changed in the ${days} days before the first crash: ${changes.map((e) => `${e.pkg} ${e.from ?? ""} -> ${e.to} (${e.when})`).join("; ")}.` : `No package of the stack changed in the ${days} days before the first crash.`,
    ...(k.lines.length ? ["Kernel lines near the crash:", ...k.lines.map((l) => "  " + l)] : []),
    "",
    "Diagnostics",
    "Run `omarchy debug --no-sudo --print` and attach its output (it also writes /tmp/omarchy-debug.log); this kit does not run it.",
    "",
    "Filed by <model name> via <agent harness>.",
  ];
  const text = lines.join("\n");
  const out = {
    text,
    sections: { where: a.kind, firstSameStack: crash.fmt(first.when), occurrences: occ.length },
    upstream,
    inOmarchySphere: { likely: inSphere, evidence: evidence.length ? evidence : "no Omarchy package or file in the stack or command line", rule: "a crash in a program Omarchy only installs is an upstream bug of that program unless Omarchy's packaging or configuration is implicated (skills.read('report-upstream'))" },
    searches,
  };
  if (write) out.wrote = crash.writeFile(write, text + "\n");
  return out;
}
