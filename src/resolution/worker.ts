/**
 * Resolution Worker Thread
 *
 * Runs reference resolution in a worker thread for parallel processing.
 */

import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import { QueryBuilder } from '../db/queries';
import { ReferenceResolver } from './index';
import { UnresolvedReference } from '../types';

interface WorkerInput {
  dbPath: string;
  projectRoot: string;
  refs: UnresolvedReference[];
}

async function run() {
  const { dbPath, projectRoot, refs } = workerData as WorkerInput;
  let db: Database.Database | null = null;

  try {
    // Open read-only database connection
    db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    db.pragma('cache_size = -32000');
    db.pragma('mmap_size = 268435456');

    const queries = new QueryBuilder(db);
    const resolver = new ReferenceResolver(projectRoot, queries);
    resolver.initialize();

    // Report progress
    parentPort?.postMessage({ type: 'progress', processed: 0, total: refs.length });

    // Resolve all references
    const result = resolver.resolveAll(refs);

    // Report result
    parentPort?.postMessage({
      type: 'result',
      resolved: result.resolved,
      stats: result.stats,
    });
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

run();
