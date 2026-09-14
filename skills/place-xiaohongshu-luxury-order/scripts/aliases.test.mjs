import assert from "node:assert/strict";
import test from "node:test";
import { matchesBusinessLabelRule, normalizeBusinessLabel } from "./lib/business-label.mjs";
import {
  brandsEquivalent, canonicalizeCandidateStatus, canonicalizeExternalStatus,
  canonicalizeInternalStatus, isNegotiatedPricePending, normalizeBrandLabel, spuSetEqualsRequired,
} from "./lib/aliases.mjs";

test("luxury and luxury-short labels both match the any-keyword rule", () => {
  const scope = { requiredInternalBusinessLabelKeywordsAny: ["奢侈品", "奢品"] };
  for (const label of ["奢侈品回收-门店-包包", "奢品合作", "门店-奢品-回收", "  奢侈品  "]) {
    assert.equal(matchesBusinessLabelRule(label, scope), true, label);
  }
  assert.equal(matchesBusinessLabelRule("普通合作", scope), false);
  assert.equal(matchesBusinessLabelRule("奢 侈 品", scope), false);
  assert.equal(normalizeBusinessLabel("  Ａ奢品  "), "A奢品");
});

test("brand aliases normalize to the canonical reporting brand", () => {
  assert.equal(normalizeBrandLabel("爱回收奢侈品回收"), "爱回收奢品回收");
  assert.equal(normalizeBrandLabel("爱回收奢品回收"), "爱回收奢品回收");
  assert.equal(brandsEquivalent("爱回收奢侈品回收", "爱回收奢品回收"), true);
  assert.equal(normalizeBrandLabel("其它品牌"), "其它品牌");
});

test("page status text maps to canonical codes and negotiated price is not an amount", () => {
  assert.equal(canonicalizeInternalStatus("待商务下单"), "WAITING_EXTERNAL_TASK_ID");
  assert.equal(canonicalizeInternalStatus("商务已下单"), "WRITEBACK_DONE");
  assert.equal(canonicalizeInternalStatus("待支付订单"), null);
  assert.equal(canonicalizeInternalStatus("WAITING_PAYMENT"), null);
  assert.equal(canonicalizeExternalStatus("待支付订单"), "WAITING_PAYMENT");
  assert.equal(canonicalizeExternalStatus("待合作人提交笔记"), "PAID_WAITING_NOTE");
  assert.equal(isNegotiatedPricePending("价格待协商"), true);
  assert.equal(isNegotiatedPricePending("200000"), false);
});

test("required SPU set is exact and rejects lookalikes", () => {
  assert.equal(spuSetEqualsRequired(["爱回收奢品回收", "爱回收app"]), true);
  assert.equal(spuSetEqualsRequired(["爱回收app"]), false);
  assert.equal(spuSetEqualsRequired(["爱回收app", "爱回收APP-二手机售卖"]), false);
});

test("candidate status is canonical", () => {
  assert.equal(canonicalizeCandidateStatus("价格待协商"), "PENDING");
  assert.equal(canonicalizeCandidateStatus("待合作人提交笔记"), "PAID_WAITING_NOTE");
});
