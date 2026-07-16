export class BookingModelNotImplementedError extends Error {
  constructor(kind: string, method: string) {
    super(
      `${kind}.${method}() is not implemented yet — Phase 3 scope (PRD §13). ` +
        `The strategy is registered and type-checks against BookingModelStrategy today ` +
        `specifically to prove the vertical is a config/strategy addition, not a fork.`,
    );
    this.name = "BookingModelNotImplementedError";
  }
}
