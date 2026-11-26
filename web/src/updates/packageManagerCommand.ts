import type { InstallChannel } from "../bindings";

/** The command that updates a Package install (deb via APT, rpm via DNF); null where Oxide updates itself. */
export function packageManagerCommand(channel: InstallChannel): string | null {
  if (channel === "apt") return "sudo apt update && sudo apt upgrade";
  if (channel === "dnf") return "sudo dnf upgrade";
  return null;
}
