async function listJenkinsJobs(credentials, fetchJobs) {
  const jobs = [];
  const visit = async (url, depth = 0, underMultibranch = false) => {
    if (depth > 8 || jobs.length >= 300) return;
    const data = await fetchJobs(url);
    for (const item of data.jobs || []) {
      const jobClass = String(item._class || '').toLowerCase();
      const isMultibranch = jobClass.includes('multibranch');
      const isFolder = jobClass.includes('folder') || isMultibranch || jobClass.includes('computedfolder');
      if (isMultibranch && item.url) jobs.push({ name: item.name, url: item.url, color: item.color || '', supportsPullRequests: true });
      // Multibranch jobs are computed folders too: recurse to enumerate PR jobs.
      if (isFolder && item.url) await visit(item.url, depth + 1, underMultibranch || isMultibranch);
      if (!isMultibranch) {
        const properties = Array.isArray(item.properties) ? item.properties : [];
        const branch = properties.find((property) => property && (property.branch || property._class?.includes('BranchJobProperty')))?.branch;
        const head = branch?.head || {};
        const pullRequestNumber = Number(head.number ?? head.id);
        const headClass = String(head._class || '').toLowerCase();
        const pullRequest = underMultibranch && (headClass.includes('pullrequest') || headClass.includes('prhead'));
        jobs.push({ name: item.name, url: item.url, color: item.color || '', supportsPullRequests: Boolean(pullRequest),
          ...(pullRequest ? { ...(Number.isInteger(pullRequestNumber) && pullRequestNumber > 0 ? { pullRequestNumber } : {}), branchName: typeof head.name === 'string' ? head.name : undefined } : {}) });
      }
    }
  };
  await visit(credentials.url);
  return jobs;
}

module.exports = { listJenkinsJobs };
