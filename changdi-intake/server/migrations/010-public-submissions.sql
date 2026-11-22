-- 游客公开申报的建单事件使用 public 身份，放宽 case_events.actor_type 取值。
-- 重建表时保留其他表对 case_events 的外键引用，legacy_alter_table 避免重命名时重写引用。
PRAGMA legacy_alter_table=ON;
CREATE TABLE case_events_v3 (
    case_id INTEGER NOT NULL REFERENCES cases(id),
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('integration', 'staff', 'owner', 'public')),
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    detail TEXT NOT NULL CHECK (json_valid(detail)),
    public INTEGER NOT NULL CHECK (public IN (0, 1)),
    round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
    PRIMARY KEY (case_id, version)
) STRICT;
INSERT INTO case_events_v3 (case_id, version, action, status, actor_type, actor_id, occurred_at, detail, public, round)
SELECT case_id, version, action, status, actor_type, actor_id, occurred_at, detail, public, round FROM case_events;
DROP TABLE case_events;
ALTER TABLE case_events_v3 RENAME TO case_events;
PRAGMA legacy_alter_table=OFF;
