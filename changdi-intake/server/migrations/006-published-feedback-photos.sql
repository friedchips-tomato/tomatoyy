CREATE TABLE published_feedback_photos (
    case_id INTEGER NOT NULL,
    publish_version INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
    size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 5242880),
    sha256 TEXT NOT NULL,
    bytes BLOB NOT NULL CHECK (length(bytes) = size),
    PRIMARY KEY (case_id, publish_version, position),
    FOREIGN KEY (case_id, publish_version) REFERENCES case_events(case_id, version)
) STRICT;
