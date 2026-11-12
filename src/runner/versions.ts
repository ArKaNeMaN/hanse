/**
 * Runner protocol version surface introduced for the isolation stage.
 *
 * These constants back `GET /v1/meta`, which is also the coordinator handshake source. The legacy
 * `/healthz` endpoint is now a constant liveness response and carries no version data.
 */
export const RUNNER_API_VERSION = 3;
export const MIN_RUNNER_API_VERSION = 3;
export const NAME_VERSION = 2;
export const RECORD_VERSION = 1;

/** Exact response body of `GET /v1/meta`. */
export interface RunnerMeta {
  apiVersion: number;
  minApiVersion: number;
  nameVersion: number;
  recordVersion: number;
  runnerVersion: string;
}
