export const RUNNER_API_VERSION = 1;
export const RUNNER_API_MIN = 1;
export const RUNNER_API_MAX = 1;

export interface RunnerHandshake {
  apiVersion: number;
  minApiVersion: number;
  maxApiVersion: number;
  hanseVersion?: string;
}

export function isRunnerCompatible(handshake: RunnerHandshake | undefined): boolean {
  if (handshake === undefined || handshake.apiVersion < RUNNER_API_MIN) {
    return false;
  }
  return (
    handshake.apiVersion <= RUNNER_API_MAX &&
    RUNNER_API_VERSION >= handshake.minApiVersion &&
    RUNNER_API_VERSION <= handshake.maxApiVersion
  );
}
