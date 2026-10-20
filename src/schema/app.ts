import { z } from "zod";

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 && !value.includes("\0") && !isAbsolutePath(value) && !hasParentSegment(value)
  );
}

const buildArgKeySchema = z
  .string()
  .min(1)
  .refine((key) => !key.includes("\0"), "build arg names must not contain NUL");

const buildArgValueSchema = z
  .string()
  .refine((value) => !value.includes("\0"), "build arg values must not contain NUL");

/** Optional per-app image build declaration. */
export const appBuildSchema = z.object({
  /** Dockerfile path relative to the application directory (defaults to `Dockerfile`). */
  dockerfile: z
    .string()
    .refine(isSafeRelativePath, "build.dockerfile must be a relative path inside the app")
    .default("Dockerfile"),
  /** Build arguments passed to the Docker build; sorted into the build spec hash. */
  args: z.record(buildArgKeySchema, buildArgValueSchema).optional(),
});

/** Schema for `.hanse/app.yaml` - a single application descriptor. */
export const appSchema = z.object({
  /** Application key: a portable string name. */
  name: z.string().min(1),
  /** Free-form kind or category (for example `web` or `service`). */
  kind: z.string().min(1).optional(),
  /** Path to the interface or contract document (defaults to `AGENTS.md`). */
  contract: z.string().min(1).default("AGENTS.md"),
  /** Named development ports. */
  ports: z.record(z.string(), z.number().int().min(0).max(65535)).optional(),
  /** Optional setup command or script path. */
  setup: z.string().min(1).optional(),
  /** Optional image build declaration; a full Dockerfile for the app environment. */
  build: appBuildSchema.optional(),
});

export type App = z.infer<typeof appSchema>;
export type AppInput = z.input<typeof appSchema>;

export function parseApp(input: unknown): App {
  return appSchema.parse(input);
}

export function safeParseApp(input: unknown) {
  return appSchema.safeParse(input);
}
