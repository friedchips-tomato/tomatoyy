CREATE TABLE cases_v4 (
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
        'submitted', 'awaiting_supplement', 'accepted', 'rejected', 'assigned', 'processing',
        'awaiting_review', 'awaiting_evaluation', 'closed', 'reopen_pending'
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

INSERT INTO cases_v4 (
    id, source, external_case_id, submission_hash, case_number, public_lookup_code,
    occurred_at, location, category, description, suggested_department, status,
    version, department, assignee, due_at, evaluation_ends_at, round, reopen_ends_at
)
SELECT id, source, external_case_id, submission_hash, case_number, public_lookup_code,
    occurred_at, location, category, description, suggested_department, status,
    version, department, assignee, due_at, evaluation_ends_at, round, reopen_ends_at
FROM cases;
DROP TABLE cases;
ALTER TABLE cases_v4 RENAME TO cases;
