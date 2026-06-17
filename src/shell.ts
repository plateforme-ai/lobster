export function resolveInlineShellCommand({
  command,
  env,
  platform = process.platform,
}: {
  command: string;
  env: Record<string, string | undefined>;
  platform?: string;
}) {
  const shellOverride = String(env?.LOBSTER_SHELL ?? "").trim();
  const isWindows = platform === "win32";

  if (shellOverride) {
    const shellArgs = buildShellArgs({ shellCommand: shellOverride, command, isWindows });
    return {
      command: shellOverride,
      argv: shellArgs.argv,
      windowsVerbatimArguments: shellArgs.windowsVerbatimArguments,
    };
  }

  if (isWindows) {
    const comspec = String(env?.ComSpec ?? env?.COMSPEC ?? "cmd.exe").trim() || "cmd.exe";
    return {
      command: comspec,
      argv: ["/d", "/c", command],
      windowsVerbatimArguments: true,
    };
  }

  // Keep default behavior deterministic and POSIX-compatible across environments.
  const shell = "/bin/sh";
  return {
    command: shell,
    argv: ["-lc", command],
    windowsVerbatimArguments: false,
  };
}

function buildShellArgs({
  shellCommand,
  command,
  isWindows,
}: {
  shellCommand: string;
  command: string;
  isWindows: boolean;
}) {
  const lowered = shellCommand.toLowerCase();
  const looksLikeCmd = lowered.endsWith("cmd") || lowered.endsWith("cmd.exe");
  const looksLikePowerShell =
    lowered.endsWith("powershell") ||
    lowered.endsWith("powershell.exe") ||
    lowered.endsWith("pwsh") ||
    lowered.endsWith("pwsh.exe");

  if (looksLikePowerShell) {
    return { argv: ["-NoProfile", "-Command", command], windowsVerbatimArguments: false };
  }
  if (looksLikeCmd || isWindows) {
    return { argv: ["/d", "/c", command], windowsVerbatimArguments: true };
  }
  return { argv: ["-lc", command], windowsVerbatimArguments: false };
}
