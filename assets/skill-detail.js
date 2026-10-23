/**
 * Skill workspace progressive enhancement (design D5/D6/D10, plan 0017 phase 4b).
 *
 * Loaded only on the skill workspace and create pages. The server renders the full
 * bundle form and stacked file editors; this module adds file tabs, the live
 * source/preview split, dirty state, and JSON submission. It never autosaves and
 * never assigns skill text through `innerHTML`; the preview uses the shared safe
 * renderer from `./markdown.js`.
 */

import { element, renderMarkdown } from "./markdown.js";

const DEBOUNCE_MS = 120;
const MAX_REFERENCES = 20;
const MAX_REFERENCE_CONTENT = 48_000;
const MAX_REFERENCE_AGGREGATE = 192_000;
const SKILL_PATH = "SKILL.md";
const REFERENCE_PATH = /^references\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const METADATA_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const encoder = new TextEncoder();

function onReady(callback) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
    return;
  }
  callback();
}

function bytesOf(text) {
  return encoder.encode(text).length;
}

function intValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMetadataJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false };
  }
  const metadata = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      return { ok: false };
    }
    metadata[key] = value;
  }
  return { ok: true, value: metadata };
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

function yamlKey(key) {
  return METADATA_KEY.test(key) ? key : JSON.stringify(key);
}

function chevronIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon skill-frontmatter__chevron");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 18 6-6-6-6");
  svg.append(path);
  return svg;
}

function withNotice(path, message, tone) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("notice", message);
  url.searchParams.set("tone", tone);
  return `${url.pathname}${url.search}${url.hash}`;
}

function copyText(text) {
  if (navigator.clipboard !== undefined) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.insetBlockStart = "-1000px";
    document.body.append(area);
    area.select();
    try {
      if (document.execCommand("copy")) {
        resolve();
      } else {
        reject(new Error("copy failed"));
      }
    } catch (error) {
      reject(error);
    } finally {
      area.remove();
    }
  });
}

