import { config as loadEnvFile } from 'dotenv';

/**
 * Environment bootstrap for standalone Node processes.
 *
 * Next.js loads .env.local automatically; a worker started with tsx does
 * not. This lives in its own module because imports are evaluated before
 * the importing module's body runs — so importing this first guarantees the
 * files are loaded before anything reads process.env.
 *
 * dotenv never overwrites a variable that is already set, so the more
 * specific file is loaded first, matching Next.js resolution order.
 */
loadEnvFile({ path: '.env.local', quiet: true });
loadEnvFile({ path: '.env', quiet: true });
