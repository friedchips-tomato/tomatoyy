# 停车运行时来源（vendor 副本）

上游位于仓库根目录 `parking-forecast/`（分支 `friedchips-tomato/parking-forecast`），由总指挥「任务二」worker 产出。截至复制时，上游尚未提交进 Git，本副本是当时唯一提交进仓库的形态。上游改动后应重新同步副本并更新下表的 SHA-256。

上游版本为 `model_version = 2.0.0`、`schema_version = 2.0.0`。数据来源为 `source = synthetic`，仅供合成示范，不得对外表述为车场实测余位。

复制日期为 2026-11-22。下表路径相对于上游目录，副本保持原始字节。

只复制 `runtime/*.mjs` 运行时代码，不含上游测试与夹具；上游测试留在 parking-forecast/ 目录内。

| 文件 | SHA-256 |
| --- | --- |
| artifacts/manifest.json | c7b9f183e10ba029abdeea8be49dbd1b32e551cad31e343dd2caf77e55a215c1 |
| artifacts/model.json | 751256384ffd6e8b1db655df3223adde722b96c8184fecb392f1baf7b931178f |
| data/synthetic/lots.jsonl | f06f4020f09d7fd22a0826eb80ae72342ba93b96776abb1044a18cbd39471feb |
| data/synthetic/manifest.json | 4ab0ab002c80b8e208547b2552223edccbe8da5399f0b3ef7cc881fe3b6a976a |
| data/synthetic/observations.jsonl | 45bfe99fd903d065fb9a98f107b52e6c63a10771b0068fed1daad0c5ff8ad96f |
| data/synthetic/signals.jsonl | ce5e1bc47f07eb1ad865bdc063b672d7f00459171e3204d56dc6c32c155d3988 |
| runtime/features.mjs | c338008773274a76738290bdfa1e4e00ce5368b775c4a29944b39972b5deaec0 |
| runtime/forecast.mjs | ad55c5d1e98d21856eaf78fc006e2050cf2d1dbf94a7c69c79c75beb3834d6cf |
| runtime/format.mjs | 09e2dbbafe021d3d165583d8093c56d2174cc7f899271ccfedf7be9987540201 |
| runtime/index.mjs | e22f5ce025744e8145deaf27f3f472c65aa38e1993d59d3c38b0c11ab7422231 |
| runtime/reasons.mjs | 1527d34c849624b301b75688cd7db383383e3bb51a8edd37c67cd2519786cbf7 |
| runtime/recommend.mjs | 2b2e06239efcde4ee6fbcb4f37c9f5d02b11b1e770f08fd114a7d81e819f584e |

上游若变更，联系后端设计指挥重新同步；同步时必须逐文件核对 SHA-256 一致后才允许提交。

数据底座对应关系：数据库侧基表使用 `parking_id`、`fee_rule`。兼容视图 `ml_parking_lots`、`ml_parking_observations` 的字段分别与 `lot.schema.json`、`observation.schema.json` 一一对应。接入真实停车数据时，从这两个视图导出 JSONL 供运行时读取；对外接口继续使用由视图映射的 `lot_id`。
