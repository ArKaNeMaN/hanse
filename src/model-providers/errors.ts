import type { ModelProviderReference } from "./types.js";

/** A provider input or stored-row validation failure; HTTP callers map it to 400. */
export class ModelProviderValidationError extends Error {
  readonly code = "VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "ModelProviderValidationError";
  }
}

/** A create/update id conflict; HTTP callers map it to 409 `provider_exists`. */
export class ModelProviderConflictError extends Error {
  readonly code = "provider_exists";

  constructor(message = "a custom provider with this id already exists") {
    super(message);
    this.name = "ModelProviderConflictError";
  }
}

/** An unknown provider id; HTTP callers map it to 404 `provider_not_found`. */
export class ModelProviderNotFoundError extends Error {
  readonly code = "provider_not_found";

  constructor(message = "custom provider not found") {
    super(message);
    this.name = "ModelProviderNotFoundError";
  }
}

/** A provider still referenced by an `llm.model` row; HTTP callers map it to 409. */
export class ModelProviderInUseError extends Error {
  readonly code = "provider_in_use";
  readonly references: readonly ModelProviderReference[];

  constructor(provider: string, references: readonly ModelProviderReference[]) {
    super(
      `custom provider "${provider}" is still referenced by ${references.length} llm.model setting(s); change those models before deleting it`,
    );
    this.name = "ModelProviderInUseError";
    this.references = references;
  }
}
