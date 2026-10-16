/** An application registered with the coordinator. */
export interface RegisteredApp {
  projectId: string;
  app: string;
  path: string;
  kind?: string;
}

export interface AppRegistry {
  list(): RegisteredApp[];
  get(app: string): RegisteredApp | undefined;
  register(app: RegisteredApp): void;
}

/** In-memory registry. TODO(persistence): back this by the coordinator runtime root so it survives restarts. */
export class InMemoryAppRegistry implements AppRegistry {
  readonly #apps = new Map<string, RegisteredApp>();

  list(): RegisteredApp[] {
    return [...this.#apps.values()];
  }

  get(app: string): RegisteredApp | undefined {
    return this.#apps.get(app);
  }

  register(app: RegisteredApp): void {
    this.#apps.set(app.app, app);
  }
}
