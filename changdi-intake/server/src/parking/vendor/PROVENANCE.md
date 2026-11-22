# 停车运行时来源（vendor 副本）

上游位于仓库根目录 `parking-forecast/`（分支 `friedchips-tomato/parking-forecast`），由总指挥「任务二」worker 产出。复制时上游尚未提交进 Git，本副本是当时唯一提交进仓库的形态；上游随后已入库（合并提交 `ef9c650`，合并进 `feature/intake-public-submission`）。

**行尾策略**：上游所有生成物一律以 **LF** 落盘（`pf.export.write_json` / `pf.synth._write_jsonl` 均显式 `newline="\n"`），所以「磁盘字节 = Git blob 字节 = 被哈希的字节」三者在任何平台都相等；上游 `data/synthetic/manifest.json` 的 `file_sha256` 与 `artifacts/manifest.json` 的 `files` 记录的正是这些 LF 字节的 SHA-256。本副本所在目录由 `changdi-intake/server/src/parking/.gitattributes` 标为 `-text`，逐字节存储与检出，因此下表 12 个文件与上游在 **Git 存储层逐字节一致**（此前只有 6 个 `runtime/*.mjs` 成立，artifacts/data 因上游按 CRLF 落盘而不一致，现已修正）。上游改动后应重新同步副本并更新下表的 SHA-256。

上游版本为 `model_version = 2.0.0`、`schema_version = 2.0.0`。数据来源为 `source = synthetic`，仅供合成示范，不得对外表述为车场实测余位。

本次同步日期为 2026-11-22（上游改为 LF 落盘后重新同步）。下表路径相对于上游目录，副本保持原始字节。

只复制 `runtime/*.mjs` 运行时代码，不含上游测试与夹具；上游测试留在 parking-forecast/ 目录内。

| 文件 | SHA-256 |
| --- | --- |
| artifacts/manifest.json | c435c3d38a69bdfb462fe28e190cb30508a6684d8918933a625530f3a9a26153 |
| artifacts/model.json | 83e74db9aad3ff906d68d2a3782bfbf902a1a9d67cbd3fccdfb32665be886edd |
| data/synthetic/lots.jsonl | 571c7f36d82b66db860b50f6e5b97d6eccd01237be43d40d24df3e1626b870ad |
| data/synthetic/manifest.json | 2004b85df393e61313d19294457284fbecf6b373ff2c7af841f1079dbe2d0134 |
| data/synthetic/observations.jsonl | 4f61d76032596b6a26e4c93ecc8b0e4cfedf0375d8358102327200bbbf1cae7d |
| data/synthetic/signals.jsonl | 6385dabe29609dcf3a902b8c4dd5e0b77f247d0ea25ae5a28e8ab756c1490990 |
| runtime/features.mjs | c338008773274a76738290bdfa1e4e00ce5368b775c4a29944b39972b5deaec0 |
| runtime/forecast.mjs | ad55c5d1e98d21856eaf78fc006e2050cf2d1dbf94a7c69c79c75beb3834d6cf |
| runtime/format.mjs | 09e2dbbafe021d3d165583d8093c56d2174cc7f899271ccfedf7be9987540201 |
| runtime/index.mjs | e22f5ce025744e8145deaf27f3f472c65aa38e1993d59d3c38b0c11ab7422231 |
| runtime/reasons.mjs | 1527d34c849624b301b75688cd7db383383e3bb51a8edd37c67cd2519786cbf7 |
| runtime/recommend.mjs | 2b2e06239efcde4ee6fbcb4f37c9f5d02b11b1e770f08fd114a7d81e819f584e |

上游若变更，联系后端设计指挥重新同步；同步时必须逐文件核对 SHA-256 一致后才允许提交。

数据底座对应关系：数据库侧基表使用 `parking_id`、`fee_rule`。兼容视图 `ml_parking_lots`、`ml_parking_observations` 的字段分别与 `lot.schema.json`、`observation.schema.json` 一一对应。接入真实停车数据时，从这两个视图导出 JSONL 供运行时读取；对外接口继续使用由视图映射的 `lot_id`。

车场目录的 `current_free` 来自观测视图中该车场最新记录的 `free_spaces`。视图导出与接口读取均须保留原值：NULL 表示未知，0 表示实测满位。
