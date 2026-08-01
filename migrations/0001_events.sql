PRAGMA foreign_keys = ON;

CREATE TABLE events (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  manager_token_hash TEXT NOT NULL CHECK(length(manager_token_hash) = 64),
  creator_session_id TEXT NOT NULL CHECK(length(creator_session_id) = 36),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 50),
  kind TEXT NOT NULL CHECK(kind IN ('live', 'stage', 'talk', 'market', 'other')),
  venue TEXT NOT NULL CHECK(length(venue) BETWEEN 1 AND 50),
  starts_at INTEGER NOT NULL,
  doors_at INTEGER NOT NULL,
  price_note TEXT NOT NULL DEFAULT '' CHECK(length(price_note) <= 30),
  capacity INTEGER NOT NULL DEFAULT 0 CHECK(capacity BETWEEN 0 AND 500),
  max_per_reservation INTEGER NOT NULL DEFAULT 4 CHECK(max_per_reservation BETWEEN 1 AND 10),
  routes_json TEXT NOT NULL DEFAULT '[]' CHECK(length(routes_json) <= 330),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 160),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX events_status_idx ON events(status, starts_at, expires_at);
CREATE INDEX events_creator_idx ON events(creator_session_id, created_at DESC);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  manager_token_hash TEXT NOT NULL CHECK(length(manager_token_hash) = 64),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 30),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 10),
  route_name TEXT NOT NULL DEFAULT '' CHECK(length(route_name) <= 40),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 80),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'checked_in', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX reservations_event_idx ON reservations(event_id, status, created_at);
CREATE INDEX reservations_session_idx ON reservations(session_id, created_at DESC);

CREATE TABLE content_reports (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  reason TEXT NOT NULL CHECK(reason IN ('misleading', 'unsafe', 'spam', 'other')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(event_id, session_id)
);

CREATE TABLE product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(name IN ('visited', 'event_created', 'reservation_created', 'event_managed', 'reservation_managed', 'roster_exported', 'returned')),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  event_id TEXT NOT NULL DEFAULT '' CHECK(length(event_id) IN (0, 32)),
  day TEXT NOT NULL CHECK(length(day) = 10),
  created_at INTEGER NOT NULL,
  is_qa INTEGER NOT NULL DEFAULT 0 CHECK(is_qa IN (0, 1)),
  UNIQUE(name, session_id, event_id, day)
);

CREATE INDEX product_events_day_idx ON product_events(day, name, is_qa);
