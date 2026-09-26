// Select observations by content, identity account, channel and video version.
// An observation never borrows a URL or acceptance from another release.
export function publicationView(catalog, topic) {
  const accounts = new Set(
    (catalog.workspace?.channels || [])
      .map((c) => c.accountId || c.account?.accountId)
      .filter(Boolean),
  );
  const current = (item) =>
    item.video_version === topic.currentVideo ||
    item.video_version?.startsWith(topic.currentVideo + "/");
  const rows = new Map();
  for (const item of catalog.publication?.items || []) {
    if ((item.topic_id || item.topicId) !== topic.id) continue;
    if (accounts.size && !accounts.has(item.account_id)) continue;
    const key = [item.platform, item.account_id, item.video_version].join(":");
    const before = rows.get(key);
    const at = (v) => Date.parse(v.observedAt || v.published_at || "") || 0;
    if (!before || at(item) >= at(before)) rows.set(key, item);
  }
  return [...rows.values()]
    .map((item) => {
      const receipt = catalog.publicationReceipts?.[item.state_path];
      const platforms = receipt?.data?.platforms;
      const record = Array.isArray(platforms)
        ? platforms.find((p) => p.id === item.platform)
        : platforms?.[item.platform];
      if (!record || (record.accountId && record.accountId !== item.account_id))
        return item;
      if (
        receipt.data.videoSha256 &&
        receipt.data.videoSha256 !== item.video_sha256
      )
        return item;
      return {
        ...item,
        ...record,
        platform: item.platform,
        receiptId: receipt.id,
        observedAt: receipt.data.updatedAt || item.observedAt,
        observationOnly: true,
        state_path: item.state_path,
      };
    })
    .sort((a, b) => Number(current(b)) - Number(current(a)));
}
