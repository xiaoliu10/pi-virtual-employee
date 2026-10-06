# 技能市场索引

`manage_skills action=market` 读取本文件列出的技能。每个条目：

```json
{ "name": "技能名", "description": "一句话触发说明", "url": "https://…/SKILL.md" }
```

- `url` 指向一个符合 SKILL.md 格式的 https 直链（YAML frontmatter 的 name/description + Markdown 正文）。
- 安装动作是管理员操作（IM 单聊 + 「确认」，或开启管理员完全访问）。
- 想上架技能：向本仓库提 PR 修改本文件，`url` 指向你托管 Skill 的直链。
