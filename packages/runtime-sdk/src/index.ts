export { withGuard, type GuardOptions } from './guard/middleware.ts';
export { normalizePathname } from './guard/normalize.ts';
export { buildRouteEvent, type RequestSnapshot, type RouteEvent } from './guard/observe.ts';
export { hasSessionCookie, DEFAULT_SESSION_COOKIE_PATTERNS, type SessionDetectionOptions } from './guard/session.ts';
export { createRuntime, type RuntimeClient, type RuntimeConfig, type AiCallEvent, type RuntimeEvent } from './runtime.ts';

export { wrapOpenAI, type OpenAIClientLike, type AiGuardOptions } from './ai/wrap-openai.ts';
export { wrapAnthropic, type AnthropicClientLike, type AnthropicGuardOptions } from './ai/wrap-anthropic.ts';
export {
  SpendFirewall,
  SpendCeilingError,
  MemorySpendStore,
  createUpstashStore,
  hourKey,
  type SpendStore,
  type SpendFirewallOptions,
} from './ai/spend-firewall.ts';
export {
  estimateCostMicroUsd,
  findPricing,
  MODEL_PRICING,
  FALLBACK_PRICING,
  type ModelPricing,
} from './ai/pricing.ts';
export { estimateTokens, estimatePromptTokens, estimateProjectedCost } from './ai/estimate.ts';
export { hashUserId } from './ai/hash.ts';