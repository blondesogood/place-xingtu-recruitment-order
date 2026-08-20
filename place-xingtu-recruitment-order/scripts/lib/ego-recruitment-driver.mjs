const statefulOperations = new Set([
  "SUBMIT_RECRUITMENT_ORDER",
  "TOP_UP_RECRUITMENT_BUDGET",
  "CONFIRM_INTERNAL_ORDER",
]);

const visualEligibleReasons = new Set([
  "SEMANTIC_LOCATOR_MISSING",
  "SEMANTIC_LOCATOR_AMBIGUOUS",
  "UI_STRUCTURE_DRIFT",
  "VISUAL_COMMIT_REQUIRED",
]);

const operationRequiredFields = Object.freeze({
  ENSURE_INTERNAL_BUSINESS_ROLE: [],
  READ_ORDERS_BY_ID: ["orderIds"],
  READ_ORDER_SNAPSHOT: ["orderId"],
  OPEN_CREATOR_ORDER: ["activityId", "creatorId", "priceMinorUnits"],
  PREPARE_RECRUITMENT_DRAFT: ["activityId", "creatorId", "priceMinorUnits"],
  COMMIT_RECRUITMENT_DEADLINE: ["activityId", "deliveryDeadline"],
  REREAD_RECRUITMENT_DRAFT: ["activityId", "creatorId", "priceMinorUnits", "deliveryDeadline"],
  SUBMIT_RECRUITMENT_ORDER: ["orderId", "activityId", "creatorId", "priceMinorUnits", "deliveryDeadline"],
  READ_RECRUITMENT_SUBMIT_RESULT: ["activityId", "creatorId", "priceMinorUnits", "deliveryDeadline"],
  READ_RECRUITMENT_BUDGET: ["activityId"],
  REREAD_RECRUITMENT_BUDGET: ["activityId"],
  TOP_UP_RECRUITMENT_BUDGET: ["orderId", "activityId", "creatorId", "stepMinorUnits", "beforeTotalBudgetMinorUnits"],
  REREAD_RECRUITMENT_TASK: ["activityId", "creatorId", "priceMinorUnits", "deliveryDeadline"],
  PREPARE_INTERNAL_WRITEBACK: ["orderId", "activityId", "creatorId"],
  REREAD_INTERNAL_WRITEBACK: ["orderId", "activityId", "creatorId"],
  CONFIRM_INTERNAL_ORDER: ["orderId", "activityId", "creatorId"],
  REREAD_INTERNAL_FINAL_STATE: ["orderId", "activityId", "creatorId"],
});

export class EgoRecruitmentError extends Error {
  constructor(reasonCode, message = reasonCode, { dispatched = false } = {}) {
    super(message);
    this.name = "EgoRecruitmentError";
    this.reasonCode = reasonCode;
    this.dispatched = dispatched;
  }
}

function requireFacade(ego) {
  const helpers = [
    "openOrReuseTab", "js", "click", "fillInput", "pressKey", "typeText", "wait",
    "captureScreenshot", "pageInfo",
  ];
  if (ego === null || typeof ego !== "object" || helpers.some((name) => typeof ego[name] !== "function")) {
    throw new Error("Ego recruitment driver requires the bounded ego-browser facade");
  }
  return ego;
}

function requireOrigins(origins) {
  if (
    origins === null || typeof origins !== "object" || Array.isArray(origins) ||
    Object.keys(origins).sort().join(",") !== "placement,xingtu"
  ) throw new Error("Ego recruitment origins are invalid");
  const placement = new URL(origins.placement);
  const xingtu = new URL(origins.xingtu);
  if (placement.protocol !== "https:" || xingtu.protocol !== "https:") {
    throw new Error("Ego recruitment origins must use HTTPS");
  }
  return Object.freeze({ placement: placement.origin, xingtu: xingtu.origin });
}

function source(body, input = {}) {
  return `(() => { const input = ${JSON.stringify(input)}; ${body} })()`;
}

async function dom(ego, body, input = {}) {
  return ego.js(source(body, input));
}

async function waitForStableValue(ego, read, {
  accept,
  timeoutSeconds = 5,
  intervalSeconds = 0.25,
  minimumSeconds = 1,
  reasonCode = "UI_STRUCTURE_DRIFT",
  message = "page state did not stabilize",
} = {}) {
  const attempts = Math.ceil(timeoutSeconds / intervalSeconds) + 1;
  let previousDigest = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    const accepted = typeof accept === "function" ? accept(value) : true;
    const digest = accepted ? JSON.stringify(value) : null;
    if (
      accepted && attempt * intervalSeconds >= minimumSeconds &&
      previousDigest !== null && digest === previousDigest
    ) return value;
    previousDigest = digest;
    if (attempt + 1 < attempts) await ego.wait(intervalSeconds);
  }
  throw new EgoRecruitmentError(reasonCode, message);
}

async function navigate(ego, origin, path) {
  const url = new URL(path, origin).href;
  await ego.openOrReuseTab(url, { wait: true, timeout: 20 });
  const info = await ego.pageInfo();
  if (info?.dialog) throw new EgoRecruitmentError("SECURITY_VERIFICATION_REQUIRED", "native browser dialog is open");
  if (typeof info?.url === "string") {
    const actual = new URL(info.url);
    if (actual.hostname === "sso.aihuishou.com" || /\/cas\/login(?:[/?#]|$)/u.test(actual.pathname)) {
      throw new EgoRecruitmentError("LOGIN_REQUIRED", "Placement login is required in the active task space");
    }
  }
  if (typeof info?.url !== "string" || new URL(info.url).origin !== new URL(origin).origin) {
    throw new EgoRecruitmentError("ACCOUNT_MISMATCH", "page origin changed unexpectedly");
  }
  return info;
}

async function visibleCenter(ego, selector, { text = null, exact = false, within = null } = {}) {
  return dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const root = input.within ? [...document.querySelectorAll(input.within)].find(visible) : document;
    if (!root) return { count: 0, center: null };
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const nodes = [...root.querySelectorAll(input.selector)].filter(visible).filter(el => {
      if (input.text === null) return true;
      const value = normalize(el.innerText || el.textContent || el.getAttribute('aria-label'));
      return input.exact ? value === input.text : value.includes(input.text);
    });
    const rectangles = nodes.map(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
    }).filter(rect => rect.width > 0 && rect.height > 0);
    return { count: rectangles.length, center: rectangles.length === 1 ? rectangles[0] : null };
  `, { selector, text, exact, within });
}

async function clickUnique(ego, selector, options = {}) {
  const located = await visibleCenter(ego, selector, options);
  if (located.count === 0) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_MISSING");
  if (located.count !== 1 || located.center === null) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS");
  await ego.click([located.center.x, located.center.y]);
  return located.center;
}

async function realKeyboardInput(ego, selector, value, {
  acceptedValues = [value],
  pressEnter = true,
  verifyCommitted = true,
} = {}) {
  const target = await visibleCenter(ego, selector);
  if (target.count === 0) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_MISSING");
  if (target.count !== 1 || target.center === null) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS");
  if (value === "") {
    const current = await dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const currentMatches = [...document.querySelectorAll(input.selector)].filter(visible);
      return currentMatches.length === 1 ? currentMatches[0].value : null;
    `, { selector });
    if (typeof current !== "string" || current.length > 300) {
      throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "keyboard input current value is invalid");
    }
    await ego.click([target.center.x, target.center.y], { label: "focus input before keyboard clear" });
    await ego.pressKey("End");
    for (let index = 0; index < current.length; index += 1) await ego.pressKey("Backspace");
  } else {
    await ego.fillInput(selector, value);
  }
  if (pressEnter) await ego.pressKey("Enter");
  if (!verifyCommitted) return;
  await waitForStableValue(ego, () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const matches = [...document.querySelectorAll(input.selector)].filter(visible);
      return matches.length === 1 ? matches[0].value : null;
    `, { selector }), {
    accept: (actual) => acceptedValues.includes(actual),
    message: "keyboard input did not commit",
  });
}

async function clearOrderSearch(ego) {
  const selector = '.ant-input-affix-wrapper:has(input[placeholder*="搜索订单编号"]) .ant-input-clear-icon';
  const target = await visibleCenter(ego, selector);
  if (target.count === 0) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_MISSING");
  if (target.count !== 1 || target.center === null) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS");
  await ego.click([target.center.x, target.center.y], { label: "clear order search" });
  await ego.pressKey("Enter");
  await waitForStableValue(ego, () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const matches = [...document.querySelectorAll('input[placeholder*="搜索订单编号"]')].filter(visible);
      return matches.length === 1 ? matches[0].value : null;
    `), {
    accept: (actual) => actual === "",
    message: "order search input did not clear",
  });
}

