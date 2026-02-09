/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import * as os from 'os';
import { Node, UnresolvedReference, Edge } from '../types';
import { QueryBuilder } from '../db/queries';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
} from './types';
import { matchReference } from './name-matcher';
import { resolveViaImport } from './import-resolver';
import { detectFrameworks } from './frameworks';
import { logDebug, logWarn } from '../errors';
import { isPathWithinRoot } from '../utils';

// Re-export types
export * from './types';

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private projectRoot: string;
  private queries: QueryBuilder;
  private context: ResolutionContext;
  private frameworks: FrameworkResolver[] = [];
  private nodeCache: Map<string, Node[]> = new Map();
  private fileCache: Map<string, string | null> = new Map();
  private nodesByName: Map<string, Node[]> = new Map();
  private nodesByFile: Map<string, Node[]> = new Map();
  private nodesById: Map<string, Node> = new Map();
  private cacheWarmed = false;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.context = this.createContext();
  }

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    this.nodeCache.clear();
    this.fileCache.clear();
    this.nodesByName.clear();
    this.nodesByFile.clear();
    this.nodesById.clear();
    this.cacheWarmed = false;
  }

  /**
   * Warm caches by loading all nodes into memory for fast lookups
   */
  warmCaches(): void {
    if (this.cacheWarmed) return;
    const allNodes = this.queries.getAllNodes();
    this.nodesByName.clear();
    this.nodesByFile.clear();
    this.nodesById.clear();

    for (const node of allNodes) {
      // By name (lowercase)
      const key = node.name.toLowerCase();
      if (!this.nodesByName.has(key)) {
        this.nodesByName.set(key, []);
      }
      this.nodesByName.get(key)!.push(node);

      // By file
      if (!this.nodesByFile.has(node.filePath)) {
        this.nodesByFile.set(node.filePath, []);
      }
      this.nodesByFile.get(node.filePath)!.push(node);

      // By id
      this.nodesById.set(node.id, node);
    }
    this.cacheWarmed = true;
  }

  /**
   * Create the resolution context
   */
  private createContext(): ResolutionContext {
    return {
      getNodesInFile: (filePath: string) => {
        if (!this.nodeCache.has(filePath)) {
          this.nodeCache.set(filePath, this.queries.getNodesByFile(filePath));
        }
        return this.nodeCache.get(filePath)!;
      },

      getNodesByName: (name: string) => {
        if (this.cacheWarmed) {
          return this.nodesByName.get(name.toLowerCase()) || [];
        }
        return this.queries.searchNodes(name, { limit: 100 }).map((r) => r.node);
      },

      getNodesByQualifiedName: (qualifiedName: string) => {
        // Search for exact qualified name match
        return this.queries
          .searchNodes(qualifiedName, { limit: 50 })
          .filter((r) => r.node.qualifiedName === qualifiedName)
          .map((r) => r.node);
      },

      getNodesByKind: (kind: Node['kind']) => {
        return this.queries.getNodesByKind(kind);
      },

      fileExists: (filePath: string) => {
        // Prevent path traversal
        if (!isPathWithinRoot(filePath, this.projectRoot)) {
          logWarn('Path traversal blocked in fileExists', { filePath });
          return false;
        }
        const fullPath = path.join(this.projectRoot, filePath);
        try {
          return fs.existsSync(fullPath);
        } catch (error) {
          logDebug('Error checking file existence', { filePath, error: String(error) });
          return false;
        }
      },

      readFile: (filePath: string) => {
        if (this.fileCache.has(filePath)) {
          return this.fileCache.get(filePath)!;
        }

        // Prevent path traversal
        if (!isPathWithinRoot(filePath, this.projectRoot)) {
          logWarn('Path traversal blocked in readFile', { filePath });
          this.fileCache.set(filePath, null);
          return null;
        }

        const fullPath = path.join(this.projectRoot, filePath);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.fileCache.set(filePath, content);
          return content;
        } catch (error) {
          logDebug('Failed to read file for resolution', { filePath, error: String(error) });
          this.fileCache.set(filePath, null);
          return null;
        }
      },

      getProjectRoot: () => this.projectRoot,

      getAllFiles: () => {
        return this.queries.getAllFiles().map((f) => f.path);
      },
    };
  }

  /**
   * Resolve all unresolved references
   */
  resolveAll(unresolvedRefs: UnresolvedReference[]): ResolutionResult {
    this.warmCaches();
    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    // Convert to our internal format
    const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: this.getFilePathFromNodeId(ref.fromNodeId),
      language: this.getLanguageFromNodeId(ref.fromNodeId),
    }));

    for (const ref of refs) {
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Resolve a single reference
   */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // Skip built-in/external references
    if (this.isBuiltInOrExternal(ref)) {
      return null;
    }

    // Strategy 0: SCIP-based resolution (highest confidence)
    if (this.cacheWarmed && ref.filePath) {
      const scipEdges = this.queries.getOutgoingEdges(ref.fromNodeId)
        .filter(e => e.provenance === 'scip');
      const firstScipEdge = scipEdges[0];
      if (firstScipEdge) {
        const targetNode = this.nodesById.get(firstScipEdge.target);
        if (targetNode) {
          return {
            original: ref,
            targetNodeId: targetNode.id,
            confidence: 1.0,
            resolvedBy: 'scip',
          };
        }
      }
    }

    // Strategy 1: Try framework-specific resolution first
    for (const framework of this.frameworks) {
      const result = framework.resolve(ref, this.context);
      if (result) {
        return result;
      }
    }

    // Strategy 2: Try import-based resolution
    const importResult = resolveViaImport(ref, this.context);
    if (importResult) {
      return importResult;
    }

    // Strategy 3: Try name matching
    const nameResult = matchReference(ref, this.context);
    if (nameResult) {
      return nameResult;
    }

    return null;
  }

  /**
   * Create edges from resolved references
   */
  createEdges(resolved: ResolvedRef[]): Edge[] {
    return resolved.map((ref) => ({
      source: ref.original.fromNodeId,
      target: ref.targetNodeId,
      kind: ref.original.referenceKind,
      line: ref.original.line,
      column: ref.original.column,
      metadata: {
        confidence: ref.confidence,
        resolvedBy: ref.resolvedBy,
      },
    }));
  }

  /**
   * Resolve and persist edges to database
   */
  resolveAndPersist(unresolvedRefs: UnresolvedReference[]): ResolutionResult {
    const result = this.resolveAll(unresolvedRefs);

    // Create edges from resolved references
    const edges = this.createEdges(result.resolved);

    // Insert edges into database
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
    }

    return result;
  }

  /**
   * Resolve references in parallel using worker threads
   */
  async resolveAllParallel(
    unresolvedRefs: UnresolvedReference[],
    options?: { workerCount?: number; dbPath?: string }
  ): Promise<ResolutionResult> {
    const workerCount = Math.min(options?.workerCount ?? os.cpus().length, 4);
    const dbPath = options?.dbPath;

    if (!dbPath || unresolvedRefs.length < 500 || workerCount <= 1) {
      return this.resolveAll(unresolvedRefs);
    }

    // Partition refs by file for locality
    const partitions = this.partitionByFile(unresolvedRefs, workerCount);

    const workerPath = path.join(__dirname, 'worker.js');

    // Check if worker file exists (may not in dev/test)
    if (!fs.existsSync(workerPath)) {
      return this.resolveAll(unresolvedRefs);
    }

    const workerPromises = partitions.map((partition) => {
      return new Promise<{ resolved: ResolvedRef[]; stats: ResolutionResult['stats'] }>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: {
            dbPath,
            projectRoot: this.projectRoot,
            refs: partition,
          },
        });

        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('Worker timed out after 30s'));
        }, 30000);

        worker.on('message', (msg) => {
          if (msg.type === 'result') {
            clearTimeout(timeout);
            resolve({ resolved: msg.resolved, stats: msg.stats });
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(msg.error));
          }
        });

        worker.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        worker.on('exit', (code) => {
          if (code !== 0) {
            clearTimeout(timeout);
            reject(new Error(`Worker exited with code ${code}`));
          }
        });
      });
    });

    try {
      const results = await Promise.all(workerPromises);

      // Merge results
      const allResolved: ResolvedRef[] = [];
      const mergedByMethod: Record<string, number> = {};
      let totalResolved = 0;

      for (const result of results) {
        allResolved.push(...result.resolved);
        totalResolved += result.stats.resolved;
        for (const [method, count] of Object.entries(result.stats.byMethod)) {
          mergedByMethod[method] = (mergedByMethod[method] || 0) + count;
        }
      }

      return {
        resolved: allResolved,
        unresolved: [],
        stats: {
          total: unresolvedRefs.length,
          resolved: totalResolved,
          unresolved: unresolvedRefs.length - totalResolved,
          byMethod: mergedByMethod,
        },
      };
    } catch (error) {
      logWarn('Parallel resolution failed, falling back to single-threaded', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.resolveAll(unresolvedRefs);
    }
  }

  /**
   * Partition references by file path for worker locality
   */
  private partitionByFile(refs: UnresolvedReference[], count: number): UnresolvedReference[][] {
    const byFile = new Map<string, UnresolvedReference[]>();

    for (const ref of refs) {
      const key = ref.fromNodeId.split(':')[0] || 'unknown';
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(ref);
    }

    const partitions: UnresolvedReference[][] = Array.from({ length: count }, () => []);
    let idx = 0;
    for (const group of byFile.values()) {
      const partition = partitions[idx % count];
      if (partition) partition.push(...group);
      idx++;
    }

    return partitions.filter(p => p.length > 0);
  }

  /**
   * Get detected frameworks
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /**
   * Check if reference is to a built-in or external symbol
   */
  private isBuiltInOrExternal(ref: UnresolvedRef): boolean {
    const name = ref.referenceName;

    // JavaScript/TypeScript built-ins
    const jsBuiltIns = [
      'console', 'window', 'document', 'global', 'process',
      'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
      'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
    ];

    if (jsBuiltIns.includes(name)) {
      return true;
    }

    // Common library calls
    if (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.')) {
      return true;
    }

    // React hooks from React itself
    const reactHooks = ['useState', 'useEffect', 'useContext', 'useReducer', 'useCallback', 'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue'];
    if (reactHooks.includes(name)) {
      return true;
    }

    // Python built-ins
    const pythonBuiltIns = [
      'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
      'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
      'super', 'self', 'cls', 'None', 'True', 'False',
    ];

    if (ref.language === 'python' && pythonBuiltIns.includes(name)) {
      return true;
    }

    return false;
  }

  /**
   * Get file path from node ID
   */
  private getFilePathFromNodeId(nodeId: string): string {
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * Get language from node ID
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    const node = this.queries.getNodeById(nodeId);
    return node?.language || 'unknown';
  }
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
