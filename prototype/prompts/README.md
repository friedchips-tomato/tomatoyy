# 出图提示词与风格规范（项目自有）

## 来源与授权说明

演示版第一批图（`assets/map.png`、`assets/card-*.png`）是用 xxd-panel-343 Skill 的风格提示词、通过 GPT（gpt-image-2）生成的。该 Skill 采用 **PolyForm Noncommercial 1.0.0** 许可：个人学习、学校等非营利用途免费，**商用须取得作者书面授权**。

本项目有企业经费、成果要交付企业，所以：

- 演示版图片只用于校内展示和比赛演示。
- 正式版的出图**不再调用该 Skill**，统一使用本目录下我们自己写的规范和模板（`style-guide.md`、`map.md`、`card.md`）。
- 如果正式版要保留演示版的图片，先联系作者确认授权，或者按本目录的模板重新生成。

## 文件

| 文件 | 用途 |
|---|---|
| `style-guide.md` | 视觉风格规范：所有图都要遵守 |
| `map.md` | 像素地图底图的提示词（含布局要求） |
| `card.md` | 建筑像素卡片的提示词模板 |

## 流程

1. Claude 按模板写好提示词，附上定位图和现场照片。
2. GPT 出图（ChatGPT 网页或 gpt-image-2 接口）。
3. Claude 对照 `style-guide.md` 验收，不合格的重出。
4. 合格的图转成 JPEG 放进 `assets/`，在 `data/points.js` 里登记。
