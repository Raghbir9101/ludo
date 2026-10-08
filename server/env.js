// Loads the project's .env (if present) before any other server module reads process.env.
// Variables already set in the environment win over the file.
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
