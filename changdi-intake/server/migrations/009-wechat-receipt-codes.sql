CREATE TABLE wechat_receipt_codes (
    case_id INTEGER NOT NULL REFERENCES cases(id),
    app_scope TEXT NOT NULL CHECK (length(app_scope) = 64),
    env_version TEXT NOT NULL CHECK (env_version IN ('release', 'trial', 'develop')),
    media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png')),
    bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),
    PRIMARY KEY (case_id, app_scope, env_version)
) STRICT;
