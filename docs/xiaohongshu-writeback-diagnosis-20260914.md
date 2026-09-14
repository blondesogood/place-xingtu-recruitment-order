# rc.16 回填未决诊断

对象：2026-09-14 验收批次尾号 9129。本轮没有重复最终保存，没有修改 WRITEBACK 未决标记或运行代码。

## 确认的缺陷

`live-adapter.mjs:146` 调用 physicalClick 后立即返回 UNKNOWN。physicalClick 仅点击并读 DOM，不等待保存请求。standard-runner 下一轮 inspect 通过 internalOrder 立即 gotoAndWait 订单页，可能打断异步保存，并丢失表单错误提示。保存链没有记录成功响应、后台拒绝、网络失败或前端验证失败。

当前线上表单处理顺序是 await validateFields → await onSubmit → reset/close，提交端点为 POST /external-orders?orderId=… 。本轮只读表单校验通过：账户为上海悦川，任务 ID 正确；只证明当前输入，不证明历史点击时的表单状态。准备表单时另遇一次账户选项 TARGET_NOT_UNIQUE，没有最终提交，不与原保存失败混为一谈。

## 隔离验证

使用安装版真实 EgoDriver.physicalClick，连接无业务数据的本机测试页面：按钮发起 POST，服务端延迟 500ms，断连时放弃写入。

- 现有顺序“点击 → 立即导航”：received=1, committed=0, aborted=1，保存断言失败。
- 只改变为“等待保存响应 → 导航”：累计 received=2, committed=1, aborted=1，第二次保存成功。

测试证明当前时序可以导致保存被中断；不证明真实后台必然使用相同断连行为，也不证明原次请求实际已发出。原始执行输出留在本任务记录；本机夹具和下载的前端临时源码收尾删除。

## 结论

已定位可复现的保存时序缺陷及响应取证缺口。原单当时没有保存 POST 响应／后台日志，尚不能确认唯一历史根因。当前未回填本身不是再次保存的许可。

修复方向：在原表单内等待并记录匹配本单的保存请求结果，再查询平台持久状态。前端校验失败、后台拒绝、请求取消、结果未知分别报告。原单需取得请求／后台证据完成对账，不能凭时序推断解除未决标记。

后续已实现保存响应等待、持久证据与回归测试，见[修复验证](xiaohongshu-writeback-fix-20260914.md)。本节保留诊断时的证据边界。
