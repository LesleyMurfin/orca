// Why: native-Windows ConPTY and remote-runtime (serve) PTYs both split a
// `?25l`...`?25h` cursor burst across separate output frames, so cursor
// protection must cover both transports. Local non-Windows PTYs deliver each
// burst in one frame and need no protection.
export function shouldProtectSplitCursorBursts(args: {
  isNativeWindowsConpty: boolean
  runtimeEnvironmentId: string | null
}): boolean {
  return args.isNativeWindowsConpty || args.runtimeEnvironmentId !== null
}
