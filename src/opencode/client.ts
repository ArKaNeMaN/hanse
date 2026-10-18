export interface OpencodeSession {
  id: string;
  title?: string;
  [key: string]: unknown;
}

export interface OpencodePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface OpencodeMessage {
  info: { id: string; role: "user" | "assistant"; [key: string]: unknown };
  parts: OpencodePart[];
}

async function call<T>(endpoint: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`opencode ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

export function listSessions(endpoint: string): Promise<OpencodeSession[]> {
  return call<OpencodeSession[]>(endpoint, "/session");
}

export function createSession(endpoint: string, title?: string): Promise<OpencodeSession> {
  return call<OpencodeSession>(endpoint, "/session", {
    method: "POST",
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
}

export async function deleteSession(endpoint: string, sessionId: string): Promise<void> {
  const path = `/session/${encodeURIComponent(sessionId)}`;
  const response = await fetch(`${endpoint}${path}`, { method: "DELETE" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`opencode DELETE ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
}

export function listMessages(endpoint: string, sessionId: string): Promise<OpencodeMessage[]> {
  return call<OpencodeMessage[]>(endpoint, `/session/${sessionId}/message`);
}

export function sendPrompt(
  endpoint: string,
  sessionId: string,
  text: string,
): Promise<OpencodeMessage> {
  return call<OpencodeMessage>(endpoint, `/session/${sessionId}/message`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  });
}
