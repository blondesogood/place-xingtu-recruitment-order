# 标准入口

先读取 ego-browser Skill。以下路径可通过 XHS_SKILL_DIR 指向任意已核验安装位置；运行记录路径与安装路径独立。

```bash
ego-browser nodejs <<'EOF_RUN'
const {homedir}=await import('node:os');
const {join}=await import('node:path');
const {pathToFileURL}=await import('node:url');
const skillDir=process.env.XHS_SKILL_DIR||join(homedir(),'.agents','skills','place-xiaohongshu-luxury-order');
const {runStandard}=await import(pathToFileURL(join(skillDir,'scripts','standard-runner.mjs')).href);
const {createLiveAdapter}=await import(pathToFileURL(join(skillDir,'scripts','live-adapter.mjs')).href);
const helpers={listTaskSpaces,useOrCreateTaskSpace,listTabs,openOrReuseTab,switchTab,closeTab,gotoAndWait,pageInfo,js,cdp,drainEvents,click,fillInput,pressKey,wait};
const input={operation:'ORDER',taskId:'<本批稳定唯一标识>',orderIds:['<明确授权的订单号>']};
const adapter=await createLiveAdapter(helpers,{taskId:input.taskId});
cliLog(await runStandard(input,adapter));
EOF_RUN
```

后续下单调用保留同一 taskId 与原集合。输入 `preview:true` 仅用于开发走查；走查批次不能去掉 preview 后真实执行。每次 runStandard 自动逐单接续至本轮无可执行动作，无需逐步回复“继续”。

支付调用使用同一入口，把 input 改为：

```js
const input={operation:'PAYMENT',batchRef:'<下单返回的批次引用>'};
// 可选 orderIds: ['<原授权批次中的订单号>']，省略时检查原集合。
const adapter=await createLiveAdapter(helpers,{taskId:'<本次浏览器任务稳定标识>'});
cliLog(await runStandard(input,adapter));
```

两个入口必须共用 stateDir（或相同 XHS_STATE_DIR）。换电脑先停用旧执行器，迁移整个运行目录，再核验登录和记录；不能以空目录重开历史批次。未决标记按运行契约对账；用户明确授权的旧回填恢复只适用该契约规定的单次例外。

`listAuthorizedBatches({stateDir})` 只返回真实授权批次（不包含 preview 批次）。调用方从返回值选定原批次，不能扫描平台所有待付款订单并据此建立付款授权。

运行结果先通过 cliLog 输出；遵守 ego-browser 的完成规则，在独立的最终 heredoc 中 `completeTaskSpace(id,{keep:false})`。需本人登录或验证码时按 ego-browser 交接，不自动夺回控制。
