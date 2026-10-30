<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTerminalSocket } from "../composables/useTerminalSocket.js";
import {
  loadTerminalAssets,
  type XtermFitAddon,
  type XtermGlobals,
  type XtermTerminal,
} from "../terminal/loader.js";
import type { TerminalStatusKind } from "../terminal/socket.js";

const props = defineProps<{ wsPath: string; runtimeUrl: string }>();

const emit = defineEmits<{
  status: [kind: TerminalStatusKind];
  detail: [detail: string | undefined];
  banner: [text: string | null];
  selection: [enabled: boolean];
  announce: [text: string];
  "engine-error": [];
}>();

const host = ref<HTMLElement | null>(null);
const reducedMotion =
  typeof window === "undefined" ? undefined : window.matchMedia("(prefers-reduced-motion: reduce)");

let term: XtermTerminal | null = null;
let fitAddon: XtermFitAddon | null = null;
let globals: XtermGlobals | undefined;
let disposed = false;
let pageHidden = false;
let fitFrame = 0;
let fitForce = false;
let lastCols = 0;
let lastRows = 0;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;

const socketState = useTerminalSocket({
  wsPath: props.wsPath,
  runtimeUrl: props.runtimeUrl,
  autoConnect: false,
  onData: (bytes) => {
    term?.write(bytes);
  },
  onOpen: (reconnect) => {
    if (term === null) {
      return;
    }
    term.options.disableStdin = false;
    if (reconnect) {
      try {
        term.reset();
      } catch {
        // a terminal disposed mid-flight has nothing to reset
      }
      try {
        fitAddon?.fit();
      } catch {
        // fit again after the next layout pass
      }
    }
    scheduleFit(true);
    term.focus();
  },
});

watch(socketState.status, (kind) => emit("status", kind), { immediate: true });
watch(socketState.detail, (detail) => emit("detail", detail), { immediate: true });
watch(socketState.banner, (text) => emit("banner", text), { immediate: true });

function tokenValue(property: string, name: string): string {
  if (typeof document === "undefined") {
    return "";
  }
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.setProperty(property, `var(${name})`);
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).getPropertyValue(property).trim();
  probe.remove();
  if (computed.length > 0) {
    return computed;
  }
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function color(name: string): string {
  return tokenValue("color", name);
}

function readTheme(): Record<string, string> {
  return {
    background: color("--inset"),
    foreground: color("--text-1"),
    cursor: color("--brass"),
    cursorAccent: color("--inset"),
    selectionBackground: color("--selection"),
    selectionForeground: color("--text-1"),
    black: color("--text-2"),
    red: color("--status-failed"),
    green: color("--status-delivered"),
    yellow: color("--status-awaiting"),
    blue: color("--status-dispatching"),
    magenta: color("--status-expired"),
    cyan: color("--status-in-progress"),
    white: color("--text-1"),
    brightBlack: color("--text-3"),
    brightRed: color("--danger"),
    brightGreen: color("--success"),
    brightYellow: color("--warning"),
    brightBlue: color("--info"),
    brightMagenta: color("--brass"),
    brightCyan: color("--status-in-progress"),
    brightWhite: color("--text-1"),
  };
}

function announce(text: string): void {
  emit("announce", text);
}

function updateCopyButton(): void {
  const hasSelection = term !== null && term.hasSelection();
  const available =
    typeof navigator === "undefined" ||
    (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") ||
    typeof document.execCommand === "function";
  emit("selection", available && hasSelection);
}

function sendData(data: string): void {
  socketState.sendInput(data);
}

function sendBinary(data: string): void {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    bytes[index] = data.charCodeAt(index) & 0xff;
  }
  socketState.sendInput(bytes);
}

function fallbackCopy(text: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "readonly");
  area.style.position = "fixed";
  area.style.insetBlockStart = "-1000px";
  area.style.insetInlineStart = "-1000px";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  term?.focus();
  return copied;
}

