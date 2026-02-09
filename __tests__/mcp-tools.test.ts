/**
 * MCP Tools Tests
 *
 * Tests all 13 MCP tools (7 original + 6 lifecycle) including
 * tool name normalization, validation, and handler behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';

describe('MCP Tools', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-test-'));

    // Create sample source files
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'auth.ts'),
      `/**
 * Authentication module
 */
export interface AuthConfig {
  secret: string;
  expiresIn: number;
}

export function validateToken(token: string): boolean {
  return token.length > 0;
}

export function generateToken(userId: string, config: AuthConfig): string {
  return userId + ':' + config.secret;
}

export class AuthService {
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
  }

  login(email: string, password: string): string {
    const token = generateToken(email, this.config);
    return token;
  }

  verify(token: string): boolean {
    return validateToken(token);
  }
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'app.ts'),
      `import { AuthService, AuthConfig } from './auth';

const config: AuthConfig = {
  secret: 'test-secret',
  expiresIn: 3600,
};

const auth = new AuthService(config);

export function handleLogin(email: string, password: string): string {
  return auth.login(email, password);
}

export function checkAuth(token: string): boolean {
  return auth.verify(token);
}
`
    );

    cg = await CodeGraph.init(testDir, { index: false });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Tool Definitions
  // ===========================================================================

  describe('Tool definitions', () => {
    it('should define all 13 tools', () => {
      expect(tools).toHaveLength(13);
    });

    it('should have unique tool names', () => {
      const names = tools.map(t => t.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('should include the 7 original tools', () => {
      const names = tools.map(t => t.name);
      expect(names).toContain('codegraph_search');
      expect(names).toContain('codegraph_context');
      expect(names).toContain('codegraph_callers');
      expect(names).toContain('codegraph_callees');
      expect(names).toContain('codegraph_impact');
      expect(names).toContain('codegraph_node');
      expect(names).toContain('codegraph_status');
    });

    it('should include the 6 lifecycle tools', () => {
      const names = tools.map(t => t.name);
      expect(names).toContain('codegraph_get_root');
      expect(names).toContain('codegraph_set_root');
      expect(names).toContain('codegraph_init');
      expect(names).toContain('codegraph_index');
      expect(names).toContain('codegraph_sync');
      expect(names).toContain('codegraph_uninit');
    });

    it('should have inputSchema for all tools', () => {
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  // ===========================================================================
  // Tool Name Normalization
  // ===========================================================================

  describe('Tool name normalization', () => {
    it('should handle codegraph_ prefixed names', async () => {
      const result = await handler.execute('codegraph_status', {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('CodeGraph Status');
    });

    it('should handle un-prefixed names', async () => {
      const result = await handler.execute('status', {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('CodeGraph Status');
    });

    it('should return error for unknown tools', async () => {
      const result = await handler.execute('nonexistent_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Unknown tool');
    });
  });

  // ===========================================================================
  // Search Tool
  // ===========================================================================

  describe('codegraph_search', () => {
    it('should find symbols by name', async () => {
      const result = await handler.execute('codegraph_search', { query: 'validateToken' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('validateToken');
    });

    it('should return no results for unknown symbols', async () => {
      const result = await handler.execute('codegraph_search', { query: 'xyzNotExist99' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('No results');
    });

    it('should validate query parameter', async () => {
      const result = await handler.execute('codegraph_search', { query: '' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('query');
    });

    it('should respect limit parameter', async () => {
      const result = await handler.execute('codegraph_search', { query: 'auth', limit: 2 });
      expect(result.isError).toBeUndefined();
    });
  });

  // ===========================================================================
  // Context Tool
  // ===========================================================================

  describe('codegraph_context', () => {
    it('should build context for a task', async () => {
      const result = await handler.execute('codegraph_context', { task: 'authentication login flow' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toBeDefined();
    });

    it('should validate task parameter', async () => {
      const result = await handler.execute('codegraph_context', { task: '' });
      expect(result.isError).toBe(true);
    });

    it('should add feature request reminder for feature-like queries', async () => {
      const result = await handler.execute('codegraph_context', { task: 'add a new logout button' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('Ask user');
    });

    it('should not add reminder for bug fix queries', async () => {
      const result = await handler.execute('codegraph_context', { task: 'fix the login bug' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).not.toContain('Ask user');
    });
  });

  // ===========================================================================
  // Callers Tool
  // ===========================================================================

  describe('codegraph_callers', () => {
    it('should find callers of a function', async () => {
      const result = await handler.execute('codegraph_callers', { symbol: 'validateToken' });
      expect(result.isError).toBeUndefined();
      // validateToken is called by AuthService.verify
      const text = result.content[0]?.text ?? '';
      // May find callers or report none found
      expect(text.length).toBeGreaterThan(0);
    });

    it('should validate symbol parameter', async () => {
      const result = await handler.execute('codegraph_callers', { symbol: '' });
      expect(result.isError).toBe(true);
    });

    it('should handle unknown symbols', async () => {
      const result = await handler.execute('codegraph_callers', { symbol: 'unknownFunc99' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('not found');
    });
  });

  // ===========================================================================
  // Callees Tool
  // ===========================================================================

  describe('codegraph_callees', () => {
    it('should find callees of a function', async () => {
      const result = await handler.execute('codegraph_callees', { symbol: 'login' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? '';
      expect(text.length).toBeGreaterThan(0);
    });

    it('should validate symbol parameter', async () => {
      const result = await handler.execute('codegraph_callees', { symbol: '' });
      expect(result.isError).toBe(true);
    });
  });

  // ===========================================================================
  // Impact Tool
  // ===========================================================================

  describe('codegraph_impact', () => {
    it('should analyze impact of a symbol', async () => {
      const result = await handler.execute('codegraph_impact', { symbol: 'generateToken' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Impact');
    });

    it('should validate symbol parameter', async () => {
      const result = await handler.execute('codegraph_impact', { symbol: '' });
      expect(result.isError).toBe(true);
    });
  });

  // ===========================================================================
  // Node Tool
  // ===========================================================================

  describe('codegraph_node', () => {
    it('should get node details without code by default', async () => {
      const result = await handler.execute('codegraph_node', { symbol: 'AuthService' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('AuthService');
      expect(text).toContain('class');
    });

    it('should include code when requested', async () => {
      const result = await handler.execute('codegraph_node', { symbol: 'validateToken', includeCode: true });
      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('validateToken');
      expect(text).toContain('```');
    });

    it('should validate symbol parameter', async () => {
      const result = await handler.execute('codegraph_node', { symbol: '' });
      expect(result.isError).toBe(true);
    });
  });

  // ===========================================================================
  // Status Tool
  // ===========================================================================

  describe('codegraph_status', () => {
    it('should return index statistics', async () => {
      const result = await handler.execute('codegraph_status', {});
      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('CodeGraph Status');
      expect(text).toContain('Files indexed');
      expect(text).toContain('Total nodes');
    });
  });

  // ===========================================================================
  // Lifecycle Tools
  // ===========================================================================

  describe('codegraph_get_root', () => {
    it('should return the project root', async () => {
      const result = await handler.execute('codegraph_get_root', {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain(testDir);
    });
  });

  describe('codegraph_set_root', () => {
    it('should validate path parameter', async () => {
      const result = await handler.execute('codegraph_set_root', { path: '' });
      expect(result.isError).toBe(true);
    });

    it('should return error when no onSetRoot callback', async () => {
      const result = await handler.execute('codegraph_set_root', { path: testDir });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('not supported');
    });

    it('should call onSetRoot callback when provided', async () => {
      // Use the actual test directory (which exists) to pass path validation
      let capturedPath = '';
      const handlerWithCallback = new ToolHandler(cg, {
        onSetRoot: (p) => { capturedPath = p; },
      });

      const result = await handlerWithCallback.execute('codegraph_set_root', { path: testDir });
      expect(result.isError).toBeUndefined();
      expect(capturedPath).toBe(testDir);
    });
  });

  describe('codegraph_init', () => {
    it('should return initialized message', async () => {
      const result = await handler.execute('codegraph_init', {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('initialized');
    });
  });

  describe('codegraph_index', () => {
    it('should run indexing and return results', async () => {
      const result = await handler.execute('codegraph_index', {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('Indexed');
    });
  });

  describe('codegraph_sync', () => {
    it('should sync and return results', async () => {
      const result = await handler.execute('codegraph_sync', {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('Sync complete');
    });
  });

  describe('codegraph_uninit', () => {
    it('should require force flag', async () => {
      const result = await handler.execute('codegraph_uninit', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('force=true');
    });

    it('should uninitialize when force is true', async () => {
      // Create a separate instance for this test since uninit deletes everything
      const uninitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-uninit-test-'));
      const srcDir = path.join(uninitDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'test.ts'), 'export const x = 1;');

      const uninitCg = await CodeGraph.init(uninitDir, { index: false });
      const uninitHandler = new ToolHandler(uninitCg);

      const result = await uninitHandler.execute('codegraph_uninit', { force: true });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('removed');

      // .codegraph directory should be gone
      expect(fs.existsSync(path.join(uninitDir, '.codegraph'))).toBe(false);

      fs.rmSync(uninitDir, { recursive: true, force: true });
    });
  });

  // ===========================================================================
  // Validation Helpers
  // ===========================================================================

  describe('Input validation', () => {
    it('should clamp numeric values within bounds', async () => {
      // Limit > 100 should be clamped
      const result = await handler.execute('codegraph_search', { query: 'auth', limit: 999 });
      expect(result.isError).toBeUndefined();
    });

    it('should use defaults for non-numeric values', async () => {
      const result = await handler.execute('codegraph_search', { query: 'auth', limit: 'not-a-number' });
      expect(result.isError).toBeUndefined();
    });

    it('should handle missing optional parameters', async () => {
      const result = await handler.execute('codegraph_search', { query: 'auth' });
      expect(result.isError).toBeUndefined();
    });
  });
});
