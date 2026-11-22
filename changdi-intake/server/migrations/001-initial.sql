CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE cases (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    external_case_id TEXT NOT NULL,
    submission_hash TEXT NOT NULL,
    case_number TEXT NOT NULL UNIQUE,
    public_lookup_code TEXT NOT NULL UNIQUE,
    occurred_at TEXT NOT NULL,
    location TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    suggested_department TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'submitted', 'accepted', 'rejected', 'assigned', 'processing', 'awaiting_review',
        'awaiting_evaluation', 'closed'
    )),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    department TEXT,
    assignee TEXT,
    due_at TEXT,
    evaluation_ends_at TEXT,
    UNIQUE (source, external_case_id),
    CHECK ((department IS NULL AND assignee IS NULL AND due_at IS NULL)
        OR (department IS NOT NULL AND assignee IS NOT NULL AND due_at IS NOT NULL))
) STRICT;

CREATE TABLE case_contacts (
    case_id INTEGER PRIMARY KEY REFERENCES cases(id),
    contact TEXT NOT NULL
) STRICT;

CREATE TABLE attachments (
    case_id INTEGER NOT NULL REFERENCES cases(id),
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
    media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
    size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 5242880),
    sha256 TEXT NOT NULL,
    bytes BLOB NOT NULL CHECK (length(bytes) = size),
    PRIMARY KEY (case_id, position)
) STRICT;

CREATE TABLE case_events (
    case_id INTEGER NOT NULL REFERENCES cases(id),
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('integration', 'staff')),
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    detail TEXT NOT NULL CHECK (json_valid(detail)),
    public INTEGER NOT NULL CHECK (public IN (0, 1)),
    PRIMARY KEY (case_id, version)
) STRICT;