function moneyMinor(text) {
  const match = /(?:¥|￥)\s*([\d,.]+)/u.exec(String(text));
  if (!match) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "money value is unavailable");
  const value = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(value)) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "money value is invalid");
  return Math.round(value * 100);
}

function internalRecordFromRow(row, expectedOrderId) {
  if (!row || row.count !== 1 || typeof row.text !== "string") {
    throw new EgoRecruitmentError(row?.count === 0 ? "ORDER_NOT_FOUND" : "ORDER_BINDING_AMBIGUOUS");
  }
  const text = row.text.replace(/\s+/gu, " ").trim();
  const values = text.match(/\b\d{16,20}\b/gu) ?? [];
  const createdAt = /20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.exec(text)?.[0]?.replace(" ", "T") + "+08:00";
  const status = ["待商务下单", "商务已下单", "已驳回", "已取消"].find((value) => text.includes(value)) ?? null;
  const orderCells = Array.isArray(row.cells)
    ? row.cells.map((value) => String(value ?? "").replace(/\s+/gu, "").trim())
    : [];
  if (!orderCells.includes(expectedOrderId) || values.length < 2 || !status || !text.includes("抖音") || !text.includes("招募")) {
    throw new EgoRecruitmentError("ORDER_BINDING_AMBIGUOUS", "internal order binding is incomplete");
  }
  return {
    orderId: expectedOrderId,
    creatorId: values[0],
    activityId: values.at(-1),
    creatorName: row.cells?.[1] ?? null,
    platform: "抖音",
    taskType: "招募",
    amountText: /(?:¥|￥)\s*[\d,.]+/u.exec(text)?.[0] ?? null,
    orderStatus: status,
    createdAt: createdAt && Number.isFinite(Date.parse(createdAt)) ? createdAt : null,
    text,
  };
}

async function searchInternalOrder(ego, origins, orderId) {
  await navigate(ego, origins.placement, "/orders");
  await closeFilterDrawer(ego);
  await clearActiveFilters(ego);
  const search = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const inputs = [...document.querySelectorAll('input[placeholder*="搜索订单编号"]')].filter(visible);
    return inputs.length === 1 ? inputs[0].value : null;
  `);
  if (search === null) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "order search input is unavailable");
  if (search !== "") await clearOrderSearch(ego);
  await realKeyboardInput(ego, 'input[placeholder*="搜索订单编号"]', orderId, {
    verifyCommitted: false,
  });
  const readRow = () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const rows = [...document.querySelectorAll('tbody tr')].filter(visible).filter(tr => (
        [...tr.querySelectorAll('td')]
          .map(td => (td.innerText || '').replace(/\s+/g, '').trim())
          .some(value => value === input.orderId)
      ));
      return {
        count: rows.length,
        text: rows.length === 1 ? rows[0].innerText : null,
        cells: rows.length === 1 ? [...rows[0].querySelectorAll('td')].map(td => (td.innerText || '').replace(/\s+/g, ' ').trim()) : null,
      };
    `, { orderId });
  let row;
  try {
    row = await waitForStableValue(ego, readRow, {
      accept: (value) => value?.count === 1,
      message: `order ${orderId} did not stabilize`,
    });
  } catch (error) {
    if (error?.reasonCode !== "UI_STRUCTURE_DRIFT") throw error;
    const final = await readRow();
    if (final?.count === 0) throw new EgoRecruitmentError("ORDER_NOT_FOUND");
    throw new EgoRecruitmentError("ORDER_BINDING_AMBIGUOUS");
  }
  return internalRecordFromRow(row, orderId);
}

async function ensureBusinessRole(ego, origins) {
  await navigate(ego, origins.placement, "/orders");
  const readRole = () => dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const switchers = [...document.querySelectorAll('button,[role=button]')]
      .filter(el => visible(el) && normalize(el.innerText || el.textContent).includes('切换角色'));
    if (switchers.length !== 1) return null;
    let node = switchers[0].parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const text = normalize(node.innerText || node.textContent);
      const matches = ['商务', '采购'].filter(value => new RegExp('(?:^|\\s)' + value + '(?:$|\\s)').test(text));
      if (matches.length === 1) return matches[0];
    }
    return null;
  `);
  const role = await readRole();
  if (role === "商务") return { role: "商务", verified: true };
  if (role !== "采购") throw new EgoRecruitmentError("ROLE_STATE_UNREADABLE");
  await clickUnique(ego, "button,[role=button]", { text: "切换角色" });
  await ego.wait(0.15);
  await clickUnique(ego, '[role=option],li,button,[role=menuitem]', { text: "商务", exact: true });
  await ego.wait(0.25);
  const reread = await readRole();
  if (reread !== "商务") throw new EgoRecruitmentError("ROLE_SWITCH_FAILED");
  return { role: "商务", verified: true };
}

async function clickTab(ego, labelInput) {
  const labels = Array.isArray(labelInput) ? labelInput : [labelInput];
  const marker = "data-ego-tab-target";
  const marked = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[' + input.marker + ']').forEach(el => el.removeAttribute(input.marker));
    const candidates = [...document.querySelectorAll('[role=tab],[role=checkbox],.el-tabs__item,.ant-tabs-tab,.el-checkbox-button')]
      .filter(el => visible(el));
    const exact = candidates.filter(el => input.labels.includes(normalize(el.innerText || el.textContent)));
    const tabs = exact.length > 0 ? exact : candidates.filter(el => (
      input.labels.some(label => normalize(el.innerText || el.textContent).includes(label))
    ));
    if (tabs.length !== 1) return null;
    tabs[0].setAttribute(input.marker, 'true');
    tabs[0].focus();
    const rect = tabs[0].getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  `, { labels, marker });
  if (!marked) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS");
  await ego.pressKey("Enter");
  await ego.wait(0.2);
  let active = await dom(ego, String.raw`
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const tab = document.querySelector('[' + input.marker + ']');
    return !!(tab && (
      tab.getAttribute('aria-selected') === 'true' ||
      tab.getAttribute('aria-checked') === 'true' ||
      tab.classList.contains('is-active') || tab.classList.contains('is-checked') ||
      tab.classList.contains('ant-tabs-tab-active')
    ) && input.labels.some(label => normalize(tab.innerText || tab.textContent).includes(label)));
  `, { labels, marker });
  if (!active) {
    await ego.click([marked.x, marked.y]);
    await ego.wait(0.2);
    active = await dom(ego, String.raw`
      const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
      const tab = document.querySelector('[' + input.marker + ']');
      return !!(tab && (
        tab.getAttribute('aria-selected') === 'true' ||
        tab.getAttribute('aria-checked') === 'true' ||
        tab.classList.contains('is-active') || tab.classList.contains('is-checked') ||
        tab.classList.contains('ant-tabs-tab-active')
      ) && input.labels.some(label => normalize(tab.innerText || tab.textContent).includes(label)));
    `, { labels, marker });
  }
  if (!active) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
}

