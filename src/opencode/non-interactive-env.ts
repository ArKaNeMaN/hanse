/**
 * Environment that keeps agent-spawned tooling from blocking on a TTY.
 *
 * OMO 5.1.35 ships a `non-interactive-env` hook that prepends the same values as an
 * `export ...;` prefix on commands containing a `git` word. That prefix is persisted in the
 * tool-call history, so later turns replay it and the model starts copying it onto unrelated
 * commands. Hanse injects the values into the opencode process environment instead: every child
 * process inherits them, no command string changes, and the hook is disabled in the baked
 * `omo/omo.jsonc`.
 *
 * `CI` is deliberately absent. It changes test/build tool behavior globally and is not needed to
 * prevent interactive hangs; the targeted variables below cover git, apt, npm, pip, and yarn.
 */
export const NON_INTERACTIVE_SHELL_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_PAGER: "cat",
  PAGER: "cat",
  EDITOR: ":",
  VISUAL: "",
  DEBIAN_FRONTEND: "noninteractive",
  npm_config_yes: "true",
  PIP_NO_INPUT: "1",
  YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
});
