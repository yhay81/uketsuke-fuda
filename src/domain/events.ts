export const eventKinds = ["live", "stage", "talk", "market", "other"] as const;
export type EventKind = (typeof eventKinds)[number];

export const eventStatuses = ["open", "closed", "hidden"] as const;
export type EventStatus = (typeof eventStatuses)[number];

export const reservationStatuses = ["reserved", "checked_in", "cancelled"] as const;
export type ReservationStatus = (typeof reservationStatuses)[number];

const kindSet = new Set<string>(eventKinds);
const eventStatusSet = new Set<string>(eventStatuses);
const reservationStatusSet = new Set<string>(reservationStatuses);

export const isEventKind = (value: string): value is EventKind => kindSet.has(value);
export const isEventStatus = (value: string): value is EventStatus => eventStatusSet.has(value);
export const isReservationStatus = (value: string): value is ReservationStatus =>
  reservationStatusSet.has(value);

export const parseRoutes = (value: string) =>
  value
    .split("\n")
    .map((route) => route.trim())
    .filter(Boolean);

export const seatsRemaining = (capacity: number, reserved: number) =>
  capacity === 0 ? null : Math.max(0, capacity - reserved);

export const expiryForEvent = (startsAt: number) => startsAt + 7 * 86400;
