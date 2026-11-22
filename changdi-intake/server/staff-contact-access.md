# 工作人员联系方式查阅

在服务端工作人员目录的单个账号条目中配置 `"readContact": true`。本地启动入口从 `CHANGDI_STAFF_JSON` 读取该目录，其他接入入口通过 `createIntakeServer({ staff })` 传入。下面是承办账号条目的授权字段示例，本地模式须保留原有 `token` 字段。

```json
{ "id": "handler-a", "role": "handler", "department": "street-a", "readContact": true }
```

缺省或设置为 `false` 时拒绝查阅。字段只接受布尔值，配置值更改后需要重新加载服务。微信模式仍以已有微信账号绑定和服务端会话核验工作人员身份，并继续禁用本地工作人员令牌。值班人员、主管和承办人仍分别受现有全量、部门及本人分派范围约束。各账号须单独授权。

- `GET /api/v1/staff/me` 为获授权账号返回 `readContact: true`，用于显示查阅入口。
- `GET /api/v1/staff/cases/{caseNumber}/contact` 使用现有工作人员 Bearer 凭据。有联系方式时返回 `{"contact":"…"}`，未填写时返回 `{"contact":null}`。无有效凭据返回 401，无查阅授权或身份类型不符返回 403，获授权但工单不存在或超出范围统一返回 404。响应均使用 `Cache-Control: no-store`。
- SQLite 迁移 011 添加 `case_contact_access_audit`。每次授权查阅，包括未填写联系方式的工单，都记录工单内部 ID、工作人员 ID 和 UTC 时间。审计与读取在同一事务内，提交成功后才发送结果。审计可通过 `cases.id` 联查工单号，无需访问联系方式表。
- 小程序接到查阅结果后只在当前详情页临时显示，从查阅操作起最多 30 秒，支持手动隐藏。离开、隐藏页面、切换、刷新工单或会话失效时自动清除。
