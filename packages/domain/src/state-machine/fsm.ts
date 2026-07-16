/**
 * Small, hand-rolled typed finite-state machine.
 *
 * We deliberately did not reach for xstate here: the PRD's guard rails
 * (e.g. Booking APPROVED -> ACTIVE requires contract-signed AND
 * first-invoice-paid AND unit-assigned, all three, checked atomically at
 * transition time) need async guards that read live DB state. That fits a
 * plain async predicate far more simply than xstate's actor/service model,
 * without pulling in a dependency whose bulk of features (parallel states,
 * spawned actors, visualizer) we would not use. See docs/HANDOFF.md
 * "Architectural decisions" for the record of this choice.
 */

export class IllegalTransitionError extends Error {
  constructor(
    public readonly currentState: string,
    public readonly event: string,
  ) {
    super(`Illegal transition: no path for event "${event}" from state "${currentState}".`);
    this.name = "IllegalTransitionError";
  }
}

export class GuardFailedError extends Error {
  constructor(
    public readonly currentState: string,
    public readonly event: string,
    reason?: string,
  ) {
    super(
      `Guard failed for event "${event}" from state "${currentState}"${reason ? `: ${reason}` : "."}`,
    );
    this.name = "GuardFailedError";
  }
}

export interface Transition<S extends string, E extends string, Ctx> {
  from: S | readonly S[];
  event: E;
  to: S;
  /** Must resolve true for the transition to be allowed. Evaluated at fire-time, not registration-time. */
  guard?: (ctx: Ctx) => Promise<boolean> | boolean;
  guardFailureMessage?: string;
}

export interface FireResult<S extends string> {
  from: S;
  to: S;
}

export class StateMachine<S extends string, E extends string, Ctx = void> {
  constructor(private readonly transitions: ReadonlyArray<Transition<S, E, Ctx>>) {}

  private matches(transition: Transition<S, E, Ctx>, current: S, event: E): boolean {
    if (transition.event !== event) return false;
    return Array.isArray(transition.from) ? transition.from.includes(current) : transition.from === current;
  }

  /** Non-throwing check: is this transition structurally legal (ignoring guards)? */
  canTransition(current: S, event: E): boolean {
    return this.transitions.some((t) => this.matches(t, current, event));
  }

  /** All events that are structurally legal from the given state, ignoring guards. */
  availableEvents(current: S): E[] {
    return this.transitions.filter((t) => this.matchesState(t, current)).map((t) => t.event);
  }

  private matchesState(transition: Transition<S, E, Ctx>, current: S): boolean {
    return Array.isArray(transition.from) ? transition.from.includes(current) : transition.from === current;
  }

  /**
   * Evaluates guards and returns the target state without mutating anything —
   * callers own persistence. Throws IllegalTransitionError /
   * GuardFailedError rather than returning a result union, because an
   * illegal transition is a bug (caller code path error), not a business
   * outcome the caller should have to branch on.
   */
  async fire(current: S, event: E, ctx: Ctx): Promise<FireResult<S>> {
    const transition = this.transitions.find((t) => this.matches(t, current, event));
    if (!transition) {
      throw new IllegalTransitionError(current, event);
    }
    if (transition.guard) {
      const ok = await transition.guard(ctx);
      if (!ok) {
        throw new GuardFailedError(current, event, transition.guardFailureMessage);
      }
    }
    return { from: current, to: transition.to };
  }
}