async function commitCreatorSearch(ego, selector, creatorId, { pressEnter }) {
  const target = await visibleCenter(ego, selector);
  if (target.count === 0) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_MISSING");
  if (target.count !== 1 || target.center === null) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS");
  const cleared = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const inputs = [...document.querySelectorAll(input.selector)].filter(visible);
    if (inputs.length !== 1) return false;
    const element = inputs[0];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (typeof setter !== 'function') return false;
    setter.call(element, '');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === '';
  `, { selector });
  if (!cleared) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "creator search could not clear");
  await ego.fillInput(selector, creatorId);
  const dispatched = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const inputs = [...document.querySelectorAll(input.selector)].filter(visible);
    if (inputs.length !== 1 || inputs[0].value !== input.creatorId) return false;
    const element = inputs[0];
    element.focus();
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.creatorId }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (input.pressEnter) {
      for (const type of ['keydown', 'keyup']) {
        element.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }));
      }
    }
    return true;
  `, { selector, creatorId, pressEnter });
  if (!dispatched) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "creator search did not dispatch");
  await ego.wait(0.5);
}

async function searchCreator(ego, creatorId, kind, { allowZero = false } = {}) {
  const selector = 'input[placeholder*="达人ID"],input[placeholder*="星图ID"]';
  await commitCreatorSearch(ego, selector, creatorId, { pressEnter: true });
  const readResult = () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
      const countValues = [...document.querySelectorAll('*')].filter(visible).map(el => normalize(el.innerText))
        .map(text => /^共\s*(\d+)\s*条(?:记录)?$/u.exec(text))
        .filter(Boolean).map(match => Number(match[1]));
      const counts = [...new Set(countValues)];
      const pricedRows = [...document.querySelectorAll('tbody tr')]
        .filter(el => visible(el) && el.closest('.el-table__body-wrapper'))
        .map(el => normalize(String(el.innerText || '') + ' ' + String(el.textContent || '')))
        .filter(text => /(?:¥|￥)\s*[\d,.]+/u.test(text));
      const uniquePricedRows = [...new Set(pricedRows)];
      const idRows = uniquePricedRows.filter(text => text.includes(input.creatorId));
      const resolvedRows = input.kind === 'DELIVERIES' && counts.length === 1 && counts[0] === 1 && idRows.length === 0
        ? uniquePricedRows
        : idRows;
      const exactCount = resolvedRows.length;
      return { count: exactCount, reportedCounts: counts, rowCount: resolvedRows.length, rowText: exactCount === 1 ? resolvedRows[0] : null };
    `, { creatorId, kind });
  const accepts = (value) => (
    value?.count === 1 && value.rowCount === 1 &&
      Array.isArray(value.reportedCounts) && value.reportedCounts.length === 1 && value.reportedCounts[0] === 1 &&
      typeof value.rowText === "string" && /(?:¥|￥)\s*[\d,.]+/u.test(value.rowText) &&
      (kind === "DELIVERIES" || value.rowText.includes(creatorId))
  ) || (
    allowZero && value?.count === 0 && value.rowCount === 0 && value.rowText === null &&
      Array.isArray(value.reportedCounts) && value.reportedCounts.length === 1 && value.reportedCounts[0] === 0
  );
  let first = await readResult();
  if (kind === "DELIVERIES" && !accepts(first)) first = await readResult();
  const result = accepts(first) ? first : await waitForStableValue(ego, readResult, {
    accept: (value) => (
      value?.count === 1 && value.rowCount === 1 &&
        Array.isArray(value.reportedCounts) && value.reportedCounts.length === 1 && value.reportedCounts[0] === 1 &&
        typeof value.rowText === "string" && /(?:¥|￥)\s*[\d,.]+/u.test(value.rowText) &&
        (kind === "DELIVERIES" || value.rowText.includes(creatorId))
    ) || (
      allowZero && value?.count === 0 && value.rowCount === 0 && value.rowText === null &&
        Array.isArray(value.reportedCounts) && value.reportedCounts.length === 1 && value.reportedCounts[0] === 0
    ),
    reasonCode: "ORDER_BINDING_AMBIGUOUS",
    message: `creator ${creatorId} did not stabilize as one exact priced row`,
  });
  if (!Number.isSafeInteger(result?.count)) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
  if (result.count === 1 && typeof result.rowText !== "string") {
    throw new EgoRecruitmentError(result.rowCount === 0 ? "UI_STRUCTURE_DRIFT" : "ORDER_BINDING_AMBIGUOUS");
  }
  return result;
}

async function findEligibleCreator(ego, creatorId) {
  await clickTab(ego, ["全部报名达人", "已报名达人"]);
  let result = await searchCreator(ego, creatorId, "APPLICANTS", { allowZero: true });
  if (result.count === 1) return result;
  await clickTab(ego, "高价值未报名达人");
  result = await searchCreator(ego, creatorId, "APPLICANTS", { allowZero: true });
  if (result.count === 0) return null;
  return result;
}

async function navigateActivity(ego, origins, activityId) {
  const info = await navigate(ego, origins.xingtu, `/ad/creator/recruitment/detail/${activityId}`);
  if (!new URL(info.url).pathname.endsWith(`/recruitment/detail/${activityId}`)) {
    throw new EgoRecruitmentError("ORDER_BINDING_AMBIGUOUS");
  }
  await waitForStableValue(ego, () => dom(ego, String.raw`
      const text = document.body.innerText || '';
      return { recruitment: text.includes('招募'), activity: text.includes(input.activityId), account: text.includes('爱回收') };
    `, { activityId }), {
    accept: (identity) => identity?.recruitment === true && (identity.activity === true || identity.account === true),
    reasonCode: "ACCOUNT_MISMATCH",
    message: `activity ${activityId} identity did not stabilize`,
  });
}

async function readDelivery(ego, input, { allowZero }) {
  await clickTab(ego, "达人交付情况");
  const result = await searchCreator(ego, input.creatorId, "DELIVERIES", { allowZero });
  if (result.count === 0 && allowZero) return [];
  if (result.count !== 1) throw new EgoRecruitmentError("ORDER_BINDING_AMBIGUOUS");
  const deadline = /20\d{2}-\d{2}-\d{2}/u.exec(result.rowText)?.[0];
  const priceMinorUnits = moneyMinor(result.rowText);
  if (!deadline || priceMinorUnits !== input.priceMinorUnits) throw new EgoRecruitmentError("ORDER_BINDING_AMBIGUOUS");
  const delivery = {
    deliveryId: `${input.activityId}:${input.creatorId}`,
    activityId: input.activityId,
    creatorId: input.creatorId,
    priceMinorUnits,
    deliveryDeadline: deadline,
  };
  return allowZero ? [delivery] : delivery;
}

async function openRecruitmentDraft(ego, creatorId) {
  let dialog = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    return [...document.querySelectorAll('[role=dialog],.ant-modal-content,.el-dialog')]
      .some(el => visible(el) && (el.innerText || '').includes('立即下单'));
  `);
  if (dialog) return { prepared: true, tier: "EGO_SEMANTIC" };
  const result = await findEligibleCreator(ego, creatorId);
  if (result === null) throw new EgoRecruitmentError("CREATOR_NOT_ELIGIBLE_IN_ACTIVITY");
  if (result.count !== 1) throw new EgoRecruitmentError("ORDER_BINDING_AMBIGUOUS");
  await ego.captureScreenshot();
  const target = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('tbody tr')]
      .filter(el => visible(el) && normalize(el.textContent).includes(input.creatorId));
    const buttons = rows.flatMap(row => [...row.querySelectorAll('button,[role=button]')])
      .filter(el => {
        const label = normalize(el.innerText) || normalize(el.textContent);
        if (!visible(el) || label !== '下单') return false;
        const rect = el.getBoundingClientRect();
        return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      });
    const unique = [...new Set(buttons)];
    if (unique.length !== 1) return null;
    const rect = unique[0].getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  `, { creatorId });
  if (!target) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS");
  await ego.click([target.x, target.y]);
  await ego.wait(0.2);
  dialog = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    return [...document.querySelectorAll('[role=dialog],.ant-modal-content,.el-dialog')]
      .some(el => visible(el) && (el.innerText || '').includes('立即下单'));
  `);
  if (!dialog) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
  return { prepared: true, tier: "EGO_VISUAL" };
}

