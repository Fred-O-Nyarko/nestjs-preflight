import { z } from 'zod';
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().default(3000),
});
