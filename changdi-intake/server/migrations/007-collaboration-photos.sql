CREATE TABLE collaboration_submission_photos (
    task_id INTEGER NOT NULL,
    submit_version INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
    media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
    size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 5242880),
    sha256 TEXT NOT NULL,
    bytes BLOB NOT NULL CHECK (length(bytes) = size),
    PRIMARY KEY (task_id, submit_version, position),
    FOREIGN KEY (task_id, submit_version) REFERENCES collaboration_events(task_id, version)
) STRICT;