async function copySelection(): Promise<void> {
  if (term === null) {
    return;
  }
  const selection = term.getSelection();
  if (selection.length === 0) {
    return;
  }
  let copied = false;
  if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(selection);
      copied = true;
    } catch {
      copied = false;
    }
  }
  if (!copied) {
    copied = fallbackCopy(selection);
  }
  if (copied) {
    announce("Copied selection.");
  }
}

async function pasteClipboard(): Promise<boolean> {
  if (term === null || navigator.clipboard === undefined) {
    return false;
  }
  if (typeof navigator.clipboard.readText !== "function") {
    return false;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text.length > 0) {
      term.paste(text);
      term.focus();
    }
    return true;
  } catch {
    return false;
  }
}

function handleKeyEvent(event: KeyboardEvent): boolean {
  if (event.type !== "keydown") {
    return true;
  }
  const key = event.key.toLowerCase();
  const copyCombo =
    (event.ctrlKey && event.shiftKey && key === "c") ||
    (event.metaKey && !event.ctrlKey && key === "c");
  if (copyCombo) {
    if (term !== null && term.hasSelection()) {
      void copySelection();
      return false;
    }
    return true;
  }
  const pasteCombo =
    (event.ctrlKey && event.shiftKey && key === "v") ||
    (event.metaKey && !event.ctrlKey && key === "v");
  if (pasteCombo) {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.readText === "function") {
      void pasteClipboard();
      return false;
    }
    return true;
  }
  return true;
}

function sendResize(force: boolean): void {
  if (term === null) {
    return;
  }
  const cols = Math.max(1, Math.min(1000, term.cols));
  const rows = Math.max(1, Math.min(1000, term.rows));
  if (!force && cols === lastCols && rows === lastRows) {
    return;
  }
  lastCols = cols;
  lastRows = rows;
  socketState.sendResize(cols, rows, force);
}

function fitAndResize(force: boolean): void {
  if (term === null || fitAddon === null) {
    return;
  }
  try {
    fitAddon.fit();
  } catch {
    return;
  }
  sendResize(force);
}

function scheduleFit(force: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  fitForce = fitForce || force;
  if (fitFrame !== 0) {
    return;
  }
  fitFrame = window.requestAnimationFrame(() => {
    fitFrame = 0;
    const forceNow = fitForce;
    fitForce = false;
    fitAndResize(forceNow);
  });
}

function ensureTerminal(): boolean {
  if (term !== null) {
    return true;
  }
  if (globals === undefined || host.value === null) {
    return false;
  }
  const fontFamily = tokenValue("font-family", "--font-mono") || "monospace";
  const fontSize = Number.parseFloat(tokenValue("font-size", "--text-mono")) || 12;
  const Unicode11Ctor = globals.Unicode11Addon as { new (): unknown } | undefined;
  const GraphemesCtor = globals.UnicodeGraphemesAddon as { new (): unknown } | undefined;
  host.value.replaceChildren();
  term = new globals.Terminal({
    fontFamily,
    fontSize,
    lineHeight: 1,
    letterSpacing: 0,
    cursorBlink: !(reducedMotion?.matches ?? false),
    cursorStyle: "bar",
    scrollback: 5000,
    screenReaderMode: true,
    allowTransparency: false,
    convertEol: false,
    allowProposedApi: true,
    theme: readTheme(),
  });
  let unicode11Loaded = false;
  if (typeof Unicode11Ctor === "function") {
    try {
      term.loadAddon(new Unicode11Ctor());
      unicode11Loaded = true;
    } catch {
      unicode11Loaded = false;
    }
  }
  let graphemesLoaded = false;
  if (typeof GraphemesCtor === "function") {
    try {
      term.loadAddon(new GraphemesCtor());
      graphemesLoaded = true;
    } catch {
      graphemesLoaded = false;
    }
  }
  if (graphemesLoaded) {
    try {
      term.unicode.activeVersion = "15-graphemes";
    } catch {
      graphemesLoaded = false;
    }
  }
  if (!graphemesLoaded && unicode11Loaded) {
    try {
      term.unicode.activeVersion = "11";
    } catch {
      // The proposed unicode API is unavailable; keep the default width table.
    }
  }
  fitAddon = new globals.FitAddon();
  term.loadAddon(fitAddon);
  term.open(host.value);
  term.options.disableStdin = true;
  term.onData(sendData);
  term.onBinary(sendBinary);
  term.onSelectionChange(updateCopyButton);
  term.attachCustomKeyEventHandler(handleKeyEvent);
  try {
    fitAddon.fit();
  } catch {
    // A hidden host cannot be measured; the open/resize handlers retry.
  }
  updateCopyButton();
  return true;
}