async function commitDeadline(ego, deliveryDeadline) {
  const selector = '[role=dialog] input,.ant-modal-content input,.el-dialog input';
  const candidates = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const inputs = [...document.querySelectorAll(input.selector)].filter(visible);
    return inputs.map((el, index) => ({ index, value: el.value, placeholder: el.placeholder }));
  `, { selector });
  const target = candidates.find(({ placeholder, value }) => /日期|选择/u.test(placeholder || "") || /^20\d{2}-\d{2}-\d{2}$/u.test(value || ""));
  if (!target) throw new EgoRecruitmentError("VISUAL_COMMIT_REQUIRED");
  const marker = "data-ego-recruitment-deadline";
  await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const inputs = [...document.querySelectorAll(input.selector)].filter(visible);
    document.querySelectorAll('[' + input.marker + ']').forEach(el => el.removeAttribute(input.marker));
    const el = inputs[input.index];
    if (el) el.setAttribute(input.marker, 'true');
    return !!el;
  `, { selector, index: target.index, marker });
  await ego.fillInput(`[${marker}="true"]`, deliveryDeadline);
  await ego.pressKey("Enter");
  await ego.wait(0.15);
  const value = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const inputs = [...document.querySelectorAll(input.selector)].filter(visible);
    return inputs[input.index]?.value ?? null;
  `, { selector, index: target.index });
  await dom(ego, String.raw`document.querySelectorAll('[' + input.marker + ']').forEach(el => el.removeAttribute(input.marker)); true`, { marker });
  if (value !== deliveryDeadline) throw new EgoRecruitmentError("VISUAL_COMMIT_REQUIRED");
  return { committed: true };
}

async function snapshotRefFor(ego, role, label) {
  const snapshot = typeof ego.snapshot === "function" ? ego.snapshot.bind(ego) : ego.snapshotText?.bind(ego);
  if (typeof snapshot !== "function") return null;
  const raw = await snapshot();
  const content = typeof raw === "string" ? raw : raw?.content;
  if (typeof content !== "string") return null;
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`${role} \\[ref=(\\d+)[^\\]]*\\]`, "u").exec(lines[index]);
    if (!match) continue;
    const baseIndent = /^\s*/u.exec(lines[index])?.[0].length ?? 0;
    const descendants = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim().length > 0 && (/^\s*/u.exec(line)?.[0].length ?? 0) <= baseIndent) break;
      descendants.push(line);
    }
    const block = descendants.join("\n");
    if (block.includes(`text "${label}"`)) return `@${match[1]}`;
  }
  return null;
}

async function dispatchVisibleButton(ego, label, controls, observe) {
  if (typeof controls?.beforeDispatch !== "function") throw new EgoRecruitmentError("NON_OCCURRENCE_UNPROVEN");
  await ego.captureScreenshot();
  const marker = "data-ego-stateful-dispatch-target";
  const marked = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[' + input.marker + ']').forEach(el => el.removeAttribute(input.marker));
    const roots = [...document.querySelectorAll('[role=dialog],.ant-modal-content,.el-dialog')].filter(visible);
    const nodes = roots.flatMap(root => [...root.querySelectorAll('button,[role=button]')])
      .filter(el => visible(el) && (normalize(el.innerText) || normalize(el.textContent)) === input.label);
    const unique = [...new Set(nodes)];
    if (unique.length !== 1) return false;
    unique[0].setAttribute(input.marker, 'true');
    unique[0].focus();
    return true;
  `, { label, marker });
  if (!marked) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS");
  await controls.beforeDispatch();
  let dispatched = false;
  try {
    dispatched = true;
    await ego.click(`[${marker}]`, { label: `dispatch ${label}` });
    let observed = false;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      await ego.wait(0.25);
      if (await observe()) {
        observed = true;
        break;
      }
    }
    if (!observed) throw new EgoRecruitmentError("ACTION_RESULT_UNKNOWN", `${label} result is unknown`, { dispatched: true });
    return { outcome: "COMPLETED", reasonCode: null, dispatchState: "OBSERVED" };
  } catch (error) {
    if (error instanceof EgoRecruitmentError) throw error;
    throw new EgoRecruitmentError("ACTION_RESULT_UNKNOWN", `${label} dispatch failed`, { dispatched });
  }
}

async function openInternalConfirmation(ego, origins, input, rules) {
  const readDialog = () => dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const dialog = [...document.querySelectorAll('[role=dialog],.ant-modal-content')]
      .find(el => visible(el) && (el.innerText || '').includes(input.orderId));
    if (!dialog) return null;
    const task = dialog.querySelector('#externalOrderNo,input[placeholder*="任务 ID"],input[placeholder*="任务ID"]');
    return { text: dialog.innerText || '', taskId: task?.value ?? null };
  `, input);
  let dialog = await readDialog();
  if (!dialog) {
    await searchInternalOrder(ego, origins, input.orderId);
    await dom(ego, String.raw`
      const table = [...document.querySelectorAll('.ant-table-content')].find(el => el.getClientRects().length);
      if (table) table.scrollLeft = table.scrollWidth;
      return table ? { left: table.scrollLeft, width: table.scrollWidth } : null;
    `);
    await ego.wait(0.1);
    const target = await dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const row = [...document.querySelectorAll('tbody tr')].find(el => visible(el) && (el.innerText || '').includes(input.orderId));
      const buttons = row ? [...row.querySelectorAll('button,[role=button]')].filter(el => {
        if (!visible(el) || ((el.innerText || '').trim() || (el.textContent || '').trim()) !== '确认下单') return false;
        const rect = el.getBoundingClientRect();
        return rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      }) : [];
      if (buttons.length !== 1) return null;
      const rect = buttons[0].getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    `, input);
    if (!target) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_MISSING");
    await ego.click([target.x, target.y]);
    dialog = await waitForStableValue(ego, readDialog, {
      accept: value => value !== null,
      reasonCode: "UI_STRUCTURE_DRIFT",
      message: "internal confirmation dialog did not stabilize",
    });
  }
  if (!dialog) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
  const taskSelector = '#externalOrderNo,input[placeholder*="任务 ID"],input[placeholder*="任务ID"]';
  if (dialog.taskId !== input.activityId) {
    await realKeyboardInput(ego, taskSelector, input.activityId);
    dialog = await waitForStableValue(ego, readDialog, {
      accept: value => value?.taskId === input.activityId,
      reasonCode: "ORDER_BINDING_AMBIGUOUS",
      message: "internal task binding did not stabilize",
    });
  }
  if (dialog?.text.includes(rules.advertiser.fixedId)) {
    return { taskId: input.activityId, advertiserId: rules.advertiser.fixedId };
  }
  const advertiser = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const dialog = [...document.querySelectorAll('[role=dialog],.ant-modal-content')]
      .find(el => visible(el) && (el.innerText || '').includes(input.orderId));
    if (!dialog) return null;
    const select = dialog.querySelector('#platformAccountId,[role=combobox]');
    if (!select || !visible(select)) return null;
    const rect = select.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  `, input);
  if (!advertiser) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_MISSING");
  await ego.click([advertiser.x, advertiser.y]);
  const readAdvertiserOption = () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const options = [...document.querySelectorAll('.ant-select-item-option')].filter(el => {
        if (!visible(el) || !(el.innerText || el.textContent || '').includes(input.advertiserId)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
          rect.left < innerWidth && rect.top < innerHeight;
      });
      if (options.length !== 1) return null;
      const rect = options[0].getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    `, { advertiserId: rules.advertiser.fixedId });
  const option = await waitForStableValue(ego, readAdvertiserOption, {
    accept: value => value !== null,
    reasonCode: "SEMANTIC_LOCATOR_AMBIGUOUS",
    message: "internal advertiser option did not stabilize",
  });
  await ego.click([option.x, option.y]);
  await waitForStableValue(ego, () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const dialog = [...document.querySelectorAll('[role=dialog],.ant-modal-content')]
        .find(el => visible(el) && (el.innerText || '').includes(input.orderId));
      return !!(dialog && (dialog.innerText || '').includes(input.advertiserId));
    `, { orderId: input.orderId, advertiserId: rules.advertiser.fixedId }), {
    accept: value => value === true,
    reasonCode: "ORDER_BINDING_AMBIGUOUS",
    message: "internal advertiser binding did not stabilize",
  });
  return { taskId: input.activityId, advertiserId: rules.advertiser.fixedId };
}

async function rereadInternalWriteback(ego, origins, input, rules) {
  await navigate(ego, origins.placement, "/orders");
  const value = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const dialog = [...document.querySelectorAll('[role=dialog],.ant-modal-content')].find(visible);
    if (!dialog) return null;
    const task = [...dialog.querySelectorAll('input')].find(el => visible(el) && /任务\s*ID/u.test(el.placeholder || ''));
    return { taskId: task?.value ?? null, text: dialog.innerText || '' };
  `);
  if (!value || value.taskId !== input.activityId || !value.text.includes(rules.advertiser.fixedId)) {
    throw new EgoRecruitmentError("ORDER_BINDING_AMBIGUOUS");
  }
  return { taskId: input.activityId, advertiserId: rules.advertiser.fixedId };
}

