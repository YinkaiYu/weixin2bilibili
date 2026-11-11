/** Match saved-page image resources without guessing between duplicate filenames. */
function normalizedPath(value, decode) {
  if (typeof value !== 'string' || !value || /^[a-z][a-z\d+.-]*:/i.test(value)) return '';
  let path = value;
  if (decode) {
    path = path.split(/[?#]/,1)[0];
    try { path = decodeURIComponent(path); } catch { return ''; }
  }
  path = path.replace(/\\/g,'/');
  if (path.startsWith('/') || /[\u0000-\u001f\u007f]/.test(path)) return '';
  const parts = path.split('/').filter(part => part !== '.' && part !== '');
  if (!parts.length || parts.includes('..') || parts.some(part=>part.includes(':'))) return '';
  return parts.join('/');
}

/** Normalize an HTML relative URL or the parser's inert localasset:/// placeholder. */
export function normalizeURI(reference) {
  if (typeof reference !== 'string') return '';
  if (reference.startsWith('localasset:///')) {
    try { return normalizedPath(decodeURIComponent(reference.slice(14)),false); } catch { return ''; }
  }
  return normalizedPath(reference,true);
}

/** Index exact relative paths and only unambiguous basenames. Never overwrite a collision. */
export function indexLocalFiles(files) {
  const buckets = new Map();
  const add = (key,file) => {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key,new Set());
    buckets.get(key).add(file);
  };
  for (const file of files || []) {
    const relative = normalizedPath(file.webkitRelativePath || file.name,false);
    const basename = normalizedPath(file.name,false);
    add(relative,file); add(basename,file);
  }
  return new Map([...buckets].filter(([,values])=>values.size===1).map(([key,values])=>[key,values.values().next().value]));
}

/** Resolve exact paths first, then unique suffixes, then unique filename-only imports. */
export function resolveLocalFile(reference, files) {
  if (!(files instanceof Map)) return undefined;
  const path = normalizeURI(reference);
  if (!path) return undefined;
  if (path.includes('/') && files.has(path)) return files.get(path);
  const suffixMatches = new Set();
  for (const [key,file] of files) {
    const normalized = normalizedPath(key,false);
    if (normalized && (normalized===path || normalized.endsWith('/'+path))) suffixMatches.add(file);
  }
  if (suffixMatches.size) return suffixMatches.size===1 ? suffixMatches.values().next().value : undefined;
  const basename = path.split('/').at(-1);
  const matches = new Set();
  for (const [key,file] of files) {
    // A known, different folder is evidence of a mismatch, even with one basename.
    if (path.includes('/') && file?.webkitRelativePath) continue;
    const normalized = normalizedPath(key,false);
    if (normalized?.split('/').at(-1)===basename || file?.name===basename) matches.add(file);
  }
  return matches.size===1 ? matches.values().next().value : undefined;
}
