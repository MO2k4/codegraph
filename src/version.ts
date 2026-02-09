/**
 * Version and Provenance Tracking
 *
 * Provides runtime version information for CodeGraph.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface RuntimeVersion {
  package: string;
  git: string | null;
}

let cachedVersion: RuntimeVersion | null = null;

/**
 * Get runtime version information
 *
 * Reads version from package.json and git revision.
 * Results are cached after first call.
 */
export function getRuntimeVersion(): RuntimeVersion {
  if (cachedVersion) return cachedVersion;

  // Read package version
  let packageVersion = 'unknown';
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    packageVersion = pkg.version || 'unknown';
  } catch {
    // Fall back to unknown
  }

  // Get git revision
  let gitVersion: string | null = null;
  try {
    const rev = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    gitVersion = status.length > 0 ? `${rev}-dirty` : rev;
  } catch {
    // Not a git repo or git not available
  }

  cachedVersion = { package: packageVersion, git: gitVersion };
  return cachedVersion;
}

/**
 * Clear cached version (useful for testing)
 */
export function clearVersionCache(): void {
  cachedVersion = null;
}
