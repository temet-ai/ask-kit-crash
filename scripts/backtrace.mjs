export const meta = {
  purpose:
    "The full backtrace of the crashing thread from the stored core, through gdb in batch mode: frames with function names where the machine has symbols, the module and owning package of each frame, the fault address and the faulting instruction, and a summary of every other thread's top frames (what work was in flight). It unpacks the core to a private temporary folder and deletes it. Only backtraces, module names, three registers and two instructions come back, never memory. Without gdb or with an unreadable core it returns the journal's stack and says so.",
  params: {
    crash: "a pid, 'last' (default), or a program name",
    max: "most frames of the crashing thread, default 25",
    symbols: "true to look up debug info on the Arch debuginfod server (needs network, saves to ~/.cache/debuginfod_client, can take minutes); default false",
    registers: "false to skip the registers and instructions",
  },
  returns: "{crash, source, signal, siCode, faultAddress, faultAddressNote, faultingFrameIndex, signalHandlerAt, frames:['#4 function or (no symbol) [module, package version]'], framesUnresolved, registers, threadCount, threads:[{thread, id, top}], notes, warnings}",
  example: 'await scripts.run("backtrace", { crash: "last", max: 30 })',
};

export default async function ({ crash }, { crash: sel = "last", max = 25, symbols = false, registers } = {}) {
  return crash.backtrace(sel, { max, symbols, registers });
}
