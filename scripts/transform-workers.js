/**
 * Web Worker Inline Loader for Webpack
 *
 * This loader transforms web worker imports into inline Blob-based workers.
 * It detects patterns like:
 *   new Worker(new URL('./worker.js', import.meta.url))
 *
 * And transforms them to:
 *   (function() {
 *     const __workerCode = `[bundled worker code]`;
 *     const blob = new Blob([__workerCode], { type: 'application/javascript' });
 *     const url = URL.createObjectURL(blob);
 *     const worker = new Worker(url);
 *     URL.revokeObjectURL(url);
 *     return worker;
 *   })()
 *
 * This allows workers to be bundled into a single file for CDN deployment.
 *
 * Architecture Notes for LLMs:
 *   - This runs at BUILD TIME as a webpack loader, not at runtime.
 *   - It reads the worker source file from disk, escapes it for embedding
 *     in a template literal, and replaces the Worker constructor call.
 *   - Because it reads from disk, it must call this.addDependency() so
 *     webpack knows to recompile when the worker file changes.
 *   - The worker code is NOT processed by swc-loader or other loaders
 *     in this pipeline; it is inlined as raw source text.
 *
 * @module worker-inline-loader
 */

import fs from 'fs';
import path from 'path';

/**
 * Webpack loader function
 * 
 * @param {string} source - The source code of the file being processed
 * @returns {string} Transformed source code
 */
/**
 * Check if a given index in source code is inside a JavaScript comment.
 *
 * This handles both block comments (slash-asterisk ... asterisk-slash)
 * and line comments (slash-slash ... newline).
 *
 * @param {string} source - The source code string
 * @param {number} index - The character index to check
 * @returns {boolean} True if the index is inside a comment
 */
function isInsideComment(source, index) {
  // Check for line comments: // on the same line before index
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const lineSlice = source.slice(lineStart, index);
  if (lineSlice.includes('//')) {
    return true;
  }

  // Check for block comments: /* before index without matching */ after /*
  let blockStart = source.lastIndexOf('/*', index);
  if (blockStart !== -1) {
    const blockEnd = source.indexOf('*/', blockStart);
    // If there's no closing */ or it comes after our index, we're inside a block comment
    if (blockEnd === -1 || blockEnd > index) {
      return true;
    }
  }

  return false;
}

export default function workerInlineLoader(source) {
  const callback = this.async();
  const resourcePath = this.resourcePath;
  const resourceDir = path.dirname(resourcePath);

  // Match new Worker(new URL(...)) patterns
  const workerRegex = /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)\s*\)/g;

  let matches = [];
  let match;
  while ((match = workerRegex.exec(source)) !== null) {
    // Skip matches that are inside comments (e.g., documentation examples)
    if (isInsideComment(source, match.index)) {
      continue;
    }
    matches.push({
      full: match[0],
      workerPath: match[1],
      index: match.index
    });
  }

  if (matches.length === 0) {
    callback(null, source);
    return;
  }
  
  // Process all worker imports
  Promise.all(
    matches.map(async ({ workerPath }) => {
      const resolvedPath = path.resolve(resourceDir, workerPath);
      
      // Add the worker file as a dependency so webpack watches it
      this.addDependency(resolvedPath);
      
      try {
        const workerCode = fs.readFileSync(resolvedPath, 'utf-8');
        return { workerPath, workerCode, resolvedPath };
      } catch (error) {
        this.emitError(new Error(`Failed to read worker file: ${resolvedPath}`));
        return null;
      }
    })
  ).then((workerData) => {
    let transformedSource = source;
    
    // Replace each worker import with inline code
    matches.forEach(({ full, workerPath }, index) => {
      const data = workerData[index];
      if (!data || !data.workerCode) return;
      
      // Escape backticks and backslashes in worker code
      const escapedCode = data.workerCode
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
      
      // Generate the inline worker creation
      const inlineWorker = `(function() {
  const __workerCode = \`${escapedCode}\`;
  const blob = new Blob([__workerCode], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
})()`;
      
      transformedSource = transformedSource.replace(full, inlineWorker);
    });
    
    callback(null, transformedSource);
  }).catch((error) => {
    callback(error);
  });
}
