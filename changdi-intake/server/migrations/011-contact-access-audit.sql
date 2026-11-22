CREATE TABLE case_contact_access_audit (
    case_id INTEGER NOT NULL REFERENCES cases(id),
    staff_id TEXT NOT NULL,
    accessed_at TEXT NOT NULL
) STRICT;

CREATE INDEX case_contact_access_audit_case_time ON case_contact_access_audit(case_id, accessed_at);
