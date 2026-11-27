# algo-metrics · 验收指标口径书与离线评测框架

《长堤导览-从样板到上线总清单》§6 的量化验收指标：**口径定义** + **离线评测执行器** + **合成评测集**。

| 文件 | 作用 |
| --- | --- |
| `docs/metrics-definition.md` | 指标口径书（12 项验收指标 + MAE 主口径与两个并列口径 + 剔除规则） |
| `docs/data-dictionary.md` | 字段级数据字典（按**视图名**组织，只登记视图层口径，不定义表结构） |
| `registry.py` | 机器可读的口径清单（每个指标的定义/公式/分子分母/目标值/口径引用） |
| `compute.py` | 通用算子（MAE、WAPE、采纳率、点击率、时延分位数、可用率…） |
| `adapters.py` | 把合成评测集接到算子上的离线适配层 |
| `stubs.py` | 未交付包的桩（`value=null`、`status=not_implemented`，**不编造数字**） |
| `runner.py` | 评测执行器：产出 `reports/eval-summary.json` + `reports/eval-summary.md` |
| `main.py` | 指标清单 + 可算指标的数值（人看的版本） |
| `datasets/` | 合成评测集 + `manifest.json`（seed / 行数 / sha256） |

## 运行

```bash
python -m pytest algo-metrics/tests -q   # 全部测试
python algo-metrics/runner.py             # 跑一轮，产出 reports/eval-summary.json + .md
python algo-metrics/runner.py --pack parking-forecast
python algo-metrics/runner.py --only parking_mae_ratio_1h
python algo-metrics/runner.py --strict    # 有未实现指标或未达标项时退出码非 0
python algo-metrics/main.py               # 指标清单 + 可算指标的数值
```

**Windows 默认控制台（GBK）已兼容**：报告**先落盘再打印**，控制台输出会把 `⏳` 这类
GBK 写不出的符号降级成 ASCII 标记（文件里保留原样），所以直接双击/命令行跑都不会因
编码问题中断。若手动改过控制台代码页或重定向了输出，仍出现乱码，可用
`PYTHONIOENCODING=utf-8` 强制 UTF-8：

```bash
set PYTHONIOENCODING=utf-8 && python algo-metrics/runner.py
```

## 数据与结论状态（重要）

- 本阶段全部数据是**合成/示意数据**（`data_source=synthetic`、`verified=false`、
  `evidence='demo'`），**只证明口径可算、链路可跑，不代表真实业务达标**；
- 停车 MAE 的**主口径**是 `MAE_ratio = mean(|pred_free − actual_free|) / total_spaces`，
  并列呈现 `MAE_spaces`（车位）与 `MAE_pp`（百分点）——三者分母不同，**不可混用**；
- **真实精度验收必须筛 `evidence='operational'`**（口径书 §2.8.6），
  `evidence='demo'` 的样本不得当成真实达成结论；
- **需求方书面确认放在上线阶段**，本阶段按约定口径执行，任何材料不写「已确认达标」。

## 换真实数据

只换数据文件，不改算法、不改口径：把 `datasets/` 里的合成 CSV 换成按同一列名导出的真实数据，
更新 `datasets/manifest.json`（用 `python algo-metrics/datasets/gen_datasets.py` 重新生成，
别手改），并在报告里写明 `data_source` / `verified` / `evidence`。
