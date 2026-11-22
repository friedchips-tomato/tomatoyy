CREATE TABLE cases_v2 (
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
        'awaiting_evaluation', 'closed', 'reopen_pending'
    )),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    department TEXT,
    assignee TEXT,
    due_at TEXT,
    evaluation_ends_at TEXT,
    round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
    reopen_ends_at TEXT,
    UNIQUE (source, external_case_id),
    CHECK ((department IS NULL AND assignee IS NULL AND due_at IS NULL)
        OR (department IS NOT NULL AND assignee IS NOT NULL AND due_at IS NOT NULL))
) STRICT;

INSERT INTO cases_v2 (
    id, source, external_case_id, submission_hash, case_number, public_lookup_code,
    occurred_at, location, category, description, suggested_department, status,
    version, department, assignee, due_at, evaluation_ends_at
)
SELECT id, source, external_case_id, submission_hash, case_number, public_lookup_code,
    occurred_at, location, category, description, suggested_department, status,
    version, department, assignee, due_at, evaluation_ends_at
FROM cases;
DROP TABLE cases;
ALTER TABLE cases_v2 RENAME TO cases;

CREATE TABLE case_events_v2 (
    case_id INTEGER NOT NULL REFERENCES cases(id),
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('integration', 'staff', 'owner')),
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    detail TEXT NOT NULL CHECK (json_valid(detail)),
    public INTEGER NOT NULL CHECK (public IN (0, 1)),
    round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
    PRIMARY KEY (case_id, version)
) STRICT;
INSERT INTO case_events_v2 (case_id, version, action, status, actor_type, actor_id, occurred_at, detail, public)
SELECT case_id, version, action, status, actor_type, actor_id, occurred_at, detail, public FROM case_events;
DROP TABLE case_events;
ALTER TABLE case_events_v2 RENAME TO case_events;

CREATE TABLE case_evaluations (
    case_id INTEGER NOT NULL REFERENCES cases(id),
    round INTEGER NOT NULL CHECK (round >= 1),
    speed INTEGER NOT NULL CHECK (speed BETWEEN 1 AND 5),
    effectiveness INTEGER NOT NULL CHECK (effectiveness BETWEEN 1 AND 5),
    attitude INTEGER NOT NULL CHECK (attitude BETWEEN 1 AND 5),
    comment TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (case_id, round)
) STRICT;

CREATE TABLE reopen_requests (
    case_id INTEGER NOT NULL,
    requested_version INTEGER NOT NULL,
    round INTEGER NOT NULL CHECK (round >= 1),
    previous_status TEXT NOT NULL CHECK (previous_status IN ('awaiting_evaluation', 'closed')),
    reason TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    decision TEXT CHECK (decision IN ('approved', 'rejected')),
    decision_reason TEXT,
    decided_at TEXT,
    decided_by TEXT,
    CHECK (
        (decision IS NULL AND decision_reason IS NULL AND decided_at IS NULL AND decided_by IS NULL)
        OR (decision IS NOT NULL AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
    ),
    CHECK (decision IS NOT 'rejected' OR decision_reason IS NOT NULL),
    PRIMARY KEY (case_id, requested_version),
    FOREIGN KEY (case_id, requested_version) REFERENCES case_events(case_id, version)
) STRICT;

CREATE UNIQUE INDEX one_pending_reopen_per_case ON reopen_requests(case_id) WHERE decision IS NULL;

CREATE TABLE owner_verify_attempts (
    origin_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    failures INTEGER NOT NULL CHECK (failures BETWEEN 1 AND 10)
) STRICT;
CREATE INDEX owner_verify_attempts_expiry ON owner_verify_attempts(expires_at);
