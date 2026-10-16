import { z } from "zod";

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
});

export type App = z.infer<typeof appSchema>;
export type AppInput = z.input<typeof appSchema>;

export function parseApp(input: unknown): App {
  return appSchema.parse(input);
}

export function safeParseApp(input: unknown) {
  return appSchema.safeParse(input);
}
