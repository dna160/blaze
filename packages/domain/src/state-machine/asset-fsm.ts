import { StateMachine, type Transition } from "./fsm.js";

export type AssetStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "MAINTENANCE" | "RETIRED";

export type AssetEvent =
  | "RESERVE"
  | "RESERVATION_RELEASED"
  | "MOVE_IN"
  | "MOVE_OUT"
  | "SET_MAINTENANCE"
  | "RETURN_TO_SERVICE"
  | "RETIRE";

/**
 * "MAINTENANCE and RETIRED reachable from any state by admin action
 * (occupied assets require lease resolution first)" (PRD §8.3) — note
 * OCCUPIED deliberately has no direct path to MAINTENANCE/RETIRED; the
 * booking must MOVE_OUT first.
 */
const TRANSITIONS: ReadonlyArray<Transition<AssetStatus, AssetEvent, void>> = [
  { from: "AVAILABLE", event: "RESERVE", to: "RESERVED" },
  { from: "RESERVED", event: "RESERVATION_RELEASED", to: "AVAILABLE" },
  { from: "RESERVED", event: "MOVE_IN", to: "OCCUPIED" },
  { from: "OCCUPIED", event: "MOVE_OUT", to: "AVAILABLE" },
  { from: ["AVAILABLE", "RESERVED"], event: "SET_MAINTENANCE", to: "MAINTENANCE" },
  { from: ["AVAILABLE", "RESERVED"], event: "RETIRE", to: "RETIRED" },
  { from: "MAINTENANCE", event: "RETURN_TO_SERVICE", to: "AVAILABLE" },
  { from: "MAINTENANCE", event: "RETIRE", to: "RETIRED" },
];

export const assetFsm = new StateMachine<AssetStatus, AssetEvent, void>(TRANSITIONS);