async function readInternalPage(ego) {
  await dom(ego, String.raw`
    const table = [...document.querySelectorAll('.ant-table-content')].find(el => el.getClientRects().length);
    if (table) table.scrollLeft = table.scrollWidth;
    return table ? { left: table.scrollLeft, width: table.scrollWidth } : null;
  `);
  await ego.wait(0.1);
  return dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const rows = [...document.querySelectorAll('tbody tr')].filter(visible).map(tr => ({
      text: (tr.innerText || '').replace(/\s+/g, ' ').trim(),
      cells: [...tr.querySelectorAll('td')].map(td => (td.innerText || '').replace(/\s+/g, ' ').trim()),
    }));
    const next = [...document.querySelectorAll('.ant-pagination-next button,button,[role=button]')].find(el => {
      if (!visible(el)) return false;
      const label = [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText, el.textContent].filter(Boolean).join(' ');
      return /下一页|next|right/u.test(label) || el.closest('.ant-pagination-next');
    });
    const parent = next?.closest('.ant-pagination-next');
    const disabled = !next || next.disabled || next.getAttribute('aria-disabled') === 'true' ||
      next.classList.contains('ant-pagination-disabled') || parent?.classList.contains('ant-pagination-disabled');
    const activePage = Number(document.querySelector('.ant-pagination-item-active')?.innerText || '1');
    if (next && !disabled) next.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (next) { const rect = next.getBoundingClientRect(); return { rows, activePage, disabled, next: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } }; }
    return { rows, activePage, disabled: true, next: null };
  `);
}

function pageProvesDateCoverage(page, filters) {
  if (page.disabled) return true;
  if (page.activePage !== 1 || page.rows.length === 0) return false;
  const instants = page.rows.map(({ text }) => {
    const value = /20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.exec(text)?.[0];
    return value ? Date.parse(`${value.replace(" ", "T")}+08:00`) : NaN;
  });
  if (instants.some((instant) => !Number.isFinite(instant))) return false;
  if (instants.some((instant, index) => index > 0 && instant > instants[index - 1])) return false;
  const start = Date.parse(filters.createdAt.start);
  const newest = instants[0];
  const oldest = instants.at(-1);
  return newest < start || (newest >= start && oldest < start);
}

async function collectInternalRows(ego) {
  const rows = [];
  const seen = new Set();
  let current = await readInternalPage(ego);
  for (let page = 0; page < 100; page += 1) {
    const digest = JSON.stringify(current.rows);
    if (seen.has(digest)) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "pagination repeated a page");
    seen.add(digest);
    rows.push(...current.rows);
    if (current.disabled) break;
    await ego.click([current.next.x, current.next.y], { label: "next filtered orders page" });
    let changed = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await ego.wait(0.2);
      const candidate = await readInternalPage(ego);
      if (JSON.stringify(candidate.rows) !== digest) {
        changed = candidate;
        break;
      }
    }
    if (changed === null) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "pagination did not advance");
    current = changed;
  }
  return rows;
}

function dateOnly(value) {
  return String(value).slice(0, 10);
}

function rangeEndInclusive(value) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
  return new Date(instant.getTime() - 1).toISOString().slice(0, 10);
}

async function clickOwnText(ego, text, within = null, { required = true } = {}) {
  const target = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const root = input.within
      ? [...document.querySelectorAll(input.within)].find(el => visible(el) && (el.innerText || '').includes('筛选订单'))
      : document;
    if (!root) return { count: 0 };
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const nodes = [...root.querySelectorAll('*')].filter(visible).filter(el => {
      const own = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('');
      return normalize(own) === input.text;
    });
    const leaves = nodes.filter(el => ![...el.children].some(child => visible(child) && normalize(child.innerText || child.textContent) === input.text));
    const matches = leaves.length > 0 ? leaves : nodes;
    if (matches.length !== 1) return { count: matches.length, center: null };
    const clickable = matches[0].closest('button') || matches[0];
    const rect = clickable.getBoundingClientRect();
    return { count: 1, center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
  `, { text, within });
  if (target.count === 0 && !required) return false;
  if (target.count === 0) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_MISSING", text);
  if (target.count !== 1 || target.center === null) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS", text);
  await ego.click([target.center.x, target.center.y]);
  await ego.wait(0.15);
  return true;
}

async function closeFilterDrawer(ego) {
  const readOpen = () => dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    return [...document.querySelectorAll('[role=dialog],.ant-drawer-section,.ant-drawer-content')]
      .some(el => visible(el) && (el.innerText || '').includes('筛选订单'));
  `);
  const open = await readOpen();
  if (open) {
    await ego.pressKey("Escape");
  }
  await waitForStableValue(ego, readOpen, {
    accept: (value) => value === false,
    message: "filter drawer did not close",
  });
}

async function clearActiveFilters(ego) {
  const target = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const tags = [...document.querySelectorAll('.ant-tag')].filter(visible).filter(el => {
      const own = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
      return own === '清除全部';
    });
    if (tags.length === 0) return { count: 0, center: null };
    if (tags.length !== 1) return { count: tags.length, center: null };
    const close = tags[0].querySelector('.ant-tag-close-icon');
    if (!close || !visible(close)) return { count: 1, center: null };
    const rect = close.getBoundingClientRect();
    return { count: 1, center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
  `);
  let clicked = false;
  if (target.count > 1 || (target.count === 1 && target.center === null)) {
    throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "clear filters control");
  }
  if (target.count === 1) {
    await ego.click([target.center.x, target.center.y], { label: "clear inherited order filters" });
    clicked = true;
  }
  await waitForStableValue(ego, () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const label = [...document.querySelectorAll('button')].filter(visible)
        .map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .find(text => /^筛选(?:\(\d+\))?$/u.test(text));
      return (label === '筛选' || label === '筛选(0)') &&
        ![...document.querySelectorAll('.ant-tag')].some(el => visible(el) && (el.innerText || '').includes('清除全部'));
    `), {
    accept: (value) => value === true,
    message: "active filters did not clear",
  });
  return clicked;
}

async function verifyInternalTable(ego) {
  const table = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const headers = [...document.querySelectorAll('th')].filter(visible).map(el => (el.innerText || '').replace(/\s+/g, '').trim());
    const content = [...document.querySelectorAll('.ant-table-content')].find(visible);
    if (content) content.scrollLeft = content.scrollWidth;
    return { hasTable: !!content, headers, right: content?.scrollLeft ?? null };
  `);
  if (!table?.hasTable || !["达人昵称", "达人id", "平台", "任务类型", "状态", "创建时间"].every((value) => table.headers.some((header) => header.includes(value)))) {
    throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
  }
  await ego.wait(0.1);
}

