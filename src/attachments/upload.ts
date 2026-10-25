import { once } from "node:events";
import { createWriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { type SniffedFile, sniffMime } from "./mime.js";
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES } from "./types.js";

export type UploadFailureCode =
  | "file_too_large"
  | "empty_file"
  | "attachment_storage_full"
  | "upload_aborted";

export class UploadStreamError extends Error {
  readonly code: UploadFailureCode;
  constructor(code: UploadFailureCode, message: string) {
    super(message);
    this.name = "UploadStreamError";
    this.code = code;
  }
}

export interface StreamedUpload {
  size: number;
  head: Buffer;
  sniffed: SniffedFile;
}

function isImageHead(head: Buffer, filename: string): boolean {
  if (head.length < 12) return false;
  return sniffMime(head, filename).kind === "image";
}

/** Stream the raw request body to `tempPath`; never buffers the whole body. */
export async function streamUploadBody(
  request: IncomingMessage,
  tempPath: string,
  filename: string,
): Promise<StreamedUpload> {
  const stream = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
  let streamError: unknown;
  stream.on("error", (error: unknown) => {
    streamError = error;
  });
  let total = 0;
  let head = Buffer.alloc(0);
  let imageKnown = false;
  try {
    for await (const raw of request) {
      if (streamError !== undefined) throw streamError;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      total += chunk.length;
      if (total > MAX_FILE_BYTES) {
        throw new UploadStreamError("file_too_large", "file exceeds the upload cap");
      }
      if (head.length < 64) {
        head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
      }
      if (!imageKnown && head.length >= 12) {
        imageKnown = true;
        if (isImageHead(head, filename) && total > MAX_IMAGE_BYTES) {
          throw new UploadStreamError("file_too_large", "image exceeds the upload cap");
        }
      }
      if (imageKnown && isImageHead(head, filename) && total > MAX_IMAGE_BYTES) {
        throw new UploadStreamError("file_too_large", "image exceeds the upload cap");
      }
      if (!stream.write(chunk)) {
        await once(stream, "drain");
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => {
        if (error !== undefined && error !== null) reject(error);
        else resolve();
      });
      stream.once("error", reject);
    });
  } catch (error) {
    stream.destroy();
    if (error instanceof UploadStreamError) throw error;
    if (isNoSpace(error) || isNoSpace(streamError)) {
      throw new UploadStreamError("attachment_storage_full", "the attachments volume is full");
    }
    if (isAborted(error)) {
      throw new UploadStreamError("upload_aborted", "upload was interrupted");
    }
    throw error;
  }
  if (total === 0) {
    throw new UploadStreamError("empty_file", "uploaded file is empty");
  }
  return { size: total, head, sniffed: sniffMime(head, filename) };
}

function isNoSpace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOSPC"
  );
}

function isAborted(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as NodeJS.ErrnoException).code === "ECONNRESET") return true;
  if ("name" in error && (error as Error).name === "AbortError") return true;
  return false;
}
