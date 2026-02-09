/**
 * SCIP (Source Code Intelligence Protocol) Importer
 *
 * Imports semantic data from SCIP index files to enhance the code graph
 * with precise cross-reference information.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { QueryBuilder } from '../db/queries';
import { Edge, Node } from '../types';
import { logDebug, logWarn } from '../errors';
import { isPathWithinRoot } from '../utils';

interface SCIPDocument {
  relativePath: string;
  occurrences?: SCIPOccurrence[];
  symbols?: SCIPSymbolInfo[];
}

interface SCIPOccurrence {
  range: number[]; // [startLine, startChar, endLine, endChar] or [startLine, startChar, endChar]
  symbol?: string;
  symbolRoles?: number;
}

interface SCIPSymbolInfo {
  symbol: string;
  documentation?: string[];
}

// SCIP role flags
const SCIP_ROLE_DEFINITION = 1;

export class ScipImporter {
  private projectRoot: string;
  private queries: QueryBuilder;
  private symbolDefinitions: Map<string, Set<string>> = new Map();

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;
  }

  /**
   * Parse a SCIP JSON file
   */
  parseSCIPFile(filePath: string): SCIPDocument[] {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);

    // Ensure the SCIP file is within the project root to prevent arbitrary file reads
    if (!isPathWithinRoot(fullPath, this.projectRoot)) {
      throw new Error('SCIP file path is outside the project root');
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error('SCIP file not found');
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const data = JSON.parse(content);

    // Handle both {documents:[...]} and raw array shapes
    if (Array.isArray(data)) {
      return data as SCIPDocument[];
    }
    if (data.documents && Array.isArray(data.documents)) {
      return data.documents;
    }

    throw new Error(
      'Invalid SCIP format: expected {documents:[...]} or array of documents'
    );
  }

  /**
   * Build symbol->definition-files mapping
   */
  buildSymbolDefinitions(documents: SCIPDocument[]): Map<string, Set<string>> {
    const defs = new Map<string, Set<string>>();

    for (const doc of documents) {
      if (!doc.occurrences) continue;

      for (const occ of doc.occurrences) {
        if (!occ.symbol) continue;

        const isDefinition = (occ.symbolRoles ?? 0) & SCIP_ROLE_DEFINITION;
        if (isDefinition) {
          if (!defs.has(occ.symbol)) {
            defs.set(occ.symbol, new Set());
          }
          defs.get(occ.symbol)!.add(doc.relativePath);
        }
      }
    }

    return defs;
  }

  /**
   * Import SCIP data into the code graph
   * Two-pass: definitions first, then references
   */
  importSCIP(scipFilePath: string): {
    edgesCreated: number;
    documentsProcessed: number;
  } {
    const documents = this.parseSCIPFile(scipFilePath);

    // Compute content hash for fingerprint skip
    const fullPath = path.isAbsolute(scipFilePath)
      ? scipFilePath
      : path.join(this.projectRoot, scipFilePath);

    // Path validation already performed by parseSCIPFile above
    const contentHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(fullPath))
      .digest('hex');

    // Check if already imported (idempotent)
    const lastHash = this.queries.getMetadata('scip_last_hash');
    if (lastHash === contentHash) {
      logDebug('SCIP file unchanged, skipping import', { scipFilePath });
      return { edgesCreated: 0, documentsProcessed: 0 };
    }

    // Pass 1: Build symbol definitions
    this.symbolDefinitions = this.buildSymbolDefinitions(documents);

    // Pass 2: Create edges from references to definitions
    let edgesCreated = 0;
    let documentsProcessed = 0;

    for (const doc of documents) {
      if (!doc.occurrences) continue;

      // Validate path
      if (!isPathWithinRoot(doc.relativePath, this.projectRoot)) {
        logWarn('SCIP document path outside project root', {
          path: doc.relativePath,
        });
        continue;
      }

      documentsProcessed++;
      const edges: Edge[] = [];

      for (const occ of doc.occurrences) {
        if (!occ.symbol) continue;

        const isDefinition = (occ.symbolRoles ?? 0) & SCIP_ROLE_DEFINITION;
        if (isDefinition) continue;

        // Find definition locations for this symbol
        const defFiles = this.symbolDefinitions.get(occ.symbol);
        if (!defFiles) continue;

        const line = occ.range[0] ?? 0;

        // Find source node (in current file at this line)
        const sourceNodes = this.queries.getNodesByFile(doc.relativePath);
        const sourceNode = this.findBestSourceNode(sourceNodes, line);
        if (!sourceNode) continue;

        // Find target node (in definition files)
        for (const defFile of defFiles) {
          if (defFile === doc.relativePath) continue;

          const targetNodes = this.queries.getNodesByFile(defFile);
          const symbolName = this.extractSymbolName(occ.symbol);
          const targetNode = targetNodes.find((n) => n.name === symbolName);
          if (!targetNode) continue;

          edges.push({
            source: sourceNode.id,
            target: targetNode.id,
            kind: 'references',
            line,
            column: occ.range[1],
            metadata: {
              confidence: 1.0,
              resolvedBy: 'scip',
            },
            provenance: 'scip',
          });
        }
      }

      if (edges.length > 0) {
        this.queries.insertEdges(edges);
        edgesCreated += edges.length;
      }
    }

    // Record import fingerprint
    this.queries.setMetadata('scip_last_hash', contentHash);
    this.queries.setMetadata('scip_last_imported_at', new Date().toISOString());
    this.queries.setMetadata('scip_edges_created', String(edgesCreated));

    return { edgesCreated, documentsProcessed };
  }

  /**
   * Find best source node for a given line
   */
  private findBestSourceNode(nodes: Node[], line: number): Node | null {
    let best: Node | null = null;
    let bestDistance = Infinity;

    for (const node of nodes) {
      if (node.startLine === undefined) continue;
      const distance = Math.abs(node.startLine - line);

      if (node.startLine <= line && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }

    if (!best) {
      for (const node of nodes) {
        if (node.startLine === undefined) continue;
        const distance = Math.abs(node.startLine - line);
        if (distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
    }

    return best;
  }

  /**
   * Extract human-readable name from SCIP symbol string
   * SCIP symbols look like: "package manager class#method()."
   */
  private extractSymbolName(symbol: string): string {
    const cleaned = symbol.replace(/[().#]+$/, '');
    const parts = cleaned.split(/[.\s#/]+/);
    return parts[parts.length - 1] || symbol;
  }

  /**
   * Auto-detect SCIP files in common locations
   */
  static findSCIPFiles(projectRoot: string): string[] {
    const candidates = [
      'index.scip',
      'index.scip.json',
      'dump.scip',
      'dump.scip.json',
      'build/index.scip',
      'build/index.scip.json',
      'target/index.scip',
      'target/index.scip.json',
    ];

    const found: string[] = [];
    for (const candidate of candidates) {
      const fullPath = path.join(projectRoot, candidate);
      if (fs.existsSync(fullPath)) {
        found.push(candidate);
      }
    }

    return found;
  }
}
