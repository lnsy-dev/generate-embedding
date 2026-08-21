/**
 * Main Entry Point
 *
 * Imports the global CSS and the <generate-embedding> custom element.
 */

import './index.css';
import './src/generate-embedding.js';

// Expose the embeddings client for debugging and e2e assertions (e.g.
// window.embeddings.getActiveWorkerCount()).
import * as embeddings from './src/lib/embeddings.js';
window.embeddings = embeddings;
