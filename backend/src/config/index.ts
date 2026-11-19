import { z } from 'zod';

const secret = z.string().min(32).max(256);
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().refine((s) => /^postgres(ql)?:\/\//.test(s)),
  ADMIN_SECRET: secret,
  TOOL_SECRET: secret,
  WEBHOOK_SECRET: secret,
  SLOT_SECRET: secret,
  IDEMPOTENCY_SECRET: secret,
  AUDIT_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  CALENDAR_ADAPTER: z.literal('mock').default('mock'),
  SMS_ADAPTER: z.literal('mock').default('mock'),
  TEST_RESERVE_MINUTES: z.coerce.number().int().min(1).max(40).default(1),
  TEST_CALL_RESERVATION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(50).max(30000).default(5000),
  BOOKING_LEASE_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  // Never include received values (especially credentials) in configuration errors.
  if (!result.success) throw new Error(`Invalid configuration: ${[...new Set(result.error.issues.map((i) => i.path[0]))].join(', ')}`);
  const config = result.data;
  const secrets = [config.ADMIN_SECRET, config.TOOL_SECRET, config.WEBHOOK_SECRET, config.SLOT_SECRET, config.IDEMPOTENCY_SECRET, config.AUDIT_KEY];
  if (new Set(secrets).size !== secrets.length) throw new Error('Secrets must be independent');
  if (config.NODE_ENV === 'production') throw new Error('Production is disabled until provider authentication and session binding are verified');
  if (config.BOOKING_LEASE_SECONDS * 1000 <= config.PROVIDER_TIMEOUT_MS) throw new Error('Booking lease must exceed provider timeout');
  return config;
}
