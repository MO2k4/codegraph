/**
 * Grammar Loading and Caching
 *
 * Manages tree-sitter language grammars with lazy loading.
 */

import Parser from 'tree-sitter';
import { Language } from '../types';

/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Lazy loader functions for each grammar
 */
const grammarLoaders: Record<string, () => unknown> = {
  typescript: () => require('tree-sitter-typescript').typescript,
  tsx: () => require('tree-sitter-typescript').tsx,
  javascript: () => require('tree-sitter-javascript'),
  jsx: () => require('tree-sitter-javascript'), // JSX uses the JavaScript grammar
  python: () => require('tree-sitter-python'),
  go: () => require('tree-sitter-go'),
  rust: () => require('tree-sitter-rust'),
  java: () => require('tree-sitter-java'),
  c: () => require('tree-sitter-c'),
  cpp: () => require('tree-sitter-cpp'),
  csharp: () => require('tree-sitter-c-sharp'),
  php: () => require('tree-sitter-php').php,
  ruby: () => require('tree-sitter-ruby'),
  swift: () => require('tree-sitter-swift'),
  kotlin: () => require('tree-sitter-kotlin'),
  // liquid: uses custom regex-based extraction, not tree-sitter
};

/**
 * Cache for loaded grammars (including null for failed loads)
 */
const grammarCache = new Map<string, unknown | null>();

/**
 * Errors encountered during grammar loading
 */
const grammarErrors = new Map<string, Error>();

/**
 * Get a grammar by language, loading it lazily if needed
 */
export function getGrammar(language: string): unknown | null {
  if (grammarCache.has(language)) {
    return grammarCache.get(language) ?? null;
  }

  const loader = grammarLoaders[language];
  if (!loader) {
    return null;
  }

  try {
    const grammar = loader();
    grammarCache.set(language, grammar);
    return grammar;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    grammarErrors.set(language, error);
    grammarCache.set(language, null);
    return null;
  }
}

/**
 * Get errors from failed grammar loads
 */
export function getUnavailableGrammarErrors(): Map<string, Error> {
  return new Map(grammarErrors);
}

/**
 * File extension to Language mapping
 */
export const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c', // Could also be C++, defaulting to C
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.liquid': 'liquid',
};

/**
 * Cache for initialized parsers
 */
const parserCache = new Map<Language, Parser>();

/**
 * Get a parser for the specified language
 */
export function getParser(language: Language): Parser | null {
  // Check cache first
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  // Get grammar for language (lazy load)
  const grammar = getGrammar(language);
  if (!grammar) {
    return null;
  }

  // Create and cache parser
  const parser = new Parser();
  parser.setLanguage(grammar as Parameters<typeof parser.setLanguage>[0]);
  parserCache.set(language, parser);

  return parser;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): Language {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_MAP[ext] || 'unknown';
}

/**
 * Check if a language is supported
 */
export function isLanguageSupported(language: Language): boolean {
  // Liquid uses custom regex-based extraction, not tree-sitter
  if (language === 'liquid') return true;
  return language !== 'unknown' && language in grammarLoaders;
}

/**
 * Get all supported languages
 */
export function getSupportedLanguages(): Language[] {
  const languages = Object.keys(grammarLoaders) as Language[];
  // Add Liquid which uses custom extraction
  languages.push('liquid');
  return languages;
}

/**
 * Clear the parser cache (useful for testing)
 */
export function clearParserCache(): void {
  parserCache.clear();
}

/**
 * Get language display name
 */
export function getLanguageDisplayName(language: Language): string {
  const names: Record<Language, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    tsx: 'TypeScript (TSX)',
    jsx: 'JavaScript (JSX)',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    php: 'PHP',
    ruby: 'Ruby',
    swift: 'Swift',
    kotlin: 'Kotlin',
    liquid: 'Liquid',
    unknown: 'Unknown',
  };
  return names[language] || language;
}
