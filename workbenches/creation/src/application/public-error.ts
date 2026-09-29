const messages = {
  model: '所选模型当前不可用，请选择可用模型重新开始。',
  authentication: '模型服务登录或认证失败，请检查登录状态后重试。',
  timeout: '模型调用超时，请稍后重试。',
  other: '执行失败，请查看私有运行记录。',
} as const;

export type PublicExecutionError = typeof messages[keyof typeof messages];

/** Only fixed messages leave the private worker ledger. */
export function publicExecutionError(error: unknown): PublicExecutionError {
  if (Object.values(messages).includes(error as PublicExecutionError)) return error as PublicExecutionError;
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/\b(?:unsupported[ _-]?model|model[ _-]?not[ _-]?found|unknown[ _-]?model|invalid[ _-]?model)\b|model.{0,100}(?:not supported|does not exist|unavailable|is unsupported)/i.test(text)) return messages.model;
  if (/\b(?:unauthorized|unauthenticated|authentication|invalid_api_key|login required|not logged in|sign in required|credential.{0,30}(?:invalid|expired)|token.{0,30}expired)\b|["']?status["']?\s*:\s*(?:401|403)\b/i.test(text)) return messages.authentication;
  if (/\b(?:CODEX_SDK_TIMEOUT|ETIMEDOUT|timed? out|timeout|deadline exceeded)\b/i.test(text)) return messages.timeout;
  return messages.other;
}
