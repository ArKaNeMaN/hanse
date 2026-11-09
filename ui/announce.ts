/** Announce a route change through the shell's polite live region. */
export function announce(message: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const announcer = document.getElementById("route-announcer");
  if (announcer !== null) {
    announcer.textContent = message;
  }
}
