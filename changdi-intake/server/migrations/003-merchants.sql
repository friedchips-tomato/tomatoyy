CREATE TABLE merchant_cases (
    case_id INTEGER PRIMARY KEY REFERENCES cases(id),
    merchant_id TEXT NOT NULL,
    submitted_by TEXT NOT NULL
) STRICT;
CREATE INDEX merchant_cases_by_merchant ON merchant_cases(merchant_id, case_id);

CREATE TABLE collaboration_tasks (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE,
    case_id INTEGER NOT NULL REFERENCES cases(id),
    round INTEGER NOT NULL CHECK (round >= 1),
    merchant_id TEXT NOT NULL,
    instructions TEXT NOT NULL,
    location TEXT,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('awaiting_submission', 'awaiting_review', 'returned', 'approved', 'withdrawn')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    latest_submission TEXT,
    return_reason TEXT
) STRICT;
CREATE INDEX collaboration_tasks_by_case ON collaboration_tasks(case_id, id);
CREATE INDEX collaboration_tasks_by_merchant ON collaboration_tasks(merchant_id, id);

CREATE TABLE collaboration_events (
    task_id INTEGER NOT NULL REFERENCES collaboration_tasks(id),
    version INTEGER NOT NULL CHECK (version >= 1),
    action TEXT NOT NULL CHECK (action IN ('assign', 'submit', 'approve', 'return', 'withdraw')),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('staff', 'merchant')),
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    detail TEXT NOT NULL CHECK (json_valid(detail)),
    PRIMARY KEY (task_id, version)
) STRICT;
