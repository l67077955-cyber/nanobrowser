/**
 * Find an element from the paths of the shadow hosts above it and its own path, as the DOM tree records
 * them: each path (like div[2]/span, a step counted among siblings of the same tag) starts at the
 * document or at the shadow root of a host above it. Selectors do not reach into shadow roots.
 *
 * Runs in the page (passed to evaluateHandle), so it must not use anything from outside its body.
 */
export function findThroughShadowRoots(paths: string[], doc: ParentNode = document): Element | null {
  const walk = (root: ParentNode, path: string): Element | null => {
    let node: Element | null = null;
    let parent: ParentNode = root;
    for (const step of path.split('/').filter(Boolean)) {
      const match = /^([^[]+)(?:\[(\d+)\])?$/.exec(step);
      if (!match) return null;
      const same = Array.from(parent.children).filter(child => child.nodeName.toLowerCase() === match[1]);
      node = same[(match[2] ? Number(match[2]) : 1) - 1] ?? null;
      if (!node) return null;
      parent = node;
    }
    return node;
  };
  // the deepest root first: a path is tried against the shadow root it most likely starts at
  const roots: ParentNode[] = [doc];
  let node: Element | null = null;
  for (const [i, path] of paths.entries()) {
    node = null;
    for (let r = roots.length - 1; r >= 0 && !node; r--) node = walk(roots[r], path);
    if (!node) return null;
    if (i < paths.length - 1 && node.shadowRoot) roots.push(node.shadowRoot);
  }
  return node;
}
