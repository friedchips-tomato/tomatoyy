CREATE TABLE case_supervision_events (
    case_id INTEGER NOT NULL REFERENCES cases(id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('classify', 'confirm', 'revoke')),
    point_code TEXT NOT NULL,
    category_code TEXT NOT NULL,
    duplicate_of INTEGER REFERENCES cases(id) CHECK (duplicate_of <> case_id),
    reason TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (case_id, revision),
    CHECK ((duplicate_of IS NOT NULL) = (action = 'confirm'))
) STRICT;

CREATE INDEX case_supervision_codes ON case_supervision_events(point_code, category_code);
CREATE INDEX case_supervision_target ON case_supervision_events(duplicate_of) WHERE duplicate_of IS NOT NULL;

CREATE VIEW current_case_supervision AS
SELECT e.* FROM case_supervision_events e
WHERE e.revision = (SELECT max(revision) FROM case_supervision_events WHERE case_id = e.case_id);

CREATE TABLE remediation_entries (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    minutes TEXT NOT NULL,
    responsible_unit TEXT NOT NULL,
    due_at TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE remediation_reviews (
    entry_id INTEGER NOT NULL REFERENCES remediation_entries(id),
    revision INTEGER NOT NULL CHECK (revision >= 2),
    notes TEXT NOT NULL,
    conclusion TEXT NOT NULL CHECK (conclusion IN ('follow_up', 'resolved')),
    staff_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, revision)
) STRICT;
