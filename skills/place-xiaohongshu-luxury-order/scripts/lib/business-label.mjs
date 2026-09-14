export function normalizeBusinessLabel(value){return typeof value==='string'?value.normalize('NFKC').trim():'';}
export function matchesBusinessLabelRule(value,scope=['奢侈品','奢品']){
  const keywords=Array.isArray(scope)?scope:scope.requiredInternalBusinessLabelKeywordsAny??['奢侈品','奢品'];
  const label=normalizeBusinessLabel(value);return Boolean(label)&&keywords.some(keyword=>label.includes(normalizeBusinessLabel(keyword)));
}
