import { IDatabaseRepository } from './types.js';
import { SupabaseRepository } from './supabase-repository.js';
import { InMemoryRepository } from './in-memory-repository.js';

export function createDatabaseRepository(options: {
  supabaseUrl?: string;
  supabaseKey?: string;
}): IDatabaseRepository {
  if (options.supabaseUrl && options.supabaseKey) {
    return new SupabaseRepository(options.supabaseUrl, options.supabaseKey);
  }

  console.warn(
    '[NEXA DATABASE] No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY provided. Using InMemoryRepository. Data will persist in-memory only.'
  );
  return new InMemoryRepository();
}
