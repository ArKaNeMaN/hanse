/** opencode's generated placeholder title (`New session - <ISO-8601>`). */
export function isDefaultTitle(title: string | undefined): boolean {
  if (title === undefined) return false;
  return /^New session\s*-\s*\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/i.test(title.trim());
}

function singleLine(value: string): string {
  return Array.from(value.replace(/[\r\n\t]+/g, " "))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127 && code !== 0x2028 && code !== 0x2029;
    })
    .join("")
    .trim();
}

/** Prefer the operator's first line; fall back to the neutral `Attachment` title. */
export function attachmentTitle(text: string): string {
  const line = singleLine(text.split(/\r?\n/, 1)[0] ?? "")
    .slice(0, 120)
    .trim();
  const candidate = line.length > 0 ? line : "Attachment";
  return isDefaultTitle(candidate)
    ? `Attachment: ${candidate.slice(0, 108)}`.slice(0, 120)
    : candidate;
}

/** A title the operator chose that looks like opencode's default must never suppress generation. */
export function prefixDefaultLikeTitle(title: string): string {
  return isDefaultTitle(title) ? `Session: ${title.slice(0, 111)}`.slice(0, 120) : title;
}
