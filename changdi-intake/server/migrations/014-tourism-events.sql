CREATE TABLE tourism_events (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL CHECK (
        length(source_id) BETWEEN 1 AND 48 AND source_id GLOB '[a-z]*' AND source_id NOT GLOB '*[^a-z0-9_-]*'
    ),
    evidence TEXT NOT NULL CHECK (evidence IN ('demo', 'operational')),
    type TEXT NOT NULL CHECK (type IN (
        'route_exposed', 'route_adopted', 'route_completed_self_reported', 'guide_played',
        'booking_demo_submitted', 'parking_advice_adopted', 'parking_navigation_clicked',
        'booking_requested', 'booking_confirmed', 'booking_cancelled', 'parking_arrival_verified'
    )),
    subject_id TEXT NOT NULL CHECK (
        length(subject_id) BETWEEN 1 AND 32 AND subject_id GLOB '[A-Z]*' AND subject_id NOT GLOB '*[^A-Z0-9-]*'
    ),
    flow_id TEXT NOT NULL CHECK (length(flow_id) = 24 AND flow_id NOT GLOB '*[^0-9a-f]*'),
    occurred_at TEXT NOT NULL CHECK (occurred_at IS strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 seconds')),
    recorded_at TEXT NOT NULL CHECK (recorded_at IS strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at, '+0 seconds')),
    duration_seconds INTEGER,
    CHECK (
        (type = 'guide_played' AND duration_seconds IS NOT NULL AND duration_seconds BETWEEN 1 AND 9007199254740991)
        OR (type <> 'guide_played' AND duration_seconds IS NULL)
    ),
    CHECK (type <> 'booking_demo_submitted' OR evidence = 'demo'),
    CHECK (type NOT IN ('booking_requested', 'booking_confirmed', 'booking_cancelled', 'parking_arrival_verified')
        OR evidence = 'operational'),
    UNIQUE (source_id, type, subject_id, flow_id),
    UNIQUE (source_id, id)
) STRICT;

CREATE TABLE tourism_event_ids (
    source_id TEXT NOT NULL,
    event_id TEXT NOT NULL CHECK (length(event_id) = 24 AND event_id NOT GLOB '*[^0-9a-f]*'),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
    canonical_id INTEGER NOT NULL,
    PRIMARY KEY (source_id, event_id),
    FOREIGN KEY (source_id, canonical_id) REFERENCES tourism_events(source_id, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX tourism_events_period ON tourism_events (occurred_at, recorded_at);
CREATE INDEX tourism_event_ids_canonical ON tourism_event_ids (source_id, canonical_id);