function disposeTerminal(): void {
  if (term !== null) {
    try {
      term.dispose();
    } catch {
      // already disposed
    }
  }
  term = null;
  fitAddon = null;
  host.value?.replaceChildren();
  emit("selection", false);
  scheduleFit(false);
}

async function start(): Promise<void> {
  try {
    const loaded = await loadTerminalAssets();
    if (disposed || pageHidden) {
      return;
    }
    globals = loaded;
    if (!ensureTerminal()) {
      emit("engine-error");
      return;
    }
    socketState.connect(false);
  } catch {
    if (disposed) {
      return;
    }
    emit("banner", "Terminal engine unavailable.");
    emit("engine-error");
  }
}

function reconnect(): void {
  if (term === null) {
    void start();
    return;
  }
  socketState.connect(true);
}

function close(): void {
  socketState.close();
}

const onViewportResize = (): void => scheduleFit(false);

function onMotionPreference(): void {
  if (term !== null) {
    term.options.cursorBlink = !(reducedMotion?.matches ?? false);
  }
}

function onThemeChange(): void {
  if (term !== null) {
    term.options.theme = readTheme();
  }
}

function onPageHide(): void {
  pageHidden = true;
  disposeTerminal();
}

function onPageShow(): void {
  if (!pageHidden) {
    return;
  }
  pageHidden = false;
  if (globals !== undefined && ensureTerminal()) {
    scheduleFit(true);
  }
}

function onHostPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest("a,button") !== null) {
    return;
  }
  term?.focus();
}

onMounted(() => {
  const win = window;
  if (typeof ResizeObserver === "function" && host.value !== null) {
    resizeObserver = new ResizeObserver(() => scheduleFit(false));
    resizeObserver.observe(host.value);
  }
  win.addEventListener("resize", onViewportResize);
  win.visualViewport?.addEventListener("resize", onViewportResize);
  reducedMotion?.addEventListener?.("change", onMotionPreference);
  win.addEventListener("pagehide", onPageHide);
  win.addEventListener("pageshow", onPageShow);
  host.value?.addEventListener("pointerdown", onHostPointerDown);
  themeObserver = new MutationObserver(onThemeChange);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  if (document.fonts?.ready !== undefined) {
    void document.fonts.ready
      .then(() => {
        if (!disposed && !pageHidden) {
          scheduleFit(true);
        }
      })
      .catch(() => undefined);
  }
  void start();
});

onBeforeUnmount(() => {
  disposed = true;
  if (typeof window !== "undefined") {
    if (fitFrame !== 0) {
      window.cancelAnimationFrame(fitFrame);
      fitFrame = 0;
    }
    window.removeEventListener("resize", onViewportResize);
    window.visualViewport?.removeEventListener("resize", onViewportResize);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    reducedMotion?.removeEventListener?.("change", onMotionPreference);
  }
  host.value?.removeEventListener("pointerdown", onHostPointerDown);
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  themeObserver?.disconnect();
  themeObserver = undefined;
  disposeTerminal();
});

defineExpose({
  reconnect,
  close,
  copySelection,
  focus: () => term?.focus(),
  write: (bytes: Uint8Array) => term?.write(bytes),
});
</script>

<template>
  <div class="terminal-host" id="terminal-host" ref="host"></div>
</template>
