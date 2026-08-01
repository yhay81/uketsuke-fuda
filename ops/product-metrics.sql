WITH all_events AS (
  SELECT COUNT(CASE WHEN is_qa = 1 THEN 1 END) AS qa_rows FROM product_events
),
real_funnel AS (
  SELECT
    COUNT(DISTINCT CASE WHEN name = 'visited' THEN session_id END) AS users,
    COUNT(DISTINCT CASE WHEN name = 'event_created' THEN session_id END) AS creators,
    COUNT(DISTINCT CASE WHEN name = 'event_created' THEN event_id END) AS events_created,
    COUNT(DISTINCT CASE WHEN name = 'reservation_created' THEN session_id END) AS reservers,
    COUNT(DISTINCT CASE WHEN name = 'reservation_created' THEN event_id END) AS events_reserved,
    COUNT(DISTINCT CASE WHEN name = 'event_managed' THEN session_id END) AS event_managers,
    COUNT(DISTINCT CASE WHEN name = 'reservation_managed' THEN session_id END) AS reservation_managers,
    COUNT(DISTINCT CASE WHEN name = 'roster_exported' THEN session_id END) AS exporters,
    COUNT(DISTINCT CASE WHEN name = 'returned' THEN session_id END) AS returned,
    COUNT(DISTINCT CASE WHEN name = 'event_created' AND created_at >= unixepoch() - 604800 THEN event_id END) AS created_7d,
    COUNT(DISTINCT CASE WHEN name = 'reservation_created' AND created_at >= unixepoch() - 604800 THEN session_id END) AS reservers_7d
  FROM product_events WHERE is_qa = 0
),
live_events AS (
  SELECT
    COUNT(CASE WHEN status = 'open' AND expires_at > unixepoch() THEN 1 END) AS open_events,
    COUNT(CASE WHEN status = 'closed' AND expires_at > unixepoch() THEN 1 END) AS closed_events,
    COUNT(CASE WHEN status = 'hidden' AND expires_at > unixepoch() THEN 1 END) AS hidden_events
  FROM events
),
reservation_state AS (
  SELECT
    COUNT(CASE WHEN status = 'reserved' THEN 1 END) AS reserved_rows,
    COUNT(CASE WHEN status = 'checked_in' THEN 1 END) AS checked_in_rows,
    COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled_rows,
    COALESCE(SUM(CASE WHEN status IN ('reserved','checked_in') THEN quantity ELSE 0 END),0) AS reserved_seats
  FROM reservations
),
reports AS (SELECT COUNT(*) AS reports FROM content_reports)
SELECT real_funnel.*, all_events.qa_rows, live_events.*, reservation_state.*, reports.reports
FROM real_funnel CROSS JOIN all_events CROSS JOIN live_events CROSS JOIN reservation_state CROSS JOIN reports;
