async function listJenkinsJobs(credentials, fetchJobs) {
  const jobsByUrl = new Map();
  const visited = new Set();
  const visit = async (url, depth = 0, underMultibranch = false) => {
    if (depth > 8 || jobsByUrl.size >= 300) return;
    let visitKey = url;
    try {
      const parsed = new URL(url);
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      parsed.search = '';
      visitKey = parsed.toString();
    } catch { /* Keep the original URL; the Jenkins fetch will report invalid URLs. */ }
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    const data = await fetchJobs(url);
    for (const item of data.jobs || []) {
      if (!item.url) continue;
      const jobClass = String(item._class || '').toLowerCase();
      const isMultibranch = jobClass.includes('multibranch');
      const isFolder = jobClass.includes('folder') || isMultibranch || jobClass.includes('computedfolder');
      if (isMultibranch && item.url) {
        const current = jobsByUrl.get(item.url) || {};
        jobsByUrl.set(item.url, { ...current, name: item.name, url: item.url, color: item.color || '', supportsPullRequests: true });
      }
      // Multibranch jobs are computed folders too: recurse to enumerate PR jobs.
      if (isFolder && item.url) await visit(item.url, depth + 1, underMultibranch || isMultibranch);
      if (!isMultibranch) {
        const properties = Array.isArray(item.properties) ? item.properties : [];
        const branch = properties.find((property) => property && (property.branch || property._class?.includes('BranchJobProperty')))?.branch;
        const head = branch?.head || {};
        const namePullRequestNumber = String(item.name || '').match(/^(?:pr|pull)[-_]?(\d+)$/i)?.[1];
        const pullRequestNumber = Number(head.number ?? head.id ?? namePullRequestNumber);
        const headClass = String(head._class || '').toLowerCase();
        // Some Jenkins controllers omit BranchJobProperty from the jobs API
        // response. GitHub Branch Source still gives PR jobs the stable
        // PR-<number> name, so use it as a scoped fallback.
        const pullRequest = underMultibranch && (headClass.includes('pullrequest') || headClass.includes('prhead')
          || Number.isInteger(pullRequestNumber) && pullRequestNumber > 0 && Boolean(namePullRequestNumber));
        const current = jobsByUrl.get(item.url) || {};
        jobsByUrl.set(item.url, { ...current, name: item.name, url: item.url, color: item.color || '', supportsPullRequests: Boolean(pullRequest || current.supportsPullRequests),
          ...(pullRequest ? { ...(Number.isInteger(pullRequestNumber) && pullRequestNumber > 0 ? { pullRequestNumber } : {}), branchName: typeof head.name === 'string' ? head.name : item.name } : {}) });
      }
    }

    // Multibranch projects can expose branch groups (for example, Change
    // Requests) as Jenkins views whose APIs list children the project API
    // omits. Traverse those views while preserving the multibranch scope.
    for (const view of data.views || []) {
      if (view.url) {
        try { await visit(view.url, depth + 1, underMultibranch); }
        catch { /* An inaccessible optional view must not hide regular jobs. */ }
      }
    }
  };
  await visit(credentials.url);
  return [...jobsByUrl.values()];
}

module.exports = { listJenkinsJobs };