async function prepareInternalTableScan(ego, origins) {
  await navigate(ego, origins.placement, "/orders");
  await dom(ego, "scrollTo(0, 0); true");
  await ego.wait(0.1);
  await closeFilterDrawer(ego);
  const search = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const inputs = [...document.querySelectorAll('input[placeholder*="搜索订单编号"]')].filter(visible);
    return inputs.length === 1 ? inputs[0].value : null;
  `);
  if (search === null) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
  if (search !== "") await realKeyboardInput(ego, 'input[placeholder*="搜索订单编号"]', "");
  await clearActiveFilters(ego);
  await verifyInternalTable(ego);
}

async function openFilterDrawer(ego) {
  const target = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const matches = [...document.querySelectorAll('button')].filter(el => visible(el) && /^筛选(?:\(\d+\))?$/u.test((el.innerText || '').trim()));
    if (matches.length !== 1) return { count: matches.length, center: null };
    const rect = matches[0].getBoundingClientRect();
    return { count: 1, center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
  `);
  if (target.count === 0) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_MISSING");
  if (target.count !== 1 || target.center === null) throw new EgoRecruitmentError("SEMANTIC_LOCATOR_AMBIGUOUS");
  await ego.click([target.center.x, target.center.y]);
  await waitForStableValue(ego, () => dom(ego, String.raw`
      const drawers = [...document.querySelectorAll('[role=dialog],.ant-drawer-section')]
        .filter(el => (el.innerText || '').includes('筛选订单'))
        .map(el => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; })
        .filter(rect => rect.width > 0);
      return { count: drawers.length, drawer: drawers.length === 1 ? drawers[0] : null, viewportWidth: innerWidth };
    `), {
    accept: (value) => value?.count === 1 && value.drawer !== null &&
      value.drawer.left >= 0 && value.drawer.right <= value.viewportWidth && value.drawer.width > 0,
    message: "filter drawer did not stabilize inside the viewport",
  });
}

async function chooseDrawerSelect(ego, fieldLabel, optionLabel) {
  const select = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const root = [...document.querySelectorAll('[role=dialog],.ant-drawer-section')]
      .find(el => visible(el) && (el.innerText || '').includes('筛选订单'));
    if (!root) return { count: 0, center: null };
    const matches = [...root.querySelectorAll('.ant-select')].filter(visible).filter(el => {
      const text = (el.parentElement?.innerText || '').replace(/\s+/g, ' ').trim();
      return text.startsWith(input.fieldLabel + ' ');
    });
    if (matches.length !== 1) return { count: matches.length, center: null };
    const rect = matches[0].getBoundingClientRect();
    return { count: 1, center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
  `, { fieldLabel });
  if (select.count !== 1 || select.center === null) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", fieldLabel);
  await ego.click([select.center.x, select.center.y]);
  await ego.wait(0.15);
  await clickUnique(ego, ".ant-select-item-option", { text: optionLabel, exact: true });
  await ego.wait(0.15);
}

async function chooseDrawerDateRange(ego, startDate, endDate) {
  const inputs = await waitForStableValue(ego, () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const startInputs = [...document.querySelectorAll('input[placeholder="开始日期"]')].filter(visible);
      const endInputs = [...document.querySelectorAll('input[placeholder="结束日期"]')].filter(visible);
      const center = el => { const rect = el.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; };
      return startInputs.length === 1 && endInputs.length === 1
        ? { start: center(startInputs[0]), end: center(endInputs[0]) }
        : { start: null, end: null };
    `), {
    accept: (value) => value?.start !== null && value?.end !== null,
    message: "custom date inputs did not stabilize",
  });
  await ego.click([inputs.start.x, inputs.start.y], { label: "open custom order date range" });
  await ego.wait(0.15);
  for (const value of [startDate, endDate]) {
    const cell = await dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const matches = [...document.querySelectorAll('.ant-picker-cell')].filter(visible).filter(el => (
        el.getAttribute('title') === input.value && el.classList.contains('ant-picker-cell-in-view')
      ));
      if (matches.length !== 1) return { count: matches.length, center: null };
      const rect = matches[0].getBoundingClientRect();
      return { count: 1, center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
    `, { value });
    if (cell.count !== 1 || cell.center === null) {
      throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", `date cell ${value}`);
    }
    await ego.click([cell.center.x, cell.center.y]);
    await ego.wait(0.15);
  }
  const reread = await waitForStableValue(ego, () => dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const start = [...document.querySelectorAll('input[placeholder="开始日期"]')].filter(visible);
      const end = [...document.querySelectorAll('input[placeholder="结束日期"]')].filter(visible);
      return start.length === 1 && end.length === 1 ? { start: start[0].value, end: end[0].value } : null;
    `), {
    accept: (value) => value?.start === startDate && value?.end === endDate,
    message: "custom date range did not stabilize",
  });
  if (reread?.start !== startDate || reread?.end !== endDate) {
    throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "custom date range did not commit");
  }
}

async function waitForFilteredRows(ego, filters) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await dom(ego, String.raw`
      const visible = el => !!(el && el.getClientRects().length);
      const rows = [...document.querySelectorAll('tbody tr')].filter(visible).map(tr => (
        (tr.innerText || '').replace(/\s+/g, ' ').trim()
      )).filter(text => /\bORD[A-Za-z0-9_-]+\b/u.test(text));
      const loading = [...document.querySelectorAll('.ant-spin-spinning,[aria-busy="true"]')].some(visible);
      return { rows, loading };
    `);
    // The placement API currently accepts the exact custom date range but may
    // return adjacent dates. Keep the server-side filter for narrowing, then
    // enforce the requested date locally while reading every filtered page.
    const matches = !state.loading && state.rows.every((text) => (
      text.includes(filters.platform) && text.includes(filters.status) && text.includes(filters.taskType)
    ));
    if (matches) return state.rows;
    if (attempt + 1 < 12) await ego.wait(0.2);
  }
  throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "filtered result table did not retain the requested non-date filters");
}

async function applyExactBatchFilters(ego, origins, filters) {
  await prepareInternalTableScan(ego, origins);
  await openFilterDrawer(ego);
  await clickOwnText(ego, "重置", '[role=dialog],.ant-drawer-section');
  await clickOwnText(ego, filters.platform, '[role=dialog],.ant-drawer-section');
  await clickOwnText(ego, "自定义", '[role=dialog],.ant-drawer-section');
  await chooseDrawerDateRange(
    ego,
    dateOnly(filters.createdAt.start),
    rangeEndInclusive(filters.createdAt.endExclusive),
  );
  await chooseDrawerSelect(ego, "订单状态", filters.status);
  await chooseDrawerSelect(ego, "任务类型", filters.taskType);
  await clickOwnText(ego, "应用筛选", '[role=dialog],.ant-drawer-section');
  await waitForStableValue(ego, () => dom(ego, String.raw`
      const openDrawers = [...document.querySelectorAll('[role=dialog],.ant-drawer-section')]
        .filter(el => (el.innerText || '').includes('筛选订单'))
        .map(el => el.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth);
      return openDrawers.length;
    `), {
    accept: (value) => value === 0,
    message: "filter drawer did not finish closing after apply",
  });
  const summary = await dom(ego, String.raw`
    const visible = el => !!(el && el.getClientRects().length);
    const drawerOpen = [...document.querySelectorAll('[role=dialog],.ant-drawer-section')]
      .some(el => visible(el) && (el.innerText || '').includes('筛选订单'));
    const buttons = [...document.querySelectorAll('button')].filter(visible).map(el => (el.innerText || '').replace(/\s+/g, ' ').trim());
    const clear = [...document.querySelectorAll('*')].filter(visible).find(el => {
      const own = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
      return own === '清除全部';
    });
    const activeText = (clear?.parentElement?.parentElement?.innerText || '').replace(/\s+/g, ' ').trim();
    return { drawerOpen, buttons, activeText };
  `);
  if (
    summary?.drawerOpen || !summary?.buttons?.some((label) => /^筛选\(4\)$/u.test(label)) ||
    ![filters.platform, filters.status].every((value) => summary.activeText.includes(value)) ||
    !(summary.activeText.includes(filters.taskType) || /任务类型:\s*RECRUIT/u.test(summary.activeText)) ||
    !(summary.activeText.includes("自定义") || (
      summary.activeText.includes(dateOnly(filters.createdAt.start)) &&
      summary.activeText.includes(rangeEndInclusive(filters.createdAt.endExclusive))
    ))
  ) throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", "effective recruitment filters are incomplete");
  await waitForFilteredRows(ego, filters);
  await verifyInternalTable(ego);
  return filters;
}