function init() {
  const root = document.querySelector("[data-skill-workspace]");
  if (!(root instanceof HTMLElement)) {
    return;
  }
  const form = document.querySelector("form[data-skill-form]");
  const editable = form instanceof HTMLFormElement;
  const readonly = document.querySelector("[data-skill-readonly]");
  const scope = editable ? form : readonly instanceof HTMLElement ? readonly : root;
  const panesHost = root.querySelector("[data-skill-panes]");
  const preview = root.querySelector("[data-skill-preview]");
  const previewPane = root.querySelector("[data-skill-preview-pane]");
  const previewTitle = root.querySelector("[data-skill-preview-title]");
  const frontmatterSlot = root.querySelector("[data-skill-frontmatter]");
  const viewTabs = root.querySelector("[data-skill-viewtabs]");
  const status = scope.querySelector("[data-skill-status]");
  const save = scope.querySelector("[data-skill-save]");
  const discard = scope.querySelector("[data-skill-discard]");
  const bundleInput = scope.querySelector("[data-skill-bundle]");
  const details = scope.querySelector("[data-skill-details]");

  if (!(panesHost instanceof HTMLElement) || !(preview instanceof HTMLElement)) {
    return;
  }
  if (previewPane === null || scope === null) {
    return;
  }

  let fileList = root.querySelector("[data-skill-file-list]");
  let activeId = null;
  let view = "source";
  let previewTimer = 0;
  let newReferenceCounter = 0;
  let initialSerialized = "";
  let initialBundleRaw = "";
  let initialPreserveInvalid = false;
  let initialRawMetadata = "";
  let initialHadFileList = fileList !== null;
  let initialSkillPane = null;
  let initialReferencePanes = [];
  let clientErrors = [];
  let submitting = false;
  let dirty = false;
  let frontmatterOpen = false;

  const rawMetadata = scope.querySelector("[data-skill-metadata-raw]");
  const rawMetadataField = rawMetadata === null ? null : rawMetadata.closest(".field");
  const customHost = scope.querySelector("[data-skill-custom-metadata]");
  const description = scope.querySelector("#skill-description");
  const enabledCheck = scope.querySelector('input[type="checkbox"][data-skill-field="enabled"]');

  const panes = () => Array.from(panesHost.querySelectorAll("[data-skill-file]"));
  const referencePanes = () =>
    panes().filter((pane) => pane.dataset.skillFileKind === "reference");

  function paneFor(id) {
    return panes().find((pane) => pane.dataset.skillFileId === id) ?? null;
  }

  function panePath(pane) {
    if (pane.dataset.skillFileKind === "skill") {
      return SKILL_PATH;
    }
    const input = pane.querySelector("[data-skill-reference-path]");
    if (input !== null) {
      return input.value.trim();
    }
    return pane.dataset.skillFilePath ?? "";
  }

  function paneText(pane) {
    const textarea = pane.querySelector("textarea");
    if (textarea !== null) {
      return textarea.value;
    }
    const staticSource = pane.querySelector("[data-skill-source-static]");
    return staticSource === null ? "" : (staticSource.textContent ?? "");
  }

  function knownMetadata() {
    const result = {};
    for (const input of scope.querySelectorAll("[data-skill-metadata-key]")) {
      const key = input.dataset.skillMetadataKey;
      if (key === undefined) {
        continue;
      }
      if (input.value.trim().length > 0) {
        result[key] = input.value;
      }
    }
    return result;
  }

  function customMetadata() {
    const result = {};
    for (const row of scope.querySelectorAll("[data-skill-metadata-row]")) {
      const keyInput = row.querySelector("[data-skill-metadata-key-input]");
      const valueInput = row.querySelector("[data-skill-metadata-value-input]");
      const key = keyInput === null ? "" : keyInput.value.trim();
      const value = valueInput === null ? "" : valueInput.value;
      if (key.length === 0 && value.trim().length === 0) {
        continue;
      }
      result[key] = value;
    }
    return result;
  }

  function currentMetadata() {
    return { ...knownMetadata(), ...customMetadata() };
  }

  function referenceValues() {
    const values = [];
    for (const pane of referencePanes()) {
      const path = panePath(pane);
      const content = paneText(pane);
      if (path.length === 0 && content.trim().length === 0) {
        continue;
      }
      values.push({ path, content });
    }
    return values;
  }

  function formState() {
    return {
      description: description === null ? "" : description.value,
      content: scope.querySelector("#skill-content")?.value ?? "",
      enabled: enabledCheck === null ? false : enabledCheck.checked,
      license: scope.querySelector("#skill-license")?.value ?? "",
      compatibility: scope.querySelector("#skill-compatibility")?.value ?? "",
      known: Array.from(scope.querySelectorAll("[data-skill-metadata-key]")).map((input) => [
        input.dataset.skillMetadataKey ?? "",
        input.value,
      ]),
      custom: Array.from(scope.querySelectorAll("[data-skill-metadata-row]")).map((row) => [
        row.querySelector("[data-skill-metadata-key-input]")?.value ?? "",
        row.querySelector("[data-skill-metadata-value-input]")?.value ?? "",
      ]),
      metadataRaw: rawMetadata === null ? null : rawMetadata.value,
      references: referencePanes().map((pane) => ({
        id: pane.dataset.skillFileId ?? "",
        path: panePath(pane),
        content: paneText(pane),
      })),
    };
  }

  function fileDirty(pane) {
    const id = pane.dataset.skillFileId;
    const initial = initialPanesById.get(id);
    if (initial === undefined) {
      return true;
    }
    return initial.path !== panePath(pane) || initial.content !== paneText(pane);
  }

  const initialPanesById = new Map();

  function captureInitialPanes() {
    for (const pane of panes()) {
      const id = pane.dataset.skillFileId ?? "";
      initialPanesById.set(id, { path: panePath(pane), content: paneText(pane) });
    }
    initialSkillPane = panes().find((pane) => pane.dataset.skillFileKind === "skill") ?? null;
    initialReferencePanes = referencePanes().map((pane) => {
      const id = pane.dataset.skillFileId ?? "";
      return {
        id,
        node: pane,
        path: panePath(pane),
        content: paneText(pane),
        textarea: pane.querySelector("[data-skill-reference-content]"),
        pathInput: pane.querySelector("[data-skill-reference-path]"),
      };
    });
    initialHadFileList = fileList !== null;
  }

  function ensureIds() {
    let index = 0;
    for (const pane of panes()) {
      if (pane.dataset.skillFileId === undefined) {
        while (paneFor(`skill-file-auto-${index}`) !== null) {
          index += 1;
        }
        pane.dataset.skillFileId = `skill-file-auto-${index}`;
        pane.id = pane.dataset.skillFileId;
      }
    }
  }

  function ensureFileList() {
    if (fileList !== null) {
      return fileList;
    }
    const list = element("aside", "skill-file-list");
    list.dataset.skillFileList = "";
    list.setAttribute("aria-label", "Skill files");
    const head = element("div", "skill-file-list__head");
    head.append(element("p", "nav-label", "Files"));
    const count = element("span", "hint mono");
    count.dataset.skillFileCount = "";
    head.append(count);
    const tabs = element("div", "skill-file-tabs");
    tabs.dataset.skillFileTabs = "";
    const picker = element("div", "skill-file-picker");
    picker.dataset.skillFilePicker = "";
    const label = element("label", "sr-only", "Active file");
    label.setAttribute("for", "skill-file-select");
    const select = element("select", "input");
    select.id = "skill-file-select";
    select.dataset.skillFileSelect = "";
    picker.append(label, select);
    list.append(head, tabs, picker);
    if (editable) {
      const add = element("button", "btn btn-secondary btn-sm skill-add-reference", "Add reference");
      add.type = "button";
      add.dataset.skillAddReference = "";
      list.append(add);
    }
    root.insertBefore(list, root.firstChild);
    fileList = list;
    picker.hidden = false;
    return list;
  }

  function updateFileCount() {
    if (fileList === null) {
      return;
    }
    const count = fileList.querySelector("[data-skill-file-count]");
    if (count !== null) {
      count.textContent = String(panes().length);
    }
  }

  function tabFor(id) {
    return fileList === null ? null : fileList.querySelector(`[data-skill-file-tab][data-skill-file-id="${id}"]`);
  }

  function syncFileNavigation() {
    if (fileList === null) {
      return;
    }
    const tabsHost = fileList.querySelector("[data-skill-file-tabs]");
    const select = fileList.querySelector("[data-skill-file-select]");
    if (!(tabsHost instanceof HTMLElement) || !(select instanceof HTMLSelectElement)) {
      return;
    }
    tabsHost.replaceChildren();
    select.replaceChildren();
    for (const pane of panes()) {
      const id = pane.dataset.skillFileId ?? "";
      const path = panePath(pane) || "New reference";
      const tab = element("a", "settings-nav__link skill-file-tab");
      tab.href = `#${id}`;
      tab.dataset.skillFileTab = "";
      tab.dataset.skillFileId = id;
      tab.dataset.skillFilePath = path;
      tab.id = `skill-file-tab-${id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", pane.id);
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-labelledby", tab.id);
      const name = element("span", "skill-file-tab__name", path);
      const size = element("span", "hint mono skill-file-tab__size");
      size.dataset.skillFileTabSize = "";
      const dot = element("span", "skill-file-dirty");
      dot.dataset.skillFileDirty = "";
      dot.hidden = true;
      dot.append(element("span", "sr-only", "Unsaved changes"));
      tab.append(name, size, dot);
      tabsHost.append(tab);
      const option = element("option", "", path);
      option.value = id;
      select.append(option);
    }
    tabsHost.setAttribute("role", "tablist");
    tabsHost.setAttribute("aria-label", "Skill files");
    updateFileCount();
    refreshFileLabels();
    updateNavSelection();
  }

  function updateNavSelection() {
    if (fileList === null || activeId === null) {
      return;
    }
    for (const tab of fileList.querySelectorAll("[data-skill-file-tab]")) {
      const selected = tab.dataset.skillFileId === activeId;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      tab.removeAttribute("aria-current");
    }
    const select = fileList.querySelector("[data-skill-file-select]");
    if (select instanceof HTMLSelectElement) {
      select.value = activeId;
    }
  }

  function refreshFileLabels(changedPane = undefined) {
    const sizeTargets =
      changedPane === undefined
        ? panes()
        : changedPane instanceof HTMLElement
          ? [changedPane]
          : [];
    for (const pane of sizeTargets) {
      const size = bytesOf(paneText(pane));
      for (const label of pane.querySelectorAll("[data-skill-file-size]")) {
        label.textContent = `${size} bytes`;
      }
    }
    for (const input of scope.querySelectorAll("[data-skill-counter]")) {
      const owner = input.closest("[data-skill-file]") ?? input.closest(".field");
      const output = owner === null ? null : owner.querySelector("[data-skill-counter-output]");
      if (output !== null) {
        output.textContent = `${input.value.length} / ${input.dataset.skillCounter ?? ""}`;
      }
    }
    if (fileList !== null && changedPane !== null) {
      for (const tab of fileList.querySelectorAll("[data-skill-file-tab]")) {
        const id = tab.dataset.skillFileId;
        const pane = id === undefined ? null : paneFor(id);
        if (pane === null || (changedPane instanceof HTMLElement && pane !== changedPane)) {
          continue;
        }
        const name = tab.querySelector(".skill-file-tab__name");
        if (name !== null) {
          name.textContent = panePath(pane) || "New reference";
        }
        const sizeLabel = tab.querySelector("[data-skill-file-tab-size]");
        if (sizeLabel !== null) {
          sizeLabel.textContent = `${bytesOf(paneText(pane))} bytes`;
        }
      }
      if (changedPane === undefined) {
        const select = fileList.querySelector("[data-skill-file-select]");
        if (select instanceof HTMLSelectElement) {
          for (const option of select.options) {
            const pane = paneFor(option.value);
            if (pane !== null) {
              option.textContent = panePath(pane) || "New reference";
            }
          }
        }
      }
    }
    const references = referencePanes();
    let aggregate = 0;
    for (const pane of references) {
      aggregate += paneText(pane).length;
    }
    const aggregateLabel = scope.querySelector("[data-skill-reference-aggregate]");
    if (aggregateLabel !== null) {
      aggregateLabel.textContent = `${references.length} of ${MAX_REFERENCES} files · ${aggregate} of ${MAX_REFERENCE_AGGREGATE} characters`;
    }
    const addButtons = scope.querySelectorAll("[data-skill-add-reference]");
    for (const button of addButtons) {
      button.disabled = references.length >= MAX_REFERENCES;
    }
  }

  function updateFileDots() {
    if (fileList === null) {
      return;
    }
    for (const tab of fileList.querySelectorAll("[data-skill-file-tab]")) {
      const id = tab.dataset.skillFileId;
      const pane = id === undefined ? null : paneFor(id);
      const dot = tab.querySelector("[data-skill-file-dirty]");
      if (dot !== null) {
        dot.hidden = pane === null || !fileDirty(pane);
      }
    }
  }

  function updateDirty() {
    if (!editable) {
      return;
    }
    dirty = JSON.stringify(formState()) !== initialSerialized;
    if (status !== null) {
      status.textContent = dirty ? "Unsaved changes" : "All changes saved";
      status.dataset.state = dirty ? "dirty" : "clean";
    }
    if (save !== null) {
      save.disabled = !dirty || submitting;
    }
    if (discard !== null) {
      discard.disabled = !dirty || submitting;
    }
    root.dataset.dirty = dirty ? "true" : "false";
    updateFileDots();
  }

  function setBusy(busy) {
    submitting = busy;
    if (form !== null) {
      if (busy) {
        form.setAttribute("aria-busy", "true");
      } else {
        form.removeAttribute("aria-busy");
      }
    }
    if (save !== null) {
      save.disabled = busy || !dirty;
      if (busy) {
        save.setAttribute("aria-busy", "true");
      } else {
        save.removeAttribute("aria-busy");
      }
    }
    if (discard !== null) {
      discard.disabled = busy || !dirty;
    }
  }

  function schedulePreview() {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, DEBOUNCE_MS);
  }

  function currentPane() {
    if (activeId !== null) {
      const pane = paneFor(activeId);
      if (pane !== null) {
        return pane;
      }
    }
    return panes()[0] ?? null;
  }

  function frontmatterText(pane) {
    if (pane.dataset.skillFileKind !== "skill") {
      return "";
    }
    const nameInput = scope.querySelector("#skill-name");
    const descriptionInput = scope.querySelector("#skill-description");
    const licenseInput = scope.querySelector("#skill-license");
    const compatibilityInput = scope.querySelector("#skill-compatibility");
    const name = nameInput === null ? "" : nameInput.value.trim();
    const descriptionValue = descriptionInput === null ? "" : descriptionInput.value.trim();
    const license = licenseInput === null ? "" : licenseInput.value.trim();
    const compatibility = compatibilityInput === null ? "" : compatibilityInput.value.trim();
    const lines = ["---"];
    if (name.length > 0) {
      lines.push(`name: ${yamlScalar(name)}`);
    }
    if (descriptionValue.length > 0) {
      lines.push(`description: ${yamlScalar(descriptionValue)}`);
    }
    if (license.length > 0) {
      lines.push(`license: ${yamlScalar(license)}`);
    }
    if (compatibility.length > 0) {
      lines.push(`compatibility: ${yamlScalar(compatibility)}`);
    }
    let metadata = currentMetadata();
    let metadataBroken = false;
    if (rawMetadata !== null && rawMetadata.value.trim().length > 0) {
      const parsed = parseMetadataJson(rawMetadata.value);
      if (parsed.ok) {
        metadata = parsed.value;
      } else {
        metadataBroken = true;
        metadata = {};
      }
    }
    const keys = Object.keys(metadata).sort();
    if (keys.length > 0) {
      lines.push("metadata:");
      for (const key of keys) {
        lines.push(`  ${yamlKey(key)}: ${yamlScalar(metadata[key] ?? "")}`);
      }
    }
    lines.push("---");
    if (
      name.length === 0 &&
      descriptionValue.length === 0 &&
      license.length === 0 &&
      compatibility.length === 0 &&
      keys.length === 0 &&
      !metadataBroken
    ) {
      return "";
    }
    return metadataBroken
      ? { text: lines.join("\n"), broken: true }
      : { text: lines.join("\n"), broken: false };
  }

  function renderFrontmatter(pane) {
    if (!(frontmatterSlot instanceof HTMLElement)) {
      return;
    }
    const generated = frontmatterText(pane);
    const previous = frontmatterSlot.querySelector("details");
    if (previous !== null) {
      frontmatterOpen = previous.open;
    }
    if (generated === "") {
      frontmatterSlot.hidden = true;
      frontmatterSlot.replaceChildren();
      return;
    }
    frontmatterSlot.replaceChildren();
    frontmatterSlot.hidden = false;
    const wrapper = element("details", "skill-frontmatter");
    wrapper.open = frontmatterOpen;
    wrapper.addEventListener("toggle", () => {
      frontmatterOpen = wrapper.open;
    });
    const summary = element("summary", "skill-frontmatter__summary");
    summary.append(element("span", "label", "Frontmatter"));
    summary.append(element("span", "hint", "Generated from Details"));
    summary.append(chevronIcon());
    const body = element("div", "skill-frontmatter__body");
    const pre = element("pre", "skill-frontmatter__pre", generated.text);
    const actions = element("div", "cluster");
    const copy = element("button", "btn btn-ghost btn-sm", "Copy");
    copy.type = "button";
    copy.addEventListener("click", () => {
      copyText(generated.text).then(
        () => {
          copy.textContent = "Copied";
          window.setTimeout(() => {
            copy.textContent = "Copy";
          }, 1200);
        },
        () => {
          copy.textContent = "Copy failed";
          window.setTimeout(() => {
            copy.textContent = "Copy";
          }, 1600);
        },
      );
    });
    actions.append(copy);
    if (generated.broken) {
      actions.append(
        element(
          "span",
          "hint",
          "Metadata needs repair before it can appear in the generated frontmatter.",
        ),
      );
    }
    body.append(pre, actions);
    wrapper.append(summary, body);
    frontmatterSlot.append(wrapper);
  }

  function renderPreview() {
    const pane = currentPane();
    if (pane === null) {
      return;
    }
    const path = panePath(pane) || "New reference";
    if (previewTitle !== null) {
      previewTitle.textContent = path;
    }
    renderFrontmatter(pane);
    preview.replaceChildren();
    const text = paneText(pane);
    if (text.trim().length === 0) {
      preview.append(element("p", "hint", "Nothing to preview yet."));
      return;
    }
    renderMarkdown(preview, text);
  }

  function selectFile(id) {
    const pane = paneFor(id) ?? panes()[0] ?? null;
    if (pane === null) {
      return;
    }
    activeId = pane.dataset.skillFileId ?? null;
    for (const candidate of panes()) {
      candidate.hidden = candidate !== pane;
    }
    updateNavSelection();
    renderPreview();
  }

  function setView(next) {
    view = next === "preview" ? "preview" : "source";
    root.dataset.skillView = view;
    if (viewTabs !== null) {
      for (const tab of viewTabs.querySelectorAll("[data-skill-viewtab]")) {
        const selected = tab.dataset.skillViewtab === view;
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected ? 0 : -1;
      }
    }
  }

  function refreshAll() {
    refreshFileLabels();
    updateFileDots();
    renderPreview();
  }

  function addReference() {
    if (!editable) {
      return;
    }
    const template = scope.querySelector("template[data-skill-reference-template]");
    if (!(template instanceof HTMLTemplateElement)) {
      return;
    }
    const fragment = template.content.cloneNode(true);
    const pane = fragment.querySelector("[data-skill-file]");
    if (!(pane instanceof HTMLElement)) {
      return;
    }
    newReferenceCounter += 1;
    const id = `skill-file-new-${newReferenceCounter}`;
    pane.id = id;
    pane.dataset.skillFileId = id;
    const pathInput = pane.querySelector("[data-skill-reference-path]");
    const content = pane.querySelector("[data-skill-reference-content]");
    if (pathInput instanceof HTMLInputElement) {
      pathInput.disabled = false;
      pathInput.value = "";
    }
    if (content instanceof HTMLTextAreaElement) {
      content.disabled = false;
      content.value = "";
    }
    panesHost.append(fragment);
    ensureFileList();
    syncFileNavigation();
    selectFile(id);
    refreshAll();
    updateDirty();
    if (pathInput instanceof HTMLInputElement) {
      pathInput.focus();
    }
  }

  function removeReference(pane) {
    if (!(pane instanceof HTMLElement)) {
      return;
    }
    const path = panePath(pane) || "this reference file";
    if (!window.confirm(`Remove ${path}? It is deleted when you save.`)) {
      return;
    }
    const wasActive = pane.dataset.skillFileId === activeId;
    pane.remove();
    syncFileNavigation();
    if (wasActive) {
      selectFile(initialSkillPane?.dataset.skillFileId ?? panes()[0]?.dataset.skillFileId ?? "");
    }
    refreshAll();
    updateDirty();
    const activeTab = fileList?.querySelector(
      `[data-skill-file-tab][data-skill-file-id="${activeId}"]`,
    );
    if (activeTab instanceof HTMLElement) {
      activeTab.focus();
    }
  }

  function metadataPlaceholder() {
    const placeholder = element("p", "hint", "No custom metadata keys.");
    placeholder.dataset.skillMetadataEmpty = "";
    return placeholder;
  }

  function metadataRow(key = "", value = "") {
    const template = scope.querySelector("template[data-skill-metadata-template]");
    if (!(template instanceof HTMLTemplateElement)) {
      return null;
    }
    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector("[data-skill-metadata-row]");
    if (!(row instanceof HTMLElement)) {
      return null;
    }
    const keyInput = row.querySelector("[data-skill-metadata-key-input]");
    const valueInput = row.querySelector("[data-skill-metadata-value-input]");
    if (keyInput instanceof HTMLInputElement) {
      keyInput.disabled = false;
      keyInput.value = key;
    }
    if (valueInput instanceof HTMLInputElement) {
      valueInput.disabled = false;
      valueInput.value = value;
    }
    return row;
  }

  function addMetadataRow(key = "", value = "") {
    if (!(customHost instanceof HTMLElement)) {
      return;
    }
    const row = metadataRow(key, value);
    if (row === null) {
      return;
    }
    customHost.querySelector("[data-skill-metadata-empty]")?.remove();
    customHost.append(row);
    refreshAll();
    updateDirty();
    row.querySelector("[data-skill-metadata-key-input]")?.focus();
  }

  function removeMetadataRow(button) {
    const row = button.closest("[data-skill-metadata-row]");
    if (row === null) {
      return;
    }
    row.remove();
    if (customHost instanceof HTMLElement && customHost.querySelector("[data-skill-metadata-row]") === null) {
      customHost.append(metadataPlaceholder());
    }
    refreshAll();
    updateDirty();
    const add = scope.querySelector("[data-skill-add-metadata]");
    if (add instanceof HTMLElement) {
      add.focus();
    }
  }

  function clearMetadata() {
    if (rawMetadata !== null) {
      rawMetadata.value = "";
    }
    if (rawMetadataField !== null) {
      rawMetadataField.hidden = true;
    }
    for (const input of scope.querySelectorAll("[data-skill-metadata-key]")) {
      input.value = "";
    }
    if (customHost instanceof HTMLElement) {
      customHost.replaceChildren(metadataPlaceholder());
    }
    refreshAll();
    updateDirty();
    const add = scope.querySelector("[data-skill-add-metadata]");
    if (add instanceof HTMLElement) {
      add.focus();
    }
  }

  function renderCustomRows(rows) {
    if (!(customHost instanceof HTMLElement)) {
      return;
    }
    customHost.replaceChildren();
    if (rows.length === 0) {
      customHost.append(metadataPlaceholder());
      return;
    }
    for (const [key, value] of rows) {
      const row = metadataRow(key, value);
      if (row !== null) {
        customHost.append(row);
      }
    }
  }

  function resetToInitial() {
    if (!editable) {
      return;
    }
    clearErrors();
    if (description !== null) {
      description.value = initialState.description;
    }
    const content = scope.querySelector("#skill-content");
    if (content !== null) {
      content.value = initialState.content;
    }
    if (enabledCheck !== null) {
      enabledCheck.checked = initialState.enabled;
    }
    const license = scope.querySelector("#skill-license");
    if (license !== null) {
      license.value = initialState.license;
    }
    const compatibility = scope.querySelector("#skill-compatibility");
    if (compatibility !== null) {
      compatibility.value = initialState.compatibility;
    }
    for (const input of scope.querySelectorAll("[data-skill-metadata-key]")) {
      input.value = "";
    }
    for (const [key, value] of initialState.known) {
      const input = scope.querySelector(`[data-skill-metadata-key="${key}"]`);
      if (input !== null) {
        input.value = value;
      }
    }
    renderCustomRows(initialState.custom);
    if (rawMetadata !== null) {
      rawMetadata.value = initialState.metadataRaw ?? "";
    }
    if (rawMetadataField !== null) {
      rawMetadataField.hidden = false;
    }
    for (const pane of referencePanes()) {
      pane.remove();
    }
    if (initialHadFileList) {
      ensureFileList();
    } else if (fileList !== null) {
      fileList.remove();
      fileList = null;
    }
    if (initialSkillPane !== null) {
      const skillContent = initialSkillPane.querySelector("#skill-content");
      if (skillContent !== null) {
        skillContent.value = initialState.content;
      }
      if (!panesHost.contains(initialSkillPane)) {
        panesHost.append(initialSkillPane);
      }
    }
    for (const entry of initialReferencePanes) {
      if (entry.pathInput instanceof HTMLInputElement) {
        entry.pathInput.value = entry.path;
      }
      if (entry.textarea instanceof HTMLTextAreaElement) {
        entry.textarea.value = entry.content;
      }
      entry.node.dataset.skillFilePath = entry.path;
      panesHost.append(entry.node);
    }
    if (bundleInput !== null) {
      bundleInput.value = initialBundleRaw;
    }
    if (fileList !== null) {
      syncFileNavigation();
    }
    setView("source");
    selectFile(initialSkillPane?.dataset.skillFileId ?? panes()[0]?.dataset.skillFileId ?? "");
    refreshAll();
    updateDirty();
    if (description !== null) {
      description.focus();
    }
  }

  function fieldTarget(field) {
    switch (field) {
      case "description":
        return scope.querySelector("#skill-description");
      case "content":
        return scope.querySelector("#skill-content");
      case "name":
        return scope.querySelector("#skill-name");
      case "license":
        return scope.querySelector("#skill-license");
      case "compatibility":
        return scope.querySelector("#skill-compatibility");
      case "metadata":
        return rawMetadata ?? scope.querySelector("[data-skill-metadata-key]");
      case "references":
        return (
          scope.querySelector("[data-skill-reference-path]") ??
          scope.querySelector("[data-skill-reference-content]") ??
          scope.querySelector("#skill-references")
        );
      case "confirm_name":
        return scope.querySelector("#skill-confirm-name");
      default:
        return null;
    }
  }

  function clearErrors() {
    for (const entry of clientErrors) {
      entry.node.remove();
      entry.target.removeAttribute("aria-invalid");
      if (entry.describedBy === null) {
        entry.target.removeAttribute("aria-describedby");
      } else {
        entry.target.setAttribute("aria-describedby", entry.describedBy);
      }
    }
    clientErrors = [];
    scope.querySelector("[data-skill-client-error]")?.remove();
  }

  function showFormError(message) {
    let summary = scope.querySelector("[data-skill-client-error]");
    if (summary === null) {
      summary = element("div", "settings-warning");
      summary.dataset.skillClientError = "";
      summary.setAttribute("role", "alert");
      summary.append(element("p", "settings-warning__title", message));
      scope.prepend(summary);
    } else {
      const title = summary.querySelector(".settings-warning__title");
      if (title !== null) {
        title.textContent = message;
      }
    }
  }

  function showFieldError(field, message) {
    const target = fieldTarget(field);
    if (!(target instanceof HTMLElement)) {
      showFormError(message);
      return;
    }
    const id = `skill-client-error-${field}-${clientErrors.length}`;
    const error = element("p", "field-error", message);
    error.id = id;
    error.dataset.clientError = "";
    error.setAttribute("role", "alert");
    target.insertAdjacentElement("afterend", error);
    const describedBy = target.getAttribute("aria-describedby");
    const parts = describedBy === null ? [] : describedBy.split(/\s+/).filter(Boolean);
    if (!parts.includes(id)) {
      parts.push(id);
    }
    target.setAttribute("aria-describedby", parts.join(" "));
    target.setAttribute("aria-invalid", "true");
    clientErrors.push({
      node: error,
      target,
      describedBy: describedBy === null || describedBy.trim().length === 0 ? null : describedBy,
    });
  }

  function focusFirstInvalid() {
    const target = scope.querySelector('[aria-invalid="true"]');
    if (target instanceof HTMLElement) {
      if (target.matches("input, textarea, select, button, a, [tabindex]")) {
        target.focus();
        return;
      }
      const focusable = target.querySelector("input, textarea, select, button, a, [tabindex]");
      if (focusable instanceof HTMLElement) {
        focusable.focus();
        return;
      }
    }
    const summary = scope.querySelector("[data-skill-client-error]");
    if (summary instanceof HTMLElement) {
      summary.tabIndex = -1;
      summary.focus();
    }
  }

  function validateBeforeSubmit() {
    if (rawMetadata !== null) {
      const rawValue = rawMetadata.value;
      const changed = rawValue !== initialRawMetadata;
      if (rawValue.trim().length > 0 && changed && !parseMetadataJson(rawValue).ok) {
        showFieldError(
          "metadata",
          "Metadata must be a JSON object whose values are strings, or cleared before saving.",
        );
        focusFirstInvalid();
        return false;
      }
    }
    const references = referenceValues();
    if (references.length > MAX_REFERENCES) {
      showFieldError("references", `Use at most ${MAX_REFERENCES} reference files.`);
      focusFirstInvalid();
      return false;
    }
    let aggregate = 0;
    for (const reference of references) {
      if (reference.path.length === 0) {
        showFieldError(
          "references",
          "A reference with content needs a canonical references/<slug>.md path.",
        );
        const firstPath = referencePanes().find((pane) => panePath(pane).length === 0);
        firstPath?.querySelector("[data-skill-reference-path]")?.focus();
        return false;
      }
      if (!REFERENCE_PATH.test(reference.path)) {
        showFieldError(
          "references",
          "Reference paths look like references/<slug>.md using lowercase letters, digits, and hyphens.",
        );
        const invalid = referencePanes().find((pane) => !REFERENCE_PATH.test(panePath(pane)));
        invalid?.querySelector("[data-skill-reference-path]")?.focus();
        return false;
      }
      if (reference.content.length > MAX_REFERENCE_CONTENT) {
        showFieldError(
          "references",
          `Each reference file is limited to ${MAX_REFERENCE_CONTENT} characters.`,
        );
        focusFirstInvalid();
        return false;
      }
      aggregate += reference.content.length;
    }
    if (aggregate > MAX_REFERENCE_AGGREGATE) {
      showFieldError(
        "references",
        `Reference files are limited to ${MAX_REFERENCE_AGGREGATE} characters in total.`,
      );
      focusFirstInvalid();
      return false;
    }
    return true;
  }

  function bundlePayload() {
    const license = scope.querySelector("#skill-license")?.value.trim() ?? "";
    const compatibility = scope.querySelector("#skill-compatibility")?.value.trim() ?? "";
    const references = referenceValues();
    let metadata = currentMetadata();
    let metadataRaw;
    if (rawMetadata !== null) {
      const rawValue = rawMetadata.value;
      if (rawValue.trim().length > 0) {
        const parsed = parseMetadataJson(rawValue);
        if (parsed.ok && rawValue !== initialRawMetadata) {
          metadata = parsed.value;
        } else {
          metadata = {};
          metadataRaw = rawValue;
        }
      }
    }
    const bundle = {
      license: license.length === 0 ? null : license,
      compatibility: compatibility.length === 0 ? null : compatibility,
      metadata,
      references,
    };
    if (metadataRaw !== undefined) {
      bundle.metadataRaw = metadataRaw;
    }
    if (initialPreserveInvalid) {
      bundle.preserveInvalid = true;
    }
    return bundle;
  }

  function submitPayload(action) {
    const bundle = bundlePayload();
    if (bundleInput !== null) {
      bundleInput.value = JSON.stringify(bundle);
    }
    const payload = {
      action,
      return_to: scope.querySelector('input[name="return_to"]')?.value ?? "",
      description: description === null ? "" : description.value,
      content: scope.querySelector("#skill-content")?.value ?? "",
      enabled: enabledCheck === null ? false : enabledCheck.checked,
      ...bundle,
    };
    if (form !== null && form.dataset.skillMode === "create") {
      payload.name = scope.querySelector("#skill-name")?.value ?? "";
      const scopeInput = form.querySelector('input[name="scope"]');
      if (scopeInput !== null) {
        payload.scope = scopeInput.value;
      }
      const projectInput = form.querySelector('input[name="project"]');
      if (projectInput !== null) {
        payload.project = projectInput.value;
      }
      const appInput = form.querySelector('input[name="app"]');
      if (appInput !== null) {
        payload.app = appInput.value;
      }
    }
    return payload;
  }

  function returnedWorkspace(action, data) {
    const returnTo = scope.querySelector('input[name="return_to"]')?.value ?? "";
    const id = data?.skill?.id;
    if (action === "create" && Number.isSafeInteger(id)) {
      return `/skills/${id}`;
    }
    if (returnTo.length > 0) {
      return returnTo;
    }
    return Number.isSafeInteger(id) ? `/skills/${id}` : "/skills";
  }

  async function handleResponse(response, action) {
    let data = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }
    if (response.status === 401) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (response.ok) {
      if (!contentType.includes("application/json") && data === null) {
        window.location.assign(returnedWorkspace(action, null));
        return;
      }
      dirty = false;
      updateDirty();
      window.location.assign(
        withNotice(
          returnedWorkspace(action, data),
          action === "create" ? "Skill created." : "Skill saved.",
          "success",
        ),
      );
      return;
    }
    if (response.status === 400 || response.status === 409 || response.status === 422) {
      if (response.status === 409) {
        showFieldError("name", "A skill with this name already exists at this scope.");
      } else if (typeof data?.field === "string") {
        showFieldError(data.field, typeof data.error === "string" ? data.error : "Check this field.");
      } else {
        showFormError(
          typeof data?.error === "string" ? data.error : "The skill could not be saved.",
        );
      }
      focusFirstInvalid();
      return;
    }
    showFormError("The skill could not be saved. Try again.");
  }

  async function handleSubmit(event) {
    if (!editable || form === null) {
      return;
    }
    const submitter = event.submitter;
    if (submitter instanceof HTMLElement && submitter.matches("[data-skill-discard]")) {
      event.preventDefault();
      resetToInitial();
      return;
    }
    if (submitter instanceof HTMLElement && !submitter.matches("[data-skill-save]")) {
      return;
    }
    event.preventDefault();
    if (!dirty || submitting) {
      return;
    }
    clearErrors();
    if (!validateBeforeSubmit()) {
      return;
    }
    const action = form.dataset.skillMode === "create" ? "create" : "update";
    const payload = submitPayload(action);
    setBusy(true);
    try {
      const actionUrl = form.getAttribute("action") ?? window.location.href;
      const response = await fetch(actionUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
      });
      await handleResponse(response, action);
    } catch {
      showFormError("The skill could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) {
      return;
    }
    const guideLink = target.closest("[data-skill-guide-open]");
    if (guideLink !== null) {
      const guide = scope.querySelector("[data-skill-field-guide]");
      if (guide instanceof HTMLDetailsElement) {
        guide.open = true;
      }
      return;
    }
    const fileTab = target.closest("[data-skill-file-tab]");
    if (fileTab !== null) {
      event.preventDefault();
      selectFile(fileTab.dataset.skillFileId ?? "");
      return;
    }
    const viewTab = target.closest("[data-skill-viewtab]");
    if (viewTab !== null) {
      event.preventDefault();
      setView(viewTab.dataset.skillViewtab);
      return;
    }
    const addReferenceButton = target.closest("[data-skill-add-reference]");
    if (addReferenceButton !== null) {
      event.preventDefault();
      addReference();
      return;
    }
    const removeReferenceButton = target.closest("[data-skill-remove-reference]");
    if (removeReferenceButton !== null) {
      event.preventDefault();
      const pane = removeReferenceButton.closest("[data-skill-file]");
      if (pane !== null) {
        removeReference(pane);
      }
      return;
    }
    const addMetadataButton = target.closest("[data-skill-add-metadata]");
    if (addMetadataButton !== null) {
      event.preventDefault();
      addMetadataRow();
      return;
    }
    const removeMetadataButton = target.closest("[data-skill-remove-metadata]");
    if (removeMetadataButton !== null) {
      event.preventDefault();
      removeMetadataRow(removeMetadataButton);
      return;
    }
    const clearMetadataButton = target.closest("[data-skill-clear-metadata]");
    if (clearMetadataButton !== null) {
      event.preventDefault();
      clearMetadata();
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (target.matches("[data-skill-reference-path]") && target instanceof HTMLInputElement) {
      const pane = target.closest("[data-skill-file]");
      if (pane !== null) {
        pane.dataset.skillFilePath = target.value.trim();
      }
      if (fileList !== null) {
        syncFileNavigation();
      }
    }
    schedulePreview();
    const pane = target.closest("[data-skill-file]");
    refreshFileLabels(pane instanceof HTMLElement ? pane : null);
    updateDirty();
  }

  function handleChange(event) {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.matches("[data-skill-file-select]")) {
      selectFile(target.value);
      return;
    }
    updateDirty();
    schedulePreview();
  }

  function handleKeydown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) {
      return;
    }
    const fileTab = target.closest("[data-skill-file-tab]");
    if (fileTab !== null && event.key.startsWith("Arrow")) {
      const tabs = Array.from(
        fileList === null ? [] : fileList.querySelectorAll("[data-skill-file-tab]"),
      );
      const index = tabs.indexOf(fileTab);
      if (index < 0) {
        return;
      }
      let next = index;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        next = (index + 1) % tabs.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        next = (index - 1 + tabs.length) % tabs.length;
      } else {
        return;
      }
      event.preventDefault();
      const nextTab = tabs[next];
      if (nextTab instanceof HTMLElement) {
        selectFile(nextTab.dataset.skillFileId ?? "");
        nextTab.focus();
      }
      return;
    }
    const viewTab = target.closest("[data-skill-viewtab]");
    if (viewTab !== null && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      setView(view === "source" ? "preview" : "source");
      const next = viewTabs?.querySelector(
        `[data-skill-viewtab="${view}"]`,
      );
      if (next instanceof HTMLElement) {
        next.focus();
      }
    }
  }

  function upgradeStaticPanes() {
    for (const pane of panes()) {
      const content = pane.querySelector("[data-skill-reference-content]");
      if (editable && content instanceof HTMLTextAreaElement) {
        content.disabled = false;
      }
    }
    if (!editable) {
      return;
    }
    for (const control of scope.querySelectorAll(
      "[data-skill-details] input:disabled, [data-skill-details] textarea:disabled, [data-skill-details] select:disabled",
    )) {
      if (control instanceof HTMLInputElement && control.readOnly) {
        continue;
      }
      if (control instanceof HTMLElement) {
        control.removeAttribute("disabled");
      }
    }
    for (const control of scope.querySelectorAll(
      "[data-skill-custom-metadata] input:disabled",
    )) {
      control.removeAttribute("disabled");
    }
  }

  function initialDetailsState() {
    if (!(details instanceof HTMLDetailsElement) || !editable) {
      return;
    }
    if (window.location.hash.startsWith("#skill-")) {
      details.open = true;
      return;
    }
    if (
      window.matchMedia("(max-width: 767px)").matches &&
      details.querySelector("[aria-invalid='true'], .field-error") === null
    ) {
      details.open = false;
    }
  }

  const initialState = formState();
  initialSerialized = JSON.stringify(initialState);
  initialRawMetadata = rawMetadata === null ? "" : rawMetadata.value;
  initialBundleRaw = bundleInput instanceof HTMLInputElement ? bundleInput.value : "";
  if (initialBundleRaw.length > 0) {
    try {
      initialPreserveInvalid = JSON.parse(initialBundleRaw).preserveInvalid === true;
    } catch {
      initialPreserveInvalid = false;
    }
  }

  ensureIds();
  captureInitialPanes();
  upgradeStaticPanes();
  initialDetailsState();

  // Capture again after enabling controls so disabled state cannot affect values.
  const capturedState = formState();
  initialSerialized = JSON.stringify(capturedState);

  if (viewTabs instanceof HTMLElement) {
    viewTabs.hidden = false;
    panesHost.setAttribute("role", "tabpanel");
    panesHost.setAttribute("aria-labelledby", "skill-viewtab-source");
    previewPane.setAttribute("role", "tabpanel");
    previewPane.setAttribute("aria-labelledby", "skill-viewtab-preview");
  }
  if (fileList !== null) {
    const picker = fileList.querySelector("[data-skill-file-picker]");
    if (picker instanceof HTMLElement) {
      picker.hidden = false;
    }
  }
  root.dataset.skillEnhanced = "true";
  setView("source");
  if (fileList !== null) {
    syncFileNavigation();
  }
  selectFile(panes()[0]?.dataset.skillFileId ?? "");
  refreshAll();
  updateDirty();

  scope.addEventListener("click", handleClick);
  scope.addEventListener("input", handleInput);
  scope.addEventListener("change", handleChange);
  scope.addEventListener("keydown", handleKeydown);
  if (editable && form !== null) {
    form.addEventListener("submit", handleSubmit);
    window.addEventListener("beforeunload", (event) => {
      if (!dirty || submitting) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    });
  }
  document.addEventListener("submit", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) {
      return;
    }
    const message = target.dataset.skillConfirm;
    if (message !== undefined && !window.confirm(message)) {
      event.preventDefault();
    }
  });
}

onReady(init);
