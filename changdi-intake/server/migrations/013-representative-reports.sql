CREATE TABLE representative_report_releases (
    month TEXT PRIMARY KEY,
    policy_hash TEXT NOT NULL,
    reports TEXT NOT NULL CHECK (json_valid(reports)),
    frozen_at TEXT NOT NULL
) STRICT;