async function readBudget(ego, input) {
  const values = await dom(ego, String.raw`
    const text = document.body.innerText || '';
    const amountNear = label => {
      const escaped = label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      return new RegExp('([¥￥]\\s*[\\d,.]+)[^¥￥\\d]{0,20}' + escaped, 'u').exec(text)?.[1]
        ?? new RegExp(escaped + '[^¥￥\\d]{0,20}([¥￥]\\s*[\\d,.]+)', 'u').exec(text)?.[1]
        ?? null;
    };
    return { total: amountNear('任务总预算'), committed: amountNear('预计总费用') };
  `);
  if (!values?.total || !values?.committed) throw new EgoRecruitmentError("BUDGET_ERROR_UNRECOGNIZED");
  return { activityId: input.activityId, totalBudgetMinorUnits: moneyMinor(values.total), consumedBudgetMinorUnits: moneyMinor(values.committed) };
}

async function executeSemantic({ ego, operation, input, rules, uiContract, origins, controls }) {
  switch (operation) {
    case "ENSURE_INTERNAL_BUSINESS_ROLE":
      return ensureBusinessRole(ego, origins);
    case "VERIFY_BATCH_FILTERS": {
      if (input.discoveryMode === "TABLE_FIRST") {
        await prepareInternalTableScan(ego, origins);
        return input.filters;
      }
      if (input.discoveryMode !== "FILTER_FIRST") throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
      return applyExactBatchFilters(ego, origins, input.filters);
    }
    case "READ_ORDERS_BY_ID": {
      const result = [];
      for (const orderId of input.orderIds) {
        try {
          const record = await searchInternalOrder(ego, origins, orderId);
          result.push({ orderId, createdAt: record.createdAt });
        } catch (error) {
          if (error?.reasonCode === "ORDER_NOT_FOUND") result.push({ orderId, createdAt: null });
          else throw error;
        }
      }
      return result;
    }
    case "READ_ORDER_SNAPSHOT": {
      const record = await searchInternalOrder(ego, origins, input.orderId);
      return {
        activityId: record.activityId,
        snapshotInput: {
          orderId: record.orderId,
          orderType: "RECRUITMENT",
          projectType: "RECRUITMENT",
          creatorId: record.creatorId,
          amount: { currency: "CNY", minorUnits: moneyMinor(record.amountText) },
          plannedDate: "IGNORED_BY_RULE",
          orderStatus: record.orderStatus,
          bfRefs: [], assetRefs: [], rulesVersion: rules.rulesVersion, executorVersion: "rc.11-ego-lite",
        },
      };
    }
    case "DISCOVER_CREATOR_CANDIDATES": {
      let rows;
      let coverageComplete;
      if (input.discoveryMode === "TABLE_FIRST") {
        await prepareInternalTableScan(ego, origins);
        const page = await readInternalPage(ego);
        rows = page.rows;
        coverageComplete = pageProvesDateCoverage(page, input.filters);
      } else if (input.discoveryMode === "FILTER_FIRST") {
        await applyExactBatchFilters(ego, origins, input.filters);
        rows = await collectInternalRows(ego);
        coverageComplete = true;
      } else {
        throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
      }
      const start = Date.parse(input.filters.createdAt.start);
      const end = Date.parse(input.filters.createdAt.endExclusive);
      const candidates = rows.filter((row) => {
        const createdAt = /20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.exec(row.text)?.[0]?.replace(" ", "T") + "+08:00";
        const instant = Date.parse(createdAt);
        return row.text.includes(input.creatorName) && row.text.includes(input.filters.platform) &&
          row.text.includes(input.filters.status) && row.text.includes(input.filters.taskType) &&
          Number.isFinite(instant) && instant >= start && instant < end;
      }).map((row) => {
        try {
          const match = /\b\d{16,20}\b/u.exec(row.text)?.[0];
          return match ? { creatorId: match, creatorName: input.creatorName } : null;
        } catch { return null; }
      }).filter(Boolean);
      const unique = [...new Map(candidates.map((entry) => [entry.creatorId, entry])).values()];
      return {
        candidates: unique,
        coverageComplete,
      };
    }
    case "READ_MATCHING_ORDERS": {
      let rows;
      if (input.discoveryMode === "TABLE_FIRST") rows = (await readInternalPage(ego)).rows;
      else if (input.discoveryMode === "FILTER_FIRST") rows = await collectInternalRows(ego);
      else throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT");
      return rows.flatMap((row) => {
        const orderId = /\bORD[A-Za-z0-9_-]+\b/u.exec(row.text)?.[0];
        const creatorId = /\b\d{16,20}\b/u.exec(row.text)?.[0];
        const createdAt = /20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.exec(row.text)?.[0]?.replace(" ", "T") + "+08:00";
        const instant = Date.parse(createdAt);
        if (!orderId || !createdAt || !row.text.includes("抖音") || !row.text.includes("招募") || !row.text.includes("待商务下单")) return [];
        if (!Number.isFinite(instant) || instant < Date.parse(input.filters.createdAt.start) || instant >= Date.parse(input.filters.createdAt.endExclusive)) return [];
        if (input.targetScope.creatorId !== null && creatorId !== input.targetScope.creatorId) return [];
        return [input.targetScope.creatorId === null ? { orderId, createdAt } : { orderId, creatorId, createdAt }];
      });
    }
    case "READ_HISTORICAL_ORDER_STATUS": {
      const rows = await collectInternalRows(ego);
      return rows.flatMap((row) => {
        const orderId = /\bORD[A-Za-z0-9_-]+\b/u.exec(row.text)?.[0];
        const creatorId = /\b\d{16,20}\b/u.exec(row.text)?.[0];
        const createdAt = /20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.exec(row.text)?.[0]?.replace(" ", "T") + "+08:00";
        const instant = Date.parse(createdAt);
        const status = ["待商务下单", "商务已下单", "已驳回", "已取消"].find((value) => row.text.includes(value));
        return orderId && creatorId === input.targetScope.creatorId && status &&
          Number.isFinite(instant) && instant >= Date.parse(input.filters.createdAt.start) && instant < Date.parse(input.filters.createdAt.endExclusive)
          ? [{ orderId, creatorId, status }] : [];
      });
    }
    case "OPEN_CREATOR_ORDER": {
      await navigateActivity(ego, origins, input.activityId);
      const result = await findEligibleCreator(ego, input.creatorId);
      if (result === null) {
        return { eligible: false, reasonCode: "CREATOR_NOT_ELIGIBLE_IN_ACTIVITY" };
      }
      if (result.count !== 1 || moneyMinor(result.rowText) !== input.priceMinorUnits) throw new EgoRecruitmentError("ORDER_BINDING_AMBIGUOUS");
      return { activityId: input.activityId, creatorId: input.creatorId, priceMinorUnits: input.priceMinorUnits, entryScope: "EXACT_CREATOR_ROW", globalPublishUsed: false };
    }
    case "PREPARE_RECRUITMENT_DRAFT": {
      await navigateActivity(ego, origins, input.activityId);
      const result = await openRecruitmentDraft(ego, input.creatorId);
      return { prepared: result.prepared, __tier: result.tier };
    }
    case "COMMIT_RECRUITMENT_DEADLINE":
      await navigateActivity(ego, origins, input.activityId);
      return commitDeadline(ego, input.deliveryDeadline);
    case "REREAD_RECRUITMENT_DRAFT": {
      await navigateActivity(ego, origins, input.activityId);
      const deadline = await dom(ego, String.raw`
        const visible = el => !!(el && el.getClientRects().length);
        const values = [...document.querySelectorAll('[role=dialog] input,.ant-modal-content input,.el-dialog input')].filter(visible).map(el => el.value);
        return values.find(value => /^20\d{2}-\d{2}-\d{2}$/u.test(value)) ?? null;
      `);
      return { activityId: input.activityId, creatorId: input.creatorId, priceMinorUnits: input.priceMinorUnits, deliveryDeadline: deadline, entryScope: "EXACT_CREATOR_ROW", globalPublishUsed: false };
    }
    case "REREAD_RECRUITMENT_TASK": {
      await navigateActivity(ego, origins, input.activityId);
      const blockingDialogOpen = await dom(ego, String.raw`
        const visible = el => !!(el && el.getClientRects().length);
        return [...document.querySelectorAll('[role=dialog],.ant-modal-content,.el-dialog')]
          .some(el => visible(el) && /立即下单|追加预算/u.test(el.innerText || ''));
      `);
      if (blockingDialogOpen) {
        await ego.pressKey("Escape");
        await ego.wait(0.15);
      }
      return readDelivery(ego, input, { allowZero: input.lookup === true });
    }
    case "SUBMIT_RECRUITMENT_ORDER":
      await navigateActivity(ego, origins, input.activityId);
      return dispatchVisibleButton(ego, uiContract.actions.recruitmentFinalSubmit.label, controls, async () => dom(ego, String.raw`
        const visible = el => !!(el && el.getClientRects().length);
        const toast = [...document.querySelectorAll('.el-message,.ant-message-notice,[role=alert]')].filter(visible).some(el => /下单成功/u.test(el.innerText || ''));
        const budget = /预算不足|可用预算不足|余额不足/u.test(document.body.innerText || '');
        const dialog = [...document.querySelectorAll('[role=dialog],.ant-modal-content,.el-dialog')].filter(visible).some(el => (el.innerText || '').includes('立即下单'));
        return toast || budget || !dialog;
      `));
    case "READ_RECRUITMENT_SUBMIT_RESULT": {
      for (let attempt = 0; attempt < 46; attempt += 1) {
        const budget = await dom(ego, String.raw`/预算不足|可用预算不足|余额不足/u.test(document.body.innerText || '')`);
        if (budget) return { kind: "BUDGET_INSUFFICIENT" };
        await navigateActivity(ego, origins, input.activityId);
        const budgetState = await readBudget(ego, input);
        if (budgetState.totalBudgetMinorUnits - budgetState.consumedBudgetMinorUnits < input.priceMinorUnits) {
          return { kind: "BUDGET_INSUFFICIENT" };
        }
        const deliveries = await readDelivery(ego, input, { allowZero: true });
        if (deliveries.length === 1) return { kind: "DELIVERY_OBSERVED", delivery: deliveries[0] };
        if (attempt < 45) await ego.wait(2);
      }
      return { kind: "UNKNOWN" };
    }
    case "READ_RECRUITMENT_BUDGET":
    case "REREAD_RECRUITMENT_BUDGET":
      await navigateActivity(ego, origins, input.activityId);
      return readBudget(ego, input);
    case "TOP_UP_RECRUITMENT_BUDGET": {
      await navigateActivity(ego, origins, input.activityId);
      if (input.stepMinorUnits !== uiContract.actions.topUpRecruitmentBudget.amountMinorUnits) {
        throw new EgoRecruitmentError("BUDGET_ERROR_UNRECOGNIZED");
      }
      const amount = String(input.stepMinorUnits / 100);
      let dialog = await dom(ego, String.raw`
        const visible = el => !!(el && el.getClientRects().length);
        const root = [...document.querySelectorAll('[role=dialog],.el-dialog')]
          .find(el => visible(el) && (el.innerText || '').includes('追加预算'));
        if (!root) return null;
        const inputs = [...root.querySelectorAll('input')].filter(visible);
        return inputs.length === 1 ? { value: inputs[0].value } : null;
      `);
      if (!dialog) {
        const entry = await snapshotRefFor(ego, "button", uiContract.actions.topUpRecruitmentBudget.label);
        if (!entry) throw new EgoRecruitmentError("BUDGET_ERROR_UNRECOGNIZED");
        await ego.click(entry, { label: "open recruitment budget top-up" });
        await ego.wait(0.3);
      }
      dialog = await dom(ego, String.raw`
        const visible = el => !!(el && el.getClientRects().length);
        const root = [...document.querySelectorAll('[role=dialog],.el-dialog')]
          .find(el => visible(el) && (el.innerText || '').includes('追加预算'));
        if (!root) return null;
        const inputs = [...root.querySelectorAll('input')].filter(visible);
        return inputs.length === 1 ? { value: inputs[0].value } : null;
      `);
      if (!dialog) throw new EgoRecruitmentError("BUDGET_ERROR_UNRECOGNIZED");
      if (dialog.value !== amount) {
        const inputRef = await snapshotRefFor(ego, "textbox", "请输入");
        if (!inputRef) throw new EgoRecruitmentError("BUDGET_ERROR_UNRECOGNIZED");
        await ego.fillInput(inputRef, amount);
        await ego.wait(0.2);
        dialog = await dom(ego, String.raw`
          const visible = el => !!(el && el.getClientRects().length);
          const root = [...document.querySelectorAll('[role=dialog],.el-dialog')]
            .find(el => visible(el) && (el.innerText || '').includes('追加预算'));
          const inputs = root ? [...root.querySelectorAll('input')].filter(visible) : [];
          return inputs.length === 1 ? { value: inputs[0].value } : null;
        `);
      }
      if (dialog?.value !== amount) throw new EgoRecruitmentError("BUDGET_ERROR_UNRECOGNIZED");
      const outcome = await dispatchVisibleButton(ego, uiContract.actions.topUpRecruitmentBudget.confirmLabel, controls, async () => dom(ego, String.raw`
        const visible = el => !!(el && el.getClientRects().length);
        return ![...document.querySelectorAll('[role=dialog],.el-dialog')]
          .some(el => visible(el) && (el.innerText || '').includes('追加预算'));
      `));
      await ego.wait(0.8);
      return outcome;
    }
    case "PREPARE_INTERNAL_WRITEBACK":
      return openInternalConfirmation(ego, origins, input, rules);
    case "REREAD_INTERNAL_WRITEBACK":
      return rereadInternalWriteback(ego, origins, input, rules);
    case "CONFIRM_INTERNAL_ORDER":
      await navigate(ego, origins.placement, "/orders");
      return dispatchVisibleButton(ego, "确认下单", controls, async () => dom(ego, String.raw`
        const visible = el => !!(el && el.getClientRects().length);
        return ![...document.querySelectorAll('[role=dialog],.ant-modal-content')].some(el => visible(el) && (el.innerText || '').includes('确认下单'));
      `));
    case "REREAD_INTERNAL_FINAL_STATE": {
      const record = await searchInternalOrder(ego, origins, input.orderId);
      return { orderId: input.orderId, activityId: input.activityId, creatorId: input.creatorId, status: record.orderStatus };
    }
    default:
      throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", `unsupported Ego recruitment operation ${operation}`);
  }
}

