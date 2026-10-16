import { z } from "zod";

/** A single application entry inside a project manifest (`.hanse/project.yaml`). */
export const projectAppSchema = z.object({
  /** Path to the application, relative to the project root. */
  path: z.string().min(1),
  /** Git remote to clone or update the application from. */
  remote: z.string().min(1).optional(),
  /** Free-form kind or category (for example `web` or `service`). */
  kind: z.string().min(1).optional(),
});

export type ProjectApp = z.infer<typeof projectAppSchema>;

/** Schema for `.hanse/project.yaml`. */
export const projectSchema = z.object({
  /** Stable project identifier used to key runtime state. */
  id: z.string().uuid(),
  /** Human-readable project name. */
  name: z.string().min(1),
  /** Base branch used for worktrees (defaults to `main`). */
  base_branch: z.string().min(1).default("main"),
  /** Paths to shared documentation and contracts. */
  shared: z.array(z.string().min(1)).optional(),
  /** Applications that belong to this project. */
  apps: z.array(projectAppSchema),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectInput = z.input<typeof projectSchema>;

export function parseProject(input: unknown): Project {
  return projectSchema.parse(input);
}

export function safeParseProject(input: unknown) {
  return projectSchema.safeParse(input);
}
