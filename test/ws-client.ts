import { randomBytes } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

export interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  rest: Buffer;
}

export interface UpgradeResult {
  status: number;
  key: string;
  body: string;
  headers: http.IncomingHttpHeaders;
  socket?: Duplex;
  head: Buffer;
}

function frame(opcode: number, payload: Buffer, masked: boolean): Buffer {
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
  if (!masked) return Buffer.concat([header, payload]);

  header[1] = (header[1] ?? 0) | 0x80;
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = (body[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, mask, body]);
}

export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  return frame(opcode, payload, true);
}

export function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  return frame(opcode, payload, false);
}

export function parseFrame(buffer: Buffer, expectMasked: boolean): ParsedFrame | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  if (masked !== expectMasked) {
    throw new Error(`expected masked=${expectMasked} frame, got masked=${masked}`);
  }
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  }
  return { fin, opcode, payload, rest: buffer.subarray(offset + length) };
}

export function requestUpgrade(options: {
  port: number;
  path: string;
  headers?: Record<string, string>;
}): Promise<UpgradeResult> {
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: options.port,
      path: options.path,
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        ...options.headers,
      },
    });
    request.on("upgrade", (response, socket, head) => {
      resolve({
        status: response.statusCode ?? 0,
        key,
        body: "",
        headers: response.headers,
        socket,
        head,
      });
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          key,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
          head: Buffer.alloc(0),
        });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

export class WsClient {
  readonly #socket: Duplex;
  #buffer = Buffer.alloc(0);
  #frames: Array<{ opcode: number; payload: Buffer }> = [];
  #waiters: Array<{
    resolve: (frame: { opcode: number; payload: Buffer }) => void;
    reject: (error: Error) => void;
  }> = [];

  private constructor(socket: Duplex, head: Buffer) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (error: Error) => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("socket closed")));
    if (head.length > 0) this.#onData(head);
  }

  static async connect(options: {
    port: number;
    path: string;
    headers?: Record<string, string>;
  }): Promise<WsClient> {
    const result = await requestUpgrade(options);
    if (result.socket === undefined) {
      throw new Error(`expected an upgrade, got HTTP ${result.status}: ${result.body}`);
    }
    return new WsClient(result.socket, result.head);
  }

  send(data: string | Buffer, type: "text" | "binary" = "text"): boolean {
    return this.#socket.write(encodeClientFrame(type === "text" ? 0x1 : 0x2, Buffer.from(data)));
  }

  close(): void {
    this.#socket.write(encodeClientFrame(0x8, Buffer.alloc(0)));
    this.#socket.end();
  }

  destroy(): void {
    this.#socket.destroy();
  }

  nextMessage(timeoutMs = 2000): Promise<{ opcode: number; payload: Buffer }> {
    const queued = this.#frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.resolve !== onFrame);
        reject(new Error("timed out waiting for a websocket frame"));
      }, timeoutMs);
      const onFrame = (frame: { opcode: number; payload: Buffer }): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.#waiters.push({ resolve: onFrame, reject });
    });
  }

  async nextText(timeoutMs = 2000): Promise<string> {
    const frame = await this.nextMessage(timeoutMs);
    return frame.payload.toString("utf8");
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const parsed = parseFrame(this.#buffer, false);
      if (parsed === undefined) return;
      this.#buffer = parsed.rest;
      const frame = { opcode: parsed.opcode, payload: parsed.payload };
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#frames.push(frame);
      } else {
        waiter.resolve(frame);
      }
    }
  }

  #fail(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}
