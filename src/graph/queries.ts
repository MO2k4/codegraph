/**
 * Graph Query Functions
 *
 * Higher-level query functions built on top of traversal algorithms.
 */

import picomatch from 'picomatch';
import { Node, Edge, Context, Subgraph, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from './traversal';

/**
 * Graph query manager for complex queries
 */
export class GraphQueryManager {
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
    this.traverser = new GraphTraverser(queries);
  }

  /**
   * Get full context for a node
   *
   * Returns the focal node along with its ancestors, children,
   * and both incoming and outgoing references.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    const focal = this.queries.getNodeById(nodeId);

    if (!focal) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // Get ancestors (containment hierarchy)
    const ancestors = this.traverser.getAncestors(nodeId);

    // Get children
    const children = this.traverser.getChildren(nodeId);

    // Get all edge sets
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);

    const typeEdgeKinds: EdgeKind[] = ['type_of', 'returns'];
    const typeEdges: Edge[] = [];
    for (const kind of typeEdgeKinds) {
      typeEdges.push(...this.queries.getOutgoingEdges(nodeId, [kind]));
    }

    const fileNode = ancestors.find((a) => a.kind === 'file');
    const importEdges = fileNode
      ? this.queries.getOutgoingEdges(fileNode.id, ['imports'])
      : [];

    // Collect all needed node IDs and batch-fetch them in one query
    const allIds = new Set<string>();
    for (const edge of incomingEdges) {
      if (edge.kind !== 'contains') {
        allIds.add(edge.source);
      }
    }
    for (const edge of outgoingEdges) {
      if (edge.kind !== 'contains') {
        allIds.add(edge.target);
      }
    }
    for (const edge of typeEdges) {
      allIds.add(edge.target);
    }
    for (const edge of importEdges) {
      allIds.add(edge.target);
    }

    const nodeMap = this.queries.getNodesByIds(Array.from(allIds));

    // Build incoming references from the batch-fetched map
    const incomingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of incomingEdges) {
      if (edge.kind === 'contains') {
        continue;
      }
      const node = nodeMap.get(edge.source);
      if (node) {
        incomingRefs.push({ node, edge });
      }
    }

    // Build outgoing references from the batch-fetched map
    const outgoingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of outgoingEdges) {
      if (edge.kind === 'contains') {
        continue;
      }
      const node = nodeMap.get(edge.target);
      if (node) {
        outgoingRefs.push({ node, edge });
      }
    }

    // Build type information from the batch-fetched map
    const types: Node[] = [];
    const seenTypeIds = new Set<string>();
    for (const edge of typeEdges) {
      const typeNode = nodeMap.get(edge.target);
      if (typeNode && !seenTypeIds.has(typeNode.id)) {
        seenTypeIds.add(typeNode.id);
        types.push(typeNode);
      }
    }

    // Build relevant imports from the batch-fetched map
    const imports: Node[] = [];
    for (const edge of importEdges) {
      const importNode = nodeMap.get(edge.target);
      if (importNode) {
        imports.push(importNode);
      }
    }

    return {
      focal,
      ancestors,
      children,
      incomingRefs,
      outgoingRefs,
      types,
      imports,
    };
  }

  /**
   * Get dependencies of a file
   *
   * Returns all files that this file imports from.
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    const nodes = this.queries.getNodesByFile(filePath);
    const fileNode = nodes.find((n) => n.kind === 'file');

    if (!fileNode) {
      return [];
    }

    const importEdges = this.queries.getOutgoingEdges(fileNode.id, ['imports']);
    const targetIds = importEdges.map((edge) => edge.target);
    const targetNodes = this.queries.getNodesByIds(targetIds);

    const dependencies = new Set<string>();
    for (const edge of importEdges) {
      const targetNode = targetNodes.get(edge.target);
      if (targetNode && targetNode.filePath !== filePath) {
        dependencies.add(targetNode.filePath);
      }
    }

    return Array.from(dependencies);
  }

  /**
   * Get dependents of a file
   *
   * Returns all files that import from this file.
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    const nodes = this.queries.getNodesByFile(filePath);
    const dependents = new Set<string>();

    // Collect all source IDs from incoming import edges on exported symbols
    const allSourceIds: string[] = [];
    const allIncomingEdges: Edge[] = [];
    for (const node of nodes) {
      if (node.isExported) {
        const incomingEdges = this.queries.getIncomingEdges(node.id, ['imports']);
        for (const edge of incomingEdges) {
          allSourceIds.push(edge.source);
          allIncomingEdges.push(edge);
        }
      }
    }

    // Batch-fetch all source nodes
    const sourceNodes = this.queries.getNodesByIds(allSourceIds);
    for (const edge of allIncomingEdges) {
      const sourceNode = sourceNodes.get(edge.source);
      if (sourceNode && sourceNode.filePath !== filePath) {
        dependents.add(sourceNode.filePath);
      }
    }

    return Array.from(dependents);
  }

  /**
   * Get all symbols exported by a file
   *
   * @param filePath - Path to the file
   * @returns Array of exported nodes
   */
  getExportedSymbols(filePath: string): Node[] {
    const nodes = this.queries.getNodesByFile(filePath);
    return nodes.filter((n) => n.isExported);
  }

  /**
   * Find symbols by qualified name pattern
   *
   * @param pattern - Pattern to match (supports * wildcard)
   * @returns Array of matching nodes
   */
  findByQualifiedName(pattern: string): Node[] {
    // Use picomatch for safe glob matching (avoids ReDoS from regex construction)
    const isMatch = picomatch(pattern, { dot: true });

    // This is inefficient for large graphs - would need FTS index on qualified_name
    // For now, use kind-based filtering if possible
    const allNodes: Node[] = [];
    const kinds: Node['kind'][] = [
      'class',
      'function',
      'method',
      'interface',
      'type_alias',
      'variable',
      'constant',
    ];

    for (const kind of kinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        if (isMatch(node.qualifiedName)) {
          allNodes.push(node);
        }
      }
    }

    return allNodes;
  }

  /**
   * Get the module/package structure
   *
   * Returns a tree structure of files organized by directory.
   *
   * @returns Map of directory paths to contained files
   */
  getModuleStructure(): Map<string, string[]> {
    const files = this.queries.getAllFiles();
    const structure = new Map<string, string[]>();

    for (const file of files) {
      const parts = file.path.split('/');
      const dir = parts.slice(0, -1).join('/') || '.';

      if (!structure.has(dir)) {
        structure.set(dir, []);
      }
      structure.get(dir)!.push(file.path);
    }

    return structure;
  }

  /**
   * Find circular dependencies in the graph
   *
   * @returns Array of cycles, each cycle is an array of node IDs
   */
  findCircularDependencies(): string[][] {
    const files = this.queries.getAllFiles();
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    // Memoize getFileDependencies results to avoid re-querying
    const depsCache = new Map<string, string[]>();
    const getCachedDeps = (fp: string): string[] => {
      let deps = depsCache.get(fp);
      if (deps === undefined) {
        deps = this.getFileDependencies(fp);
        depsCache.set(fp, deps);
      }
      return deps;
    };

    // Use mutable array + Set for O(1) cycle detection with push/pop
    const path: string[] = [];
    const pathSet = new Set<string>();

    const dfs = (filePath: string): void => {
      if (pathSet.has(filePath)) {
        // Found a cycle - use array to extract the cycle path
        const cycleStart = path.indexOf(filePath);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
        return;
      }

      if (visited.has(filePath)) {
        return;
      }

      visited.add(filePath);
      recursionStack.add(filePath);
      path.push(filePath);
      pathSet.add(filePath);

      const dependencies = getCachedDeps(filePath);
      for (const dep of dependencies) {
        dfs(dep);
      }

      path.pop();
      pathSet.delete(filePath);
      recursionStack.delete(filePath);
    };

    for (const file of files) {
      if (!visited.has(file.path)) {
        dfs(file.path);
      }
    }

    return cycles;
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);

    // Use kind-filtered queries to avoid loading unnecessary edges
    const callEdges = this.queries.getOutgoingEdges(nodeId, ['calls']);
    const callerEdges = this.queries.getIncomingEdges(nodeId, ['calls']);
    const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);

    const ancestors = this.traverser.getAncestors(nodeId);

    return {
      incomingEdgeCount: incomingEdges.length,
      outgoingEdgeCount: outgoingEdges.length,
      callCount: callEdges.length,
      callerCount: callerEdges.length,
      childCount: containsEdges.length,
      depth: ancestors.length,
    };
  }

  /**
   * Find dead code (nodes with no incoming references)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    const targetKinds = kinds || ['function', 'method', 'class'];
    const deadCode: Node[] = [];

    for (const kind of targetKinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        // Skip exported symbols (they may be used externally)
        if (node.isExported) {
          continue;
        }

        const incomingEdges = this.queries.getIncomingEdges(node.id);

        // Filter out containment edges
        const references = incomingEdges.filter((e) => e.kind !== 'contains');

        if (references.length === 0) {
          deadCode.push(node);
        }
      }
    }

    return deadCode;
  }

  /**
   * Get subgraph containing nodes matching a filter
   *
   * @param filter - Filter function to select nodes
   * @param includeEdges - Whether to include edges between matching nodes
   * @returns Subgraph containing matching nodes
   */
  getFilteredSubgraph(
    filter: (node: Node) => boolean,
    includeEdges: boolean = true
  ): Subgraph {
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // Get all nodes of common kinds in a single batch query
    const kinds: Node['kind'][] = [
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'function',
      'method',
      'variable',
      'constant',
      'enum',
      'type_alias',
    ];

    const allKindNodes = this.queries.getNodesByKinds(kinds);
    for (const node of allKindNodes) {
      if (filter(node)) {
        nodes.set(node.id, node);
      }
    }

    // Include edges between matching nodes
    if (includeEdges) {
      for (const nodeId of nodes.keys()) {
        const outgoing = this.queries.getOutgoingEdges(nodeId);
        for (const edge of outgoing) {
          if (nodes.has(edge.target)) {
            edges.push(edge);
          }
        }
      }
    }

    return {
      nodes,
      edges,
      roots: [],
    };
  }

  /**
   * Access the underlying traverser for direct traversal operations
   */
  getTraverser(): GraphTraverser {
    return this.traverser;
  }
}
