# 安装与使用

支持环境：macOS、Codex、Ego Lite、Node.js 22.16.0 或更新版本。需要已安装 ego-browser Skill 及其 CLI，并能登录内部投放平台和小红书蒲公英。其他系统和 Agent 尚未验证。

## 安装或更新

将发行 ZIP 解压，把其中完整的 `place-xiaohongshu-luxury-order` 文件夹放到 `~/.agents/skills/`。更新前结束正在执行的批次调用，将旧 Skill 文件夹移到安装目录之外备份，再替换整个文件夹，避免混入旧运行代码。重新打开 Codex 任务以加载新 Skill。

运行以下校验；应返回 `ok:true`，并显示对应发行版本：

```bash
node ~/.agents/skills/place-xiaohongshu-luxury-order/scripts/validate-release.mjs
```

该校验确认运行文件完整，不代表网站登录或订单验收已通过。若失败，重新解压原发行包，不手改 Manifest 绕过校验。

安装包不含业务记录。更新时保留 `~/.local/state/xhs-luxury-order`（或已配置的 stateDir）。换电脑续跑时，先停用旧电脑执行器，再迁移完整运行目录；不能同时在两台电脑执行同批订单。

## 给 Codex 的指令

新批次：`用小红书下单 Skill 处理这些内部订单号：……，完成下单、回填，并检查支付。`

后续支付：`检查刚才小红书批次的接单情况，核价并支付符合条件的订单。`

Agent 从已保存批次取得授权范围，通过[标准入口](standard-entry.md)调用 ORDER 与 PAYMENT。付款检查不能重新创建批次。平台待接单或价格未确定时，报告等待原因；之后按用户指令或已有外部自动化再检查。

正常订单自动推进。登录、验证码、风控等需要本人处理时，Agent 交接浏览器；完成后回复“继续”。若报告待对账，保留原记录，由标准入口读取平台最终状态，不能通过删除记录、清空任务 ID 或重开批次重试。

本机真实验收、目标电脑安装和同事持续使用分别验证；发行正式版本不代替同事实际业务验收。
