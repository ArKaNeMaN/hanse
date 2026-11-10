import type { ApprovalKind } from "../coordinator/approval.js";
import type { HandoffState } from "../coordinator/handoff.js";

/**
 * Signals that are not projected agent events: SSH/handoff approvals, handoff reply transitions,
 * and parked thread messages. Every signal is emitted only after the write that produced it commits.
 */
export interface NotificationSignalBase {
  /** Timestamp of the transition that produced this signal, captured at the write. */
  transitionAt: string;
}

export interface SshApprovalNotification extends NotificationSignalBase {
  type: "ssh_approval";
  appId: string;
  hostId: string;
  approvalId: string;
  commandPreview: string;
  expiresAt: string;
}

export interface HandoffApprovalNotification extends NotificationSignalBase {
  type: "handoff_approval";
  handoffId: string;
  approvalKind: ApprovalKind;
  approvalId: string;
  requestedAt: string;
}

export interface HandoffWaitingOperatorNotification extends NotificationSignalBase {
  type: "handoff_waiting_operator";
  handoffId: string;
}

export interface HandoffFailedNotification extends NotificationSignalBase {
  type: "handoff_failed";
  handoffId: string;
  /**
   * `reply` is a failed reply delivery; `terminal` is a handoff that itself became
   * failed/rejected/expired.
   */
  scope: "reply" | "terminal";
  /** The terminal handoff state, present for `scope: "terminal"`. */
  state?: HandoffState;
}

export interface HandoffReplyDeliveredNotification extends NotificationSignalBase {
  type: "handoff_reply_delivered";
  handoffId: string;
}

export interface ThreadMessageWaitingNotification extends NotificationSignalBase {
  type: "thread_message_waiting";
  messageId: number;
  handoffId: string;
}

export type NotificationSignal =
  | SshApprovalNotification
  | HandoffApprovalNotification
  | HandoffWaitingOperatorNotification
  | HandoffFailedNotification
  | HandoffReplyDeliveredNotification
  | ThreadMessageWaitingNotification;

export type NotificationEventListener = (signal: NotificationSignal) => void;

const listeners = new Set<NotificationEventListener>();

/**
 * Module-level notification signal bus.
 *
 * Mirrors `processEvents`: the router subscribes without needing a coordinator service instance,
 * and one throwing listener cannot affect the writer or the other listeners.
 */
export const notificationEvents = {
  subscribe(listener: NotificationEventListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  emit(signal: NotificationSignal): void {
    for (const listener of [...listeners]) {
      try {
        listener(signal);
      } catch {
        // One closed consumer must not affect the writer or the other consumers.
      }
    }
  },

  /** Test-only reset; production has no lifecycle that drops every subscriber. */
  reset(): void {
    listeners.clear();
  },
};
