import { afterEach, describe, expect, it } from "vitest";
import { type NotificationSignal, notificationEvents } from "../src/notifications/events.js";

const transitionAt = "2026-11-10T12:00:00.000Z";

function sshSignal(approvalId: string): NotificationSignal {
  return {
    type: "ssh_approval",
    appId: "p:a",
    hostId: "host-1",
    approvalId,
    commandPreview: "true",
    expiresAt: "2026-11-10T12:05:00.000Z",
    transitionAt,
  };
}

afterEach(() => {
  notificationEvents.reset();
});

describe("notification events", () => {
  it("delivers a signal to every subscriber and stops after unsubscribe", () => {
    const first: NotificationSignal[] = [];
    const second: NotificationSignal[] = [];
    const unsubscribeFirst = notificationEvents.subscribe((signal) => first.push(signal));
    notificationEvents.subscribe((signal) => second.push(signal));

    notificationEvents.emit(sshSignal("a1"));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    unsubscribeFirst();
    notificationEvents.emit(sshSignal("a2"));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it("isolates a throwing listener from the writer and the other listeners", () => {
    const received: NotificationSignal[] = [];
    notificationEvents.subscribe(() => {
      throw new Error("closed consumer");
    });
    notificationEvents.subscribe((signal) => received.push(signal));

    expect(() => notificationEvents.emit(sshSignal("a1"))).not.toThrow();
    expect(received).toEqual([sshSignal("a1")]);
  });

  it("drops every subscriber on reset", () => {
    const received: NotificationSignal[] = [];
    notificationEvents.subscribe((signal) => received.push(signal));
    notificationEvents.reset();

    notificationEvents.emit(sshSignal("a1"));
    expect(received).toHaveLength(0);
  });

  it("keeps the transition timestamp on the signal", () => {
    const received: NotificationSignal[] = [];
    notificationEvents.subscribe((signal) => received.push(signal));

    notificationEvents.emit({
      type: "handoff_waiting_operator",
      handoffId: "h1",
      transitionAt,
    });
    expect(received[0]).toMatchObject({ type: "handoff_waiting_operator", transitionAt });
  });
});
