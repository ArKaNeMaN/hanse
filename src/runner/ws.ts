import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface WebSocketPeer {
  send(data: Buffer, type?: "text" | "binary"): boolean;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: Buffer, type: "text" | "binary") => void): void;
  onClose(listener: () => void): void;
  onDrain(listener: () => void): void;
  pause(): void;
  resume(): void;
}

/** Check the RFC 6455 client handshake headers. Returns a human-readable reason on failure. */
export function websocketHandshakeError(request: IncomingMessage): string | undefined {
  if ((request.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    return "missing websocket upgrade";
  }
  if (request.headers["sec-websocket-version"] !== "13") {
    return "unsupported websocket version";
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
    return "invalid websocket key";
  }
  return undefined;
}

function acceptKey(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class WebSocketPeerImpl implements WebSocketPeer {
  readonly #socket: Duplex;
  #buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentType: "text" | "binary" | undefined;
  #messageListeners: Array<(data: Buffer, type: "text" | "binary") => void> = [];
  #closeListeners: Array<() => void> = [];
  #closed = false;
  #closeEmitted = false;

  constructor(socket: Duplex, head: Buffer) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
    socket.on("close", () => this.#emitClose());
    socket.on("end", () => this.#emitClose());
    socket.on("error", () => this.#emitClose());
    if (head.length > 0) {
      queueMicrotask(() => this.#consume(head));
    }
  }

  send(data: Buffer, type: "text" | "binary" = "binary"): boolean {
    if (this.#closed || !this.#socket.writable) return false;
    return this.#socket.write(frame(type === "text" ? OPCODE_TEXT : OPCODE_BINARY, data));
  }

  close(code = 1000, reason = ""): void {
    if (this.#closed) return;
    this.#closed = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, "utf8");
    this.#writeControl(OPCODE_CLOSE, payload);
    this.#socket.end();
  }

  onMessage(listener: (data: Buffer, type: "text" | "binary") => void): void {
    this.#messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  onDrain(listener: () => void): void {
    this.#socket.once("drain", listener);
  }

  pause(): void {
    this.#socket.pause();
  }

  resume(): void {
    this.#socket.resume();
  }

  #writeControl(opcode: number, payload: Buffer): void {
    if (!this.#socket.writable) return;
    this.#socket.write(frame(opcode, payload));
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#parseFrame()) {
      // Keep draining complete frames already buffered.
    }
  }

  #parseFrame(): boolean {
    const buffer = this.#buffer;
    if (buffer.length < 2) return false;

    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if ((first & 0x70) !== 0) {
      this.#fail(1002, "reserved bits set");
      return false;
    }
    if (!masked) {
      this.#fail(1002, "client frame is not masked");
      return false;
    }

    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return false;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) {
        this.#fail(1009, "message too large");
        return false;
      }
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_WEBSOCKET_MESSAGE_BYTES) {
      this.#fail(1009, "message too large");
      return false;
    }
    if (buffer.length < offset + 4 + length) return false;

    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    this.#buffer = buffer.subarray(offset + length);
    this.#handleFrame(fin, opcode, payload);
    return true;
  }

  #handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === OPCODE_CLOSE) {
      this.#writeControl(OPCODE_CLOSE, payload.subarray(0, 125));
      this.#closed = true;
      this.#socket.end();
      this.#emitClose();
      return;
    }
    if (opcode === OPCODE_PING) {
      this.#writeControl(OPCODE_PONG, payload.subarray(0, 125));
      return;
    }
    if (opcode === OPCODE_PONG) return;

    if (opcode === OPCODE_CONTINUATION) {
      if (this.#fragmentType === undefined) {
        this.#fail(1002, "unexpected continuation frame");
        return;
      }
      this.#fragments.push(payload);
      if (!fin) return;
      const data = Buffer.concat(this.#fragments);
      const type = this.#fragmentType;
      this.#fragments = [];
      this.#fragmentType = undefined;
      this.#emitMessage(data, type);
      return;
    }

    if (opcode !== OPCODE_TEXT && opcode !== OPCODE_BINARY) {
      this.#fail(1002, "unsupported opcode");
      return;
    }
    const type = opcode === OPCODE_TEXT ? "text" : "binary";
    if (fin) {
      this.#emitMessage(payload, type);
      return;
    }
    if (this.#fragmentType !== undefined) {
      this.#fail(1002, "nested fragmented message");
      return;
    }
    this.#fragmentType = type;
    this.#fragments = [payload];
  }

  #emitMessage(data: Buffer, type: "text" | "binary"): void {
    for (const listener of this.#messageListeners) {
      listener(data, type);
    }
  }

  #emitClose(): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    for (const listener of this.#closeListeners) {
      listener();
    }
  }

  #fail(code: number, reason: string): void {
    if (this.#closed) return;
    this.close(code, reason);
  }
}

/** Complete the server handshake and return a peer that decodes client frames. */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): WebSocketPeer {
  const key = request.headers["sec-websocket-key"] ?? "";
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "",
      "",
    ].join("\r\n"),
  );
  return new WebSocketPeerImpl(socket, head);
}
