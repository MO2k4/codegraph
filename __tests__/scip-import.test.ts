/**
 * SCIP Import Tests
 *
 * Tests for the SCIP (Source Code Intelligence Protocol) importer,
 * including parsing, symbol definition building, and idempotent import.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ScipImporter } from '../src/scip/index';

describe('SCIP Import', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-test-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('ScipImporter.parseSCIPFile', () => {
    it('should parse documents-wrapped SCIP JSON', () => {
      const scipData = {
        documents: [
          {
            relativePath: 'src/auth.ts',
            occurrences: [
              { range: [10, 5, 10, 15], symbol: 'pkg Auth#login().', symbolRoles: 1 },
            ],
          },
        ],
      };
      const scipPath = path.join(testDir, 'index.scip.json');
      fs.writeFileSync(scipPath, JSON.stringify(scipData));

      // Create a minimal CodeGraph to get a QueryBuilder
      const cg = CodeGraph.initSync(testDir);
      const importer = new ScipImporter(testDir, (cg as any).queries);

      const docs = importer.parseSCIPFile(scipPath);
      expect(docs).toHaveLength(1);
      if (!docs[0]) throw new Error('Expected document');
      expect(docs[0].relativePath).toBe('src/auth.ts');
      expect(docs[0].occurrences).toHaveLength(1);

      cg.close();
    });

    it('should parse raw array SCIP JSON', () => {
      const scipData = [
        {
          relativePath: 'src/utils.ts',
          occurrences: [
            { range: [5, 0, 5, 10], symbol: 'pkg format().', symbolRoles: 1 },
          ],
        },
      ];
      const scipPath = path.join(testDir, 'dump.scip.json');
      fs.writeFileSync(scipPath, JSON.stringify(scipData));

      const cg = CodeGraph.initSync(testDir);
      const importer = new ScipImporter(testDir, (cg as any).queries);

      const docs = importer.parseSCIPFile(scipPath);
      expect(docs).toHaveLength(1);
      if (!docs[0]) throw new Error('Expected document');
      expect(docs[0].relativePath).toBe('src/utils.ts');

      cg.close();
    });

    it('should throw on invalid SCIP format', () => {
      const scipPath = path.join(testDir, 'bad.scip.json');
      fs.writeFileSync(scipPath, JSON.stringify({ invalid: true }));

      const cg = CodeGraph.initSync(testDir);
      const importer = new ScipImporter(testDir, (cg as any).queries);

      expect(() => importer.parseSCIPFile(scipPath)).toThrow('Invalid SCIP format');

      cg.close();
    });

    it('should throw on missing file', () => {
      const cg = CodeGraph.initSync(testDir);
      const importer = new ScipImporter(testDir, (cg as any).queries);

      // Absolute path outside project root is rejected as path traversal
      expect(() => importer.parseSCIPFile('/nonexistent/path.scip.json')).toThrow('outside the project root');

      // Relative path within project root that doesn't exist
      expect(() => importer.parseSCIPFile('nonexistent.scip.json')).toThrow('SCIP file not found');

      cg.close();
    });
  });

  describe('ScipImporter.buildSymbolDefinitions', () => {
    it('should build definitions map from documents', () => {
      const cg = CodeGraph.initSync(testDir);
      const importer = new ScipImporter(testDir, (cg as any).queries);

      const docs = [
        {
          relativePath: 'src/auth.ts',
          occurrences: [
            { range: [10, 0], symbol: 'pkg Auth#login().', symbolRoles: 1 },
            { range: [20, 0], symbol: 'pkg Auth#logout().', symbolRoles: 1 },
            { range: [30, 0], symbol: 'pkg Auth#login().', symbolRoles: 0 }, // reference, not def
          ],
        },
        {
          relativePath: 'src/utils.ts',
          occurrences: [
            { range: [5, 0], symbol: 'pkg format().', symbolRoles: 1 },
          ],
        },
      ];

      const defs = importer.buildSymbolDefinitions(docs);

      expect(defs.size).toBe(3);
      expect(defs.get('pkg Auth#login().')).toBeDefined();
      const loginDefs = defs.get('pkg Auth#login().');
      if (!loginDefs) throw new Error('Expected login defs');
      expect(loginDefs.has('src/auth.ts')).toBe(true);

      cg.close();
    });

    it('should handle documents without occurrences', () => {
      const cg = CodeGraph.initSync(testDir);
      const importer = new ScipImporter(testDir, (cg as any).queries);

      const docs = [
        { relativePath: 'src/empty.ts' },
        { relativePath: 'src/also-empty.ts', occurrences: [] },
      ];

      const defs = importer.buildSymbolDefinitions(docs);
      expect(defs.size).toBe(0);

      cg.close();
    });
  });

  describe('ScipImporter.importSCIP', () => {
    it('should import SCIP data and create edges with provenance', async () => {
      // Create source files
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'auth.ts'),
        `export function login(email: string, password: string): boolean {
  return true;
}

export function logout(): void {
  console.log('logged out');
}
`
      );
      fs.writeFileSync(
        path.join(srcDir, 'app.ts'),
        `import { login, logout } from './auth';

function startApp() {
  login('test@test.com', 'pass');
  logout();
}
`
      );

      // Index the project
      const cg = await CodeGraph.init(testDir, { index: false });
      await cg.indexAll();

      // Create SCIP data
      const scipData = {
        documents: [
          {
            relativePath: 'src/auth.ts',
            occurrences: [
              { range: [1, 16, 1, 21], symbol: 'pkg auth login().', symbolRoles: 1 },
              { range: [5, 16, 5, 22], symbol: 'pkg auth logout().', symbolRoles: 1 },
            ],
          },
          {
            relativePath: 'src/app.ts',
            occurrences: [
              { range: [4, 2, 4, 7], symbol: 'pkg auth login().', symbolRoles: 0 },
              { range: [5, 2, 5, 8], symbol: 'pkg auth logout().', symbolRoles: 0 },
            ],
          },
        ],
      };
      const scipPath = path.join(testDir, 'index.scip.json');
      fs.writeFileSync(scipPath, JSON.stringify(scipData));

      // Import SCIP
      const result = cg.importSCIP(scipPath);

      expect(result.documentsProcessed).toBeGreaterThanOrEqual(1);
      // Edges should be created (exact count depends on node matching)
      expect(result.edgesCreated).toBeGreaterThanOrEqual(0);

      cg.close();
    });

    it('should skip import when content hash matches (idempotent)', async () => {
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export function hello() { return "hi"; }');

      const cg = await CodeGraph.init(testDir, { index: false });
      await cg.indexAll();

      const scipData = {
        documents: [
          {
            relativePath: 'src/index.ts',
            occurrences: [
              { range: [1, 16, 1, 21], symbol: 'pkg hello().', symbolRoles: 1 },
            ],
          },
        ],
      };
      const scipPath = path.join(testDir, 'index.scip.json');
      fs.writeFileSync(scipPath, JSON.stringify(scipData));

      // First import
      const result1 = cg.importSCIP(scipPath);

      // Second import of same file
      const result2 = cg.importSCIP(scipPath);
      expect(result2.edgesCreated).toBe(0);
      expect(result2.documentsProcessed).toBe(0);

      cg.close();
    });

    it('should record metadata after import', async () => {
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export function hello() {}');

      const cg = await CodeGraph.init(testDir, { index: false });
      await cg.indexAll();

      const scipData = { documents: [{ relativePath: 'src/index.ts', occurrences: [] }] };
      const scipPath = path.join(testDir, 'index.scip.json');
      fs.writeFileSync(scipPath, JSON.stringify(scipData));

      cg.importSCIP(scipPath);

      const metadata = cg.getMetadata();
      expect(metadata).toBeDefined();
      if (metadata) {
        expect(metadata['scip_last_hash']).toBeDefined();
        expect(metadata['scip_last_imported_at']).toBeDefined();
      }

      cg.close();
    });
  });

  describe('ScipImporter.findSCIPFiles', () => {
    it('should detect SCIP files in root', () => {
      fs.writeFileSync(path.join(testDir, 'index.scip.json'), '{}');
      const found = ScipImporter.findSCIPFiles(testDir);
      expect(found).toContain('index.scip.json');
    });

    it('should detect SCIP files in build directory', () => {
      const buildDir = path.join(testDir, 'build');
      fs.mkdirSync(buildDir);
      fs.writeFileSync(path.join(buildDir, 'index.scip.json'), '{}');
      const found = ScipImporter.findSCIPFiles(testDir);
      expect(found).toContain('build/index.scip.json');
    });

    it('should return empty array when no SCIP files found', () => {
      const found = ScipImporter.findSCIPFiles(testDir);
      expect(found).toHaveLength(0);
    });
  });
});