export async function executeEgoRecruitmentOperation({
  ego: rawEgo,
  command,
  rules,
  uiContract,
  origins: rawOrigins,
  controls = {},
}) {
  const ego = requireFacade(rawEgo);
  const origins = requireOrigins(rawOrigins);
  if (!command || typeof command.operation !== "string" || command.input === null || typeof command.input !== "object") {
    throw new Error("Ego recruitment command is invalid");
  }
  const required = operationRequiredFields[command.operation];
  if (required && required.some((field) => !Object.hasOwn(command.input, field) || command.input[field] === null || command.input[field] === "")) {
    throw new EgoRecruitmentError("INPUT_CONTRACT_INVALID", `missing input for ${command.operation}`);
  }
  try {
    const evidence = await executeSemantic({
      ego, operation: command.operation, input: command.input, rules, uiContract, origins, controls,
    });
    const tier = evidence?.__tier ?? (statefulOperations.has(command.operation) ? "EGO_VISUAL" : "EGO_SEMANTIC");
    if (evidence && Object.hasOwn(evidence, "__tier")) delete evidence.__tier;
    return Object.freeze({ evidence: structuredClone(evidence), tier });
  } catch (error) {
    if (error instanceof EgoRecruitmentError) throw error;
    const message = String(error?.message ?? error);
    if (/user is controlling|inactive|not assigned/iu.test(message)) {
      throw new EgoRecruitmentError("BROWSER_CONTROL_INTERRUPTED", message);
    }
    throw new EgoRecruitmentError("UI_STRUCTURE_DRIFT", message);
  }
}

export function shouldAttemptEgoVisual(reasonCode) {
  return visualEligibleReasons.has(reasonCode);
}
