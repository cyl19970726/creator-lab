import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  atomicJSON,
  acquireLock,
  assertCanPrepare,
  assertCanSubmit,
  digest,
  isSubmissionState,
  platforms,
} from "./core.mjs";

export const DEFAULT_LEDGER_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".publish",
  "ledger.json",
);
function identity(job, platform) {
  if (!platforms.includes(platform)) throw Error("未知发布平台");
  const accountId = String(job.platforms?.[platform]?.account?.id || "");
  if (
    typeof job.deliveryId !== "string" ||
    !job.deliveryId.trim() ||
    !accountId ||
    !/^[a-f0-9]{64}$/i.test(job.videoHash || "")
  )
    throw Error("发布账本需要 deliveryId、真实账号与 videoHash");
  return {
    deliveryId: job.deliveryId,
    platform,
    accountId,
    key: digest(JSON.stringify([job.deliveryId, platform, accountId])),
  };
}
function load(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, records: {} };
  const data = JSON.parse(fs.readFileSync(file));
  if (data.schemaVersion !== 1 || !data.records || Array.isArray(data.records))
    throw Error("发布账本格式不正确；禁止用空状态覆盖");
  return data;
}
function transaction(file) {
  const data = load(file);
  const persist = () => atomicJSON(file, data);
  const now = () => new Date().toISOString();
  function current(job, platform) {
    return data.records[identity(job, platform).key] || null;
  }
  function conflict(job, platform) {
    const id = identity(job, platform);
    return (
      Object.values(data.records).find(
        (r) =>
          r.platform === platform &&
          r.accountId === id.accountId &&
          isSubmissionState(r) &&
          (r.deliveryId === id.deliveryId ||
            (r.videoHashes || [r.videoHash]).some(
              (hash) => hash.toLowerCase() === job.videoHash.toLowerCase(),
            )),
      ) || null
    );
  }
  function base(job, platform, details = {}) {
    const id = identity(job, platform),
      old = current(job, platform);
    return {
      ...old,
      ...details,
      ...id,
      jobId: job.id,
      fingerprint: job.fingerprint,
      videoHash: job.videoHash,
      videoHashes: [...new Set([...(old?.videoHashes || []), job.videoHash])],
      accountName: job.platforms[platform].account.name,
      updatedAt: now(),
    };
  }
  const api = {
    syncJob(job) {
      const pending = [];
      for (const [platform, receipt] of Object.entries(
        job.alreadyPublished || {},
      )) {
        if (!isSubmissionState(receipt)) continue;
        const id = identity(job, platform);
        const receiptAccount = receipt.accountId ?? receipt.account_id;
        if (receiptAccount != null && String(receiptAccount) !== id.accountId)
          throw Error(`${platform} 历史回执账号与当前账号不一致`);
        const previous = current(job, platform),
          record = base(job, platform);
        const videoHash =
          receipt.videoHash ||
          receipt.videoSha256 ||
          receipt.publishAttempt?.videoSha256 ||
          job.videoHash;
        if (!/^[a-f0-9]{64}$/i.test(videoHash))
          throw Error("历史回执缺少合法素材指纹");
        record.videoHashes = [...new Set([...record.videoHashes, videoHash])];
        record.importedReceipts = [...(previous?.importedReceipts || [])];
        const receiptHash = digest(JSON.stringify(receipt));
        if (!record.importedReceipts.some((r) => r.sha256 === receiptHash))
          record.importedReceipts.push({
            sha256: receiptHash,
            record: receipt,
            importedAt: now(),
          });
        // A newly imported old receipt may add evidence but never reopen or downgrade an attempt.
        if (!previous || !isSubmissionState(previous)) {
          record.status = isSubmissionState({ status: receipt.status })
            ? receipt.status
            : "submission-unconfirmed";
          record.receipt = receipt.receipt ?? receipt;
          if (receipt.publishAttempt)
            record.attempt = {
              ...receipt.publishAttempt,
              id: receipt.publishAttempt.id || `import:${receiptHash}`,
            };
        }
        pending.push([id.key, record]);
      }
      for (const [key, record] of pending) data.records[key] = record;
      if (pending.length) persist();
      return pending.map(([, record]) => structuredClone(record));
    },
    get(job, platform) {
      return structuredClone(current(job, platform) || conflict(job, platform));
    },
    assertCanPrepare(job, platform) {
      assertCanPrepare(job.alreadyPublished?.[platform]);
      assertCanPrepare(conflict(job, platform));
      return structuredClone(current(job, platform));
    },
    assertCanSubmit(job, platform) {
      api.assertCanPrepare(job, platform);
      if (!job.fingerprint) throw Error("准备指纹缺失");
      assertCanSubmit(current(job, platform), job.fingerprint);
      return structuredClone(current(job, platform));
    },
    savePrepared(job, platform, details = {}) {
      api.assertCanPrepare(job, platform);
      if (!job.fingerprint) throw Error("准备指纹缺失");
      const record = {
        ...base(job, platform, details),
        status: "ready",
        preparedAt: now(),
      };
      data.records[record.key] = record;
      persist();
      return structuredClone(record);
    },
    beginSubmit(job, platform, details = {}) {
      api.assertCanSubmit(job, platform);
      const record = {
        ...base(job, platform),
        status: "submitting",
        attempt: {
          ...details,
          id: crypto.randomUUID(),
          startedAt: now(),
          fingerprint: job.fingerprint,
          videoHash: job.videoHash,
        },
      };
      data.records[record.key] = record;
      persist();
      return structuredClone(record);
    },
    recordResult(job, platform, status, details = {}) {
      if (status === "failed") status = "submission-unconfirmed";
      if (!isSubmissionState({ status }))
        throw Error("回执状态不能撤销提交尝试或退回准备状态");
      const previous = current(job, platform);
      const record = {
        ...base(job, platform, details),
        status,
        attempt: previous?.attempt,
        observedAt: now(),
      };
      // Receiving an error after an already verified submission must not erase its stronger evidence.
      if (
        previous &&
        /^(published|reviewing|submitted|scheduled)/u.test(previous.status) &&
        status === "submission-unconfirmed"
      )
        record.status = previous.status;
      data.records[record.key] = record;
      persist();
      return structuredClone(record);
    },
  };
  return api;
}
export function createLedger(file = DEFAULT_LEDGER_FILE) {
  const absolute = path.resolve(file);
  const api = { file: absolute };
  for (const name of [
    "syncJob",
    "get",
    "assertCanPrepare",
    "assertCanSubmit",
    "savePrepared",
    "beginSubmit",
    "recordResult",
  ]) {
    api[name] = (...args) => {
      const release = acquireLock(absolute + ".lock");
      try {
        return transaction(absolute)[name](...args);
      } finally {
        release();
      }
    };
  }
  api.withLock = async (fn) => {
    const release = acquireLock(absolute + ".lock");
    try {
      return await fn(transaction(absolute));
    } finally {
      release();
    }
  };
  return api;
}
export async function withLedger(
  job,
  platform,
  operation,
  fn,
  { file = DEFAULT_LEDGER_FILE } = {},
) {
  if (
    !["prepare", "submit", "inspect", "verify", "probe", "resume"].includes(
      operation,
    )
  )
    throw Error("未知账本操作");
  return createLedger(file).withLock(async (ledger) => {
    ledger.syncJob(job);
    if (operation === "prepare") ledger.assertCanPrepare(job, platform);
    if (operation === "submit") ledger.assertCanSubmit(job, platform);
    return fn({ ledger, record: platform ? ledger.get(job, platform) : null });
  });
}
