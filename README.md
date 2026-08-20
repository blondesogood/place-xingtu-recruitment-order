# place-xingtu-recruitment-order

可直接安装的抖音巨量星图招募下单 Skill。仓库只发布招募 Skill，不包含也不会安装或修改指派、投稿 Skill。

当前候选版本：`1.0.0-rc.12`

验收状态：`PENDING_CURRENT_REVISION`（当前版本尚未完成真实下单验收）

## 给另一台电脑的 Agent

把下面这段话完整交给 Agent：

> 克隆 `https://github.com/blondesogood/place-xingtu-recruitment-order.git`，只安装仓库中的 `place-xingtu-recruitment-order` 目录。将该目录完整复制到当前用户的 Skills 根目录下，并保持目录名不变：macOS/Linux 使用 `~/.agents/skills/place-xingtu-recruitment-order`；Windows 使用 `%USERPROFILE%\.agents\skills\place-xingtu-recruitment-order`。安装后核对 `references/release.json` 中的 `candidateVersion` 为 `1.0.0-rc.12`。不要安装或修改 `place-xingtu-directed-order`、`place-xingtu-submission-order`。

## 手动安装

macOS/Linux：

```bash
git clone https://github.com/blondesogood/place-xingtu-recruitment-order.git
mkdir -p ~/.agents/skills/place-xingtu-recruitment-order
cp -R place-xingtu-recruitment-order/place-xingtu-recruitment-order/. ~/.agents/skills/place-xingtu-recruitment-order
```

Windows PowerShell：

```powershell
git clone https://github.com/blondesogood/place-xingtu-recruitment-order.git
$source = Join-Path $PWD "place-xingtu-recruitment-order\place-xingtu-recruitment-order"
$target = Join-Path $env:USERPROFILE ".agents\skills\place-xingtu-recruitment-order"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -Recurse -Force (Join-Path $source "*") $target
```

安装后检查：

```text
place-xingtu-recruitment-order/references/release.json
candidateVersion = 1.0.0-rc.12
```

公共运行接口保持为 `prepare`、`run`、`resume`、`finalize`，manifest schema 为 v4。

## 固定版本

- 标签：<https://github.com/blondesogood/place-xingtu-recruitment-order/tree/v1.0.0-rc.12>
- ZIP：<https://github.com/blondesogood/place-xingtu-recruitment-order/archive/refs/tags/v1.0.0-rc.12.zip>
